import { NextResponse } from "next/server";
import {
  CREDENTIAL_FORMAT_VERSION,
  parseUnlockChallenge,
  makeUnlockCredential,
  selectMatchingCredentialSet,
  UnlockError,
} from "@/lib/avb-unlock";
import { loadCredentialSets } from "@/lib/credential-store";

export const runtime = "nodejs";

/**
 * POST /api/v1/unlock_challenge
 *
 * Request: the raw 52-byte `AvbCertUnlockChallenge` struct as the body —
 * exactly what `fastboot get_staged` produces, piped straight in with no
 * encoding:
 *
 *   fastboot oem at-get-vboot-unlock-challenge
 *   fastboot get_staged challenge.bin
 *   curl -s localhost:3000/api/v1/unlock_challenge \
 *     --data-binary @challenge.bin -o unlock_credential.bin
 *
 * Response (200): the raw `AvbCertUnlockCredential` struct bytes, ready to
 * be written to a file and `fastboot stage`d:
 *
 *   Content-Type: application/octet-stream
 *   X-Matched-Credential-Set: <bundle name>
 *   X-Credential-Format-Version: 1
 *
 * The PUK private key used to produce the signature is never included.
 * Errors return a JSON body `{ ok:false, error, detail }` with status
 * `400` (bad request), `401` (token, if configured), `404` (no credential
 * set matches the device), or `503` (no credentials loaded).
 */

function errorResponse(
  status: number,
  code: string,
  detail: string,
): NextResponse {
  return NextResponse.json({ ok: false, error: code, detail }, { status });
}

/**
 * Optional shared-secret hardening for deployed environments: when
 * `UNLOCK_API_TOKEN` is set, requests must carry
 * `Authorization: Bearer <token>`. Unset → endpoint is open (it only
 * ever returns non-secret data).
 */
function requireAuth(request: Request): NextResponse | null {
  const token = process.env.UNLOCK_API_TOKEN;
  if (!token) return null;
  if ((request.headers.get("authorization") ?? "") === `Bearer ${token}`) {
    return null;
  }
  return errorResponse(401, "UNAUTHORIZED", "missing or invalid Authorization header");
}

export async function POST(request: Request) {
  const authError = requireAuth(request);
  if (authError) return authError;

  let challenge;
  try {
    challenge = parseUnlockChallenge(Buffer.from(await request.arrayBuffer()));
  } catch (e) {
    return errorResponse(
      400,
      "BAD_CHALLENGE",
      e instanceof UnlockError ? e.message : "invalid unlock challenge",
    );
  }

  const sets = loadCredentialSets();
  if (sets.length === 0) {
    return errorResponse(
      503,
      "NO_CREDENTIALS",
      "no unlock credential sets are loaded; set the UNLOCK_CREDENTIALS env var (run \"pnpm run prepare-creds\", or see the README for Vercel)",
    );
  }

  const set = selectMatchingCredentialSet(sets, challenge);
  if (!set) {
    return errorResponse(
      404,
      "NO_MATCHING_CREDENTIALS",
      `no credential set matches this device's product ID hash ${challenge.productIdHash.toString("hex")}`,
    );
  }

  const { credential } = makeUnlockCredential(set, challenge);
  // Wrap in a fresh Uint8Array: the DOM BodyInit type doesn't accept
  // Buffer's generic form, and this also detaches from the backing store.
  return new NextResponse(new Uint8Array(credential), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Matched-Credential-Set": set.name,
      "X-Credential-Format-Version": String(CREDENTIAL_FORMAT_VERSION),
    },
  });
}

