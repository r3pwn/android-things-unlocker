/**
 * Parses the Android Things unlock credential bundles in `creds/` and
 * writes them to `.env` as the UNLOCK_CREDENTIALS env var — the
 * single credentials source the app loads at runtime. Drop the zip
 * bundles exactly as downloaded from the Developer Console into
 * `creds/` (no extraction needed). `creds/` and `.env` are gitignored,
 * so the credentials never enter the repository; on Vercel, paste the
 * same value into a UNLOCK_CREDENTIALS env var of type "Secret"
 * (encrypted at rest), then redeploy.
 *
 * Usage:
 *   pnpm run prepare-creds               # parse creds/*.zip → write .env
 *   pnpm run prepare-creds -- --print    # also print the value to stdout
 *   pnpm run prepare-creds -- --vercel   # hard gate: exit 1 (no write) if
 *                                        # the value exceeds Vercel's 64 KB
 *                                        # env-var budget (default: only warn,
 *                                        # since the value is still valid
 *                                        # for local use regardless of size)
 *
 * The output contains the PUK private key. Keep it secret.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const PIK_CERT_RE = /^pik_certificate.*\.bin$/;
const PUK_CERT_RE = /^puk_certificate.*\.bin$/;
const PUK_KEY_RE = /^puk.*\.pem$/;

const CREDS_DIR = path.resolve(import.meta.dirname, "..", "creds");
const ENV_FILE = path.resolve(import.meta.dirname, "..", ".env");
// Vercel's total env-var budget per deployment (all plans).
const VERCEL_ENV_BUDGET = 64 * 1024;

/**
 * Derives the device codename from a bundle filename:
 * "amber-unlock_credentials.zip" or "cube_unlock_credentials.zip" →
 * "amber" / "cube" (the Developer Console uses both separators). Falls
 * back to the extension-less name when the pattern is absent.
 */
function codenameFromZip(zipPath) {
  const base = path.basename(zipPath, ".zip");
  const stripped = base.replace(/[-_]?unlock_credentials$/i, "");
  return stripped || base;
}

function findOneMatch(names, re, desc, where) {
  const matches = names.filter((n) => re.test(n));
  if (matches.length === 0) {
    throw new Error(`no ${desc} (matching "${re}") in ${where}`);
  }
  if (matches.length > 1) {
    throw new Error(`multiple ${desc} (matching "${re}") in ${where}`);
  }
  return matches[0];
}

/**
 * Repairs a zip metadata inconsistency JSZip cannot parse: the
 * Developer Console bundles have an EOCD whose
 * `centralDirOffset + centralDirSize` does not reach the EOCD.
 * JSZip's "extra bytes" heuristic reads that gap as prepended data
 * (as in .crx files) and shifts every read, then throws "expected N
 * records in central dir, got 0". System unzip ignores the field and
 * reads the file fine.
 *
 * Fix: when a genuine central-file-header sits at `centralDirOffset`,
 * the offset is correct and only `centralDirSize` is short — patch it
 * to `eocdOffset - centralDirOffset`. Returns the (possibly patched)
 * buffer.
 */
function repairZipBuffer(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return buf;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const hasHeaderAtOffset =
    buf[cdOffset] === 0x50 &&
    buf[cdOffset + 1] === 0x4b &&
    buf[cdOffset + 2] === 0x01 &&
    buf[cdOffset + 3] === 0x02;
  if (cdOffset + cdSize !== eocd && hasHeaderAtOffset) {
    const fixed = Buffer.from(buf);
    fixed.writeUInt32LE(eocd - cdOffset, eocd + 12);
    return fixed;
  }
  return buf;
}

async function fromZip(zipPath) {
  const zip = await JSZip.loadAsync(repairZipBuffer(await readFile(zipPath)));
  const names = Object.keys(zip.files);
  const pik = findOneMatch(names, PIK_CERT_RE, "PIK certificate", zipPath);
  const pukCert = findOneMatch(names, PUK_CERT_RE, "PUK certificate", zipPath);
  const puk = findOneMatch(names, PUK_KEY_RE, "PUK private key", zipPath);
  const [ik, uc, pk] = await Promise.all([
    zip.files[pik].async("nodebuffer"),
    zip.files[pukCert].async("nodebuffer"),
    zip.files[puk].async("nodebuffer"),
  ]);
  return {
    name: codenameFromZip(zipPath),
    pik: Buffer.from(ik).toString("base64"),
    pukCert: Buffer.from(uc).toString("base64"),
    puk: Buffer.from(pk).toString("utf8"),
  };
}

/**
 * Writes UNLOCK_CREDENTIALS=<value> into .env, replacing any existing
 * UNLOCK_CREDENTIALS line(s) and preserving the rest; creates the file
 * if it does not exist. The value is single-line compact JSON: safe
 * unquoted in an env file.
 */
async function writeEnvFile(value) {
  let existing = "";
  try {
    existing = await readFile(ENV_FILE, "utf8");
  } catch {
    // no .env yet
  }
  const line = `UNLOCK_CREDENTIALS=${value}`;
  const kept = existing
    .split("\n")
    .filter((l) => !l.startsWith("UNLOCK_CREDENTIALS="));
  const trimmed = kept.join("\n").replace(/\n+$/, "");
  await writeFile(
    ENV_FILE,
    (trimmed ? trimmed + "\n" : "") + line + "\n",
    "utf8",
  );
}

async function main() {
  const print = process.argv.includes("--print");
  const vercel = process.argv.includes("--vercel");
  let zips;
  try {
    zips = (await readdir(CREDS_DIR))
      .filter((n) => n.toLowerCase().endsWith(".zip"))
      .sort();
  } catch (e) {
    throw new Error(
      `cannot read ${CREDS_DIR}: ` +
        `${e instanceof Error ? e.message : String(e)} — drop the Developer ` +
        `Console zip bundles into creds/ first`,
    );
  }
  if (zips.length === 0) {
    throw new Error(
      `no .zip files in ${CREDS_DIR} — drop the Developer Console zip ` +
        "bundles there first",
    );
  }
  const sets = [];
  for (const name of zips) {
    try {
      sets.push(await fromZip(path.join(CREDS_DIR, name)));
    } catch (e) {
      throw new Error(
        `${name} is not a valid unlock credential bundle: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Compact (single-line) JSON: safe unquoted in .env, and it is the exact
  // value to paste into Vercel's dashboard.
  const value = JSON.stringify(sets);
  // Vercel's budget is shared across ALL env vars (UNLOCK_API_TOKEN etc.),
  // so the true ceiling is slightly lower; the value dominates, though.
  const overBudget = value.length > VERCEL_ENV_BUDGET;
  if (overBudget && vercel) {
    console.error(
      `ERROR: ${value.length} bytes exceeds Vercel's ${VERCEL_ENV_BUDGET} ` +
        `byte env-var budget (shared across all env vars). This value ` +
        `cannot be deployed to Vercel — remove sets or self-host.`,
    );
    process.exit(1);
  }
  // Always (re)write .env so local dev keeps working; --print additionally
  // emits the value on stdout for pasting into Vercel's dashboard.
  await writeEnvFile(value);
  if (print) {
    process.stdout.write(value + "\n");
  }
  console.error(
    `prepared ${sets.length} credential set(s): ` +
      sets.map((s) => s.name).join(", "),
  );
  console.error(`UNLOCK_CREDENTIALS value: ${value.length} bytes`);
  if (overBudget) {
    console.error(
      `WARNING: ${value.length} bytes exceeds Vercel's ${VERCEL_ENV_BUDGET} ` +
        `byte env-var budget (shared across all env vars). Fine locally; ` +
        `it will not fit on Vercel — remove sets or self-host.`,
    );
  }
  console.error(`written to ${ENV_FILE}`);
  if (print) {
    console.error(`value printed to stdout`);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
