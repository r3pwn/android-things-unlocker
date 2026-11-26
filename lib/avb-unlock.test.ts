import { beforeAll, describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  CERT_SIZE,
  CHALLENGE_STRUCT_SIZE,
  UnlockError,
  certSubject,
  createCredentialSet,
  makeUnlockCredential,
  parseUnlockChallenge,
  selectMatchingCredentialSet,
  type UnlockChallenge,
  type UnlockCredentialSet,
} from "./avb-unlock";

// The PUK cert subject sits after the format version + public key
// (offset 4 + 1032), per GetCertCertificateSubject in at_auth_unlock.py.
const CERT_SUBJECT_OFFSET = 4 + 1032;

function fakeCert(subject: Buffer): Buffer {
  const cert = Buffer.alloc(CERT_SIZE, 0xab);
  subject.copy(cert, CERT_SUBJECT_OFFSET);
  return cert;
}

function throwsUnlockError(fn: () => unknown): UnlockError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UnlockError);
    return e as UnlockError;
  }
  throw new Error("expected an UnlockError");
}

function fakeChallenge(
  productIdHash: Buffer,
  challengeData?: Buffer,
): UnlockChallenge {
  return {
    version: 1,
    productIdHash,
    challengeData: challengeData ?? Buffer.alloc(16, 0x5a),
  };
}

// A 2048-bit key, so the PKCS#1 v1.5 signature is 256 bytes.
let pkcs1Pem: string;
let pkcs8Pem: string;
let publicPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  pkcs1Pem = pair.privateKey.export({
    type: "pkcs1",
    format: "pem",
  }) as string;
  pkcs8Pem = pair.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  publicPem = pair.publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
});

describe("parseUnlockChallenge", () => {
  it("parses the 52-byte struct fields (u32 LE + 32s + 16s)", () => {
    const productIdHash = Buffer.alloc(32, 0x11);
    const challengeData = Buffer.alloc(16, 0x22);
    const raw = Buffer.concat([
      Buffer.from([1, 0, 0, 0]),
      productIdHash,
      challengeData,
    ]);
    expect(raw.length).toBe(CHALLENGE_STRUCT_SIZE);
    const c = parseUnlockChallenge(raw);
    expect(c.version).toBe(1);
    expect(c.productIdHash.equals(productIdHash)).toBe(true);
    expect(c.challengeData.equals(challengeData)).toBe(true);
  });

  it("rejects a wrong-size body with a 400 BAD_CHALLENGE", () => {
    const err = throwsUnlockError(() => parseUnlockChallenge(Buffer.alloc(51)));
    expect(err.status).toBe(400);
    expect(err.code).toBe("BAD_CHALLENGE");
  });
});

describe("certSubject", () => {
  it("reads the 32-byte subject at offset 4 + 1032", () => {
    const subject = Buffer.from("0123456789abcdef".repeat(4), "hex");
    expect(subject.length).toBe(32);
    expect(certSubject(fakeCert(subject)).equals(subject)).toBe(true);
  });

  it("rejects a non-1620-byte certificate with a 500", () => {
    const err = throwsUnlockError(() => certSubject(Buffer.alloc(1619)));
    expect(err.status).toBe(500);
    expect(err.code).toBe("BAD_CREDENTIAL");
  });
});

describe("createCredentialSet", () => {
  it("derives the product ID hash from the PUK cert subject", () => {
    const subject = Buffer.alloc(32, 0x42);
    const set = createCredentialSet(
      "test",
      fakeCert(Buffer.alloc(32, 0x99)),
      fakeCert(subject),
      pkcs1Pem,
    );
    expect(set.name).toBe("test");
    expect(set.productIdHash.equals(subject)).toBe(true);
  });

  it("accepts both PKCS#1 and PKCS#8 PEM keys", () => {
    const subject = Buffer.alloc(32, 0x77);
    expect(
      createCredentialSet(
        "a",
        fakeCert(Buffer.alloc(32)),
        fakeCert(subject),
        pkcs1Pem,
      ),
    ).toBeTruthy();
    expect(
      createCredentialSet(
        "b",
        fakeCert(Buffer.alloc(32)),
        fakeCert(subject),
        pkcs8Pem,
      ),
    ).toBeTruthy();
  });

  it("rejects a bad certificate size", () => {
    expect(() =>
      createCredentialSet("x", Buffer.alloc(100), fakeCert(Buffer.alloc(32)), pkcs1Pem),
    ).toThrowError(/PIK certificate must be 1620 bytes/);
  });

  it("rejects a public key where a private key is expected", () => {
    const err = throwsUnlockError(() =>
      createCredentialSet(
        "x",
        fakeCert(Buffer.alloc(32)),
        fakeCert(Buffer.alloc(32)),
        publicPem,
      ),
    );
    expect(err.code).toBe("BAD_CREDENTIAL");
  });
});

describe("makeUnlockCredential", () => {
  it("builds the exact struct layout: u32 LE version + 1620 + 1620 + 256", () => {
    const pik = fakeCert(Buffer.alloc(32, 0x10));
    const puk = fakeCert(Buffer.alloc(32, 0x20));
    const set: UnlockCredentialSet = createCredentialSet(
      "test",
      pik,
      puk,
      pkcs1Pem,
    );
    const challenge = fakeChallenge(Buffer.alloc(32, 0x20));
    const { credential, signature } = makeUnlockCredential(set, challenge);

    expect(signature.length).toBe(256);
    expect(credential.length).toBe(4 + CERT_SIZE + CERT_SIZE + 256);
    expect(credential.subarray(0, 4).readUInt32LE(0)).toBe(1);
    expect(credential.subarray(4, 4 + CERT_SIZE).equals(pik)).toBe(true);
    expect(
      credential.subarray(4 + CERT_SIZE, 4 + 2 * CERT_SIZE).equals(puk),
    ).toBe(true);
    expect(
      credential.subarray(4 + 2 * CERT_SIZE).equals(signature),
    ).toBe(true);
  });

  it("produces a signature that verifies against the PUK public key", () => {
    const subject = Buffer.alloc(32, 0x30);
    const set = createCredentialSet(
      "test",
      fakeCert(Buffer.alloc(32)),
      fakeCert(subject),
      pkcs1Pem,
    );
    const challenge = fakeChallenge(subject);
    const { signature } = makeUnlockCredential(set, challenge);

    const verify = createVerify("sha512").update(challenge.challengeData);
    expect(verify.verify(publicPem, signature)).toBe(true);
  });

  it("signature is challenge-specific (a different challenge fails)", () => {
    const subject = Buffer.alloc(32, 0x40);
    const set = createCredentialSet(
      "test",
      fakeCert(Buffer.alloc(32)),
      fakeCert(subject),
      pkcs1Pem,
    );
    const { signature } = makeUnlockCredential(set, fakeChallenge(subject));

    const verify = createVerify("sha512").update(Buffer.alloc(16, 0x00));
    expect(verify.verify(publicPem, signature)).toBe(false);
  });
});

describe("selectMatchingCredentialSet", () => {
  it("matches by PUK-cert subject == challenge product ID hash", () => {
    const hashA = Buffer.alloc(32, 0xaa);
    const hashB = Buffer.alloc(32, 0xbb);
    const setA = createCredentialSet(
      "a",
      fakeCert(Buffer.alloc(32)),
      fakeCert(hashA),
      pkcs1Pem,
    );
    const setB = createCredentialSet(
      "b",
      fakeCert(Buffer.alloc(32)),
      fakeCert(hashB),
      pkcs1Pem,
    );
    expect(selectMatchingCredentialSet([setA, setB], fakeChallenge(hashB))).toBe(
      setB,
    );
    expect(
      selectMatchingCredentialSet([setA, setB], fakeChallenge(Buffer.alloc(32, 0xcc))),
    ).toBeUndefined();
  });
});
