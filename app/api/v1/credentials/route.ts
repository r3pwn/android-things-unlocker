import { NextResponse } from "next/server";
import { loadCredentialSets } from "@/lib/credential-store";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

/**
 * GET /api/v1/credentials — the loaded credential sets as
 * `{ name, productIdHash }` (hex) pairs — names + product ID hashes
 * only: no certificates, and of course no private key.
 *
 * The data only changes on a fresh deployment, so the response is
 * `Cache-Control: no-store` and clients are expected to do their own
 * long-TTL caching (the WebUSB tool caches it in localStorage for 30
 * days) and use it to check, before unlocking, whether a loaded set
 * matches the device's challenge product ID hash.
 *
 * An empty array (`[]`) is a valid answer when no sets are loaded.
 */
export async function GET(request: Request) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const sets = loadCredentialSets();
  return NextResponse.json(
    sets.map((s) => ({
      name: s.name,
      productIdHash: s.productIdHash.toString("hex"),
    })),
    { headers: { "Cache-Control": "no-store" } },
  );
}
