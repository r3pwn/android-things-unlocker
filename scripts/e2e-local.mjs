/**
 * One-off end-to-end check against the REAL Developer Console bundles:
 * reads .env (as produced by `npm run prepare-creds`), starts a dev
 * server with NO env overrides (so Next.js loads .env exactly like a
 * real deployment), then for every credential set builds a 52-byte
 * AvbCertUnlockChallenge from the set's real PUK-cert subject hash and
 * verifies the returned struct byte-for-byte + cryptographically
 * (PKCS#1 v1.5 over SHA-512, verified against the real PUK public key).
 *
 * Usage: node scripts/e2e-local.mjs   (requires a prepared .env)
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const PORT = 3125;
const BASE = `http://127.0.0.1:${PORT}`;
const CERT_SIZE = 1620;
const CERT_SUBJECT_OFFSET = 4 + 1032;

function killTree(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

async function main() {
  const envText = await readFile(
    path.resolve(import.meta.dirname, "..", ".env"),
    "utf8",
  );
  const line = envText.split("\n").find((l) => l.startsWith("UNLOCK_CREDENTIALS="));
  if (!line) throw new Error(".env has no UNLOCK_CREDENTIALS line; run npm run prepare-creds");
  const sets = JSON.parse(line.slice("UNLOCK_CREDENTIALS=".length));
  console.log(`.env holds ${sets.length} credential set(s)`);

  // NO UNLOCK_CREDENTIALS / UNLOCK_API_TOKEN override → Next.js loads .env.
  const server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));

  try {
    let ready = false;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && !ready) {
      try {
        const res = await fetch(`${BASE}/api/v1/unlock_challenge`);
        const body = await res.json();
        if (res.status === 200 && body.credentials_loaded === sets.length) {
          ready = true;
          console.log(
            `server up, credentials_loaded=${body.credentials_loaded} (expected ${sets.length}) — .env path confirmed`,
          );
        } else {
          console.log(
            `health ${res.status} credentials_loaded=${body.credentials_loaded ?? "?"}`,
          );
        }
      } catch {}
      if (!ready) await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!ready) throw new Error("server did not report the .env credential count");

    let failures = 0;
    for (const set of sets) {
      const pukCert = Buffer.from(set.pukCert, "base64");
      const hash = pukCert.subarray(CERT_SUBJECT_OFFSET, CERT_SUBJECT_OFFSET + 32);
      const challengeData = crypto.randomBytes(16);
      const challenge = Buffer.concat([
        Buffer.from([1, 0, 0, 0]),
        hash,
        challengeData,
      ]);
      const res = await fetch(`${BASE}/api/v1/unlock_challenge`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: challenge,
      });
      const ok = res.status === 200;
      if (!ok) {
        failures += 1;
        console.error(`FAIL ${set.name}: status ${res.status}: ${await res.text()}`);
        continue;
      }
      const file = Buffer.from(await res.arrayBuffer());
      const matched = res.headers.get("x-matched-credential-set") === set.name;
      const pikIn = Buffer.from(set.pik, "base64");
      const pikOk = file.subarray(4, 4 + CERT_SIZE).equals(pikIn);
      const pukOk = file.subarray(4 + CERT_SIZE, 4 + 2 * CERT_SIZE).equals(pukCert);
      const signature = file.subarray(4 + 2 * CERT_SIZE);
      // Derive the real PUK public key from the private key PEM and
      // verify the server's signature against it.
      const pubKey = crypto.createPublicKey(
        crypto.createPrivateKey(set.puk),
      );
      const sigOk =
        crypto.verify("sha512", challengeData, pubKey, signature) === true;
      const all = ok && matched && pikOk && pukOk && sigOk;
      console.log(
        `${all ? "ok  " : "FAIL"} ${set.name}: 200=${ok} matched=${matched} ` +
          `pik=${pikOk} puk=${pukOk} sig-verifies=${sigOk}`,
      );
      if (!all) failures += 1;
    }
    console.log(failures === 0 ? "\nE2E PASSED (real credentials)" : `\nE2E FAILED: ${failures} set(s)`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    killTree(server.pid);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
