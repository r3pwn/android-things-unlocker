/**
 * Pure protocol logic for the Android Things authenticated AVB unlock
 * challenge-response — the credential side of
 * [`at_auth_unlock.py`](https://android.googlesource.com/platform/external/avb/+/master/tools/at_auth_unlock.py)
 * (avb repo, `tools/`). The fastboot interaction (staging the
 * credential, `at-unlock-vboot`) stays on the client side, matching the
 * reference tool's split.
 *
 * The PUK private key is the only secret: it produces the signature
 * locally and never leaves this module, so a response (public
 * certificates + a signature valid only for its specific challenge) is
 * safe to return to a client.
 */
import { createPrivateKey, createSign } from "node:crypto";
import type { KeyObject } from "node:crypto";

/** Size of the `AvbCertUnlockChallenge` struct returned by
 * `fastboot oem at-get-vboot-unlock-challenge`. */
export const CHALLENGE_STRUCT_SIZE = 52;

/** SHA-256 hash of the product ID (32 bytes). */
export const PRODUCT_ID_HASH_SIZE = 32;

/** Random 16-byte challenge data. */
export const CHALLENGE_DATA_SIZE = 16;

/** Size of an `AvbCertCertificate` struct (both PIK and PUK certs). */
export const CERT_SIZE = 1620;

// Inside `AvbCertCertificate`, the subject (SHA-256 of the product ID the
// PUK cert is valid for) sits after the format version and public key.
// Mirrors `GetCertCertificateSubject` in at_auth_unlock.py.
const CERT_SUBJECT_OFFSET = 4 + 1032;

/** `AvbCertUnlockCredential` format version written into the output struct. */
export const CREDENTIAL_FORMAT_VERSION = 1;

export interface UnlockChallenge {
  version: number;
  /** 32-byte SHA-256 hash of the device's product ID. */
  productIdHash: Buffer;
  /** 16-byte random challenge data. */
  challengeData: Buffer;
}

export interface UnlockCredentialSet {
  /** Device codename (e.g. "amber"), derived from the bundle name. */
  name: string;
  /** PIK certificate (`AvbCertCertificate`, 1620 bytes). */
  intermediateCert: Buffer;
  /** PUK certificate (`AvbCertCertificate`, 1620 bytes). */
  unlockCert: Buffer;
  /** PUK private key — the only secret; never returned to clients. */
  privateKey: KeyObject;
  /** Derived from the PUK cert subject; used to match the challenge. */
  productIdHash: Buffer;
}

export class UnlockError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "UnlockError";
  }
}

/**
 * Parses the 52-byte `AvbCertUnlockChallenge` struct:
 * `struct.unpack('<I 32s 16s')` in the reference tool.
 */
export function parseUnlockChallenge(data: Buffer): UnlockChallenge {
  if (data.length !== CHALLENGE_STRUCT_SIZE) {
    throw new UnlockError(
      `unlock_challenge must be ${CHALLENGE_STRUCT_SIZE} bytes ` +
        `(the full AvbCertUnlockChallenge struct), got ${data.length} bytes`,
      400,
      "BAD_CHALLENGE",
    );
  }
  return {
    version: data.readUInt32LE(0),
    productIdHash: Buffer.from(
      data.subarray(4, 4 + PRODUCT_ID_HASH_SIZE),
    ),
    challengeData: Buffer.from(
      data.subarray(4 + PRODUCT_ID_HASH_SIZE, CHALLENGE_STRUCT_SIZE),
    ),
  };
}

/**
 * Reads the 32-byte subject field from an `AvbCertCertificate` struct.
 * For the PUK certificate this is the SHA-256 hash of the product ID it
 * can be used to unlock. Mirrors `GetCertCertificateSubject`.
 */
export function certSubject(cert: Buffer): Buffer {
  if (cert.length !== CERT_SIZE) {
    throw new UnlockError(
      `certificate must be exactly ${CERT_SIZE} bytes, got ${cert.length}`,
      500,
      "BAD_CREDENTIAL",
    );
  }
  return Buffer.from(
    cert.subarray(CERT_SUBJECT_OFFSET, CERT_SUBJECT_OFFSET + PRODUCT_ID_HASH_SIZE),
  );
}

/**
 * Validates a credential set (fail at load time, not request time) and
 * derives its product ID hash from the PUK certificate; a non-private
 * key is rejected, mirroring the `UnlockCredentials` constructor checks.
 */
export function createCredentialSet(
  name: string,
  intermediateCert: Buffer,
  unlockCert: Buffer,
  privateKeyPem: string,
): UnlockCredentialSet {
  if (intermediateCert.length !== CERT_SIZE) {
    throw new UnlockError(
      `${name}: PIK certificate must be ${CERT_SIZE} bytes, ` +
        `got ${intermediateCert.length}`,
      500,
      "BAD_CREDENTIAL",
    );
  }
  let privateKey: KeyObject;
  try {
    // Accepts PKCS#1 ("RSA PRIVATE KEY") and PKCS#8 ("PRIVATE KEY") PEM,
    // the same formats PyCrypto's RSA.importKey handles. Throws if the key
    // is not a private key (mirrors the has_private() check).
    privateKey = createPrivateKey(privateKeyPem);
  } catch (e) {
    throw new UnlockError(
      `${name}: PUK private key is not a valid RSA private key PEM: ` +
        `${e instanceof Error ? e.message : String(e)}`,
      500,
      "BAD_CREDENTIAL",
    );
  }
  return {
    name,
    intermediateCert,
    unlockCert,
    privateKey,
    productIdHash: certSubject(unlockCert),
  };
}

/**
 * Builds the `AvbCertUnlockCredential` struct, mirroring
 * `MakeCertUnlockCredential`:
 *   struct.pack('<I', 1) + intermediate_cert (1620 B) + unlock_cert
 *   (1620 B) + PKCS#1 v1.5 signature over SHA-512(challenge_data)
 *
 * `crypto.createSign('sha512')` is the exact equivalent of the
 * reference tool's `PKCS1_v1_5.new(rsa_key).sign(SHA512.new(...))`
 * (SHA-512 hashing + PKCS#1 v1.5 padding, including the DigestInfo
 * prefix).
 */
export function makeUnlockCredential(
  set: UnlockCredentialSet,
  challenge: UnlockChallenge,
): { credential: Buffer; signature: Buffer } {
  const signature = createSign("sha512")
    .update(challenge.challengeData)
    .sign(set.privateKey);

  const version = Buffer.alloc(4);
  version.writeUInt32LE(CREDENTIAL_FORMAT_VERSION, 0);

  const credential = Buffer.concat([
    version,
    set.intermediateCert,
    set.unlockCert,
    signature,
  ]);
  return { credential, signature };
}

/**
 * Finds the first credential set whose PUK certificate subject matches the
 * challenge's product ID hash, mirroring
 * `SelectMatchingUnlockCredential`.
 */
export function selectMatchingCredentialSet(
  sets: UnlockCredentialSet[],
  challenge: UnlockChallenge,
): UnlockCredentialSet | undefined {
  return sets.find((set) => set.productIdHash.equals(challenge.productIdHash));
}
