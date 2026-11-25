/**
 * Loads Android Things unlock credential sets at runtime, so the (secret)
 * credentials are never part of the repository.
 *
 * The single source is the `UNLOCK_CREDENTIALS` env var: a JSON array, one
 * object per set:
 *
 *   [ { "name": "amber",
 *       "pik":     "<base64 of pik_certificate.*.bin>",
 *       "pukCert": "<base64 of puk_certificate.*.bin>",
 *       "puk":     "<PEM of puk.*.pem>" } ]
 *
 * This works identically on serverless hosts (Vercel, where functions have
 * no writable/persistent filesystem) and locally: `npm run prepare-creds`
 * parses the Developer Console zip bundles in `creds/` and writes this
 * value to `.env` (gitignored), which Next.js loads on `npm run dev`. On
 * Vercel the same value is pasted into a `UNLOCK_CREDENTIALS` Secret.
 *
 * The value contains the PUK private key. Keep it secret.
 */
import {
  createCredentialSet,
  type UnlockCredentialSet,
} from "@/lib/avb-unlock";

/** One entry of the UNLOCK_CREDENTIALS env var (a JSON array). */
interface EnvCredentialSet {
  name?: string;
  pik?: string; // base64 of the PIK certificate (1620 bytes)
  pukCert?: string; // base64 of the PUK certificate (1620 bytes)
  puk?: string; // PEM of the PUK private key
}

/**
 * Parses credential sets from the UNLOCK_CREDENTIALS env var. Malformed
 * entries are skipped (and logged), matching the reference tool's
 * behaviour of ignoring bundles that fail to parse.
 */
function parseEnvCredentialSets(): UnlockCredentialSet[] {
  const raw = process.env.UNLOCK_CREDENTIALS;
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(
      `credential-store: UNLOCK_CREDENTIALS is not valid JSON: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error(
      "credential-store: UNLOCK_CREDENTIALS must be a JSON array, " +
        "see scripts/prepare-creds.mjs",
    );
    return [];
  }
  const sets: UnlockCredentialSet[] = [];
  parsed.forEach((entry, i) => {
    const set = entry as EnvCredentialSet;
    const name = set.name ?? `env-set-${i + 1}`;
    try {
      if (
        typeof set.pik !== "string" ||
        typeof set.pukCert !== "string" ||
        typeof set.puk !== "string"
      ) {
        throw new Error(
          'missing "pik" (base64), "pukCert" (base64), or "puk" (PEM) field',
        );
      }
      sets.push(
        createCredentialSet(
          name,
          Buffer.from(set.pik, "base64"),
          Buffer.from(set.pukCert, "base64"),
          set.puk,
        ),
      );
    } catch (e) {
      console.error(
        `credential-store: ignoring credential set "${name}": ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
  return sets;
}

// The env var is fixed for the lifetime of a deployment, so parsing (which
// includes key-pair parsing, the expensive part) happens once per process.
let cache: { sets: UnlockCredentialSet[]; loaded: boolean } = {
  sets: [],
  loaded: false,
};

/** Returns all credential sets (parsed once, then cached). */
export function loadCredentialSets(): UnlockCredentialSet[] {
  if (!cache.loaded) {
    cache = { sets: parseEnvCredentialSets(), loaded: true };
  }
  return cache.sets;
}
