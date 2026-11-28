/**
 * End-to-end self-test for POST /api/v1/unlock_challenge.
 *
 * Credentials now come from the UNLOCK_CREDENTIALS env var only (the
 * serverless / Vercel mode), so the test exercises exactly that path:
 *
 *   1. a dev server with UNLOCK_CREDENTIALS unset → 503, plus the
 *      request-validation error paths (malformed/empty body → 400),
 *   2. a dev server with UNLOCK_CREDENTIALS set to two throwaway
 *      credential sets (fake 1620-byte certificates + fresh RSA keys)
 *      serves both, and the response is verified byte-for-byte and
 *      cryptographically (PKCS#1 v1.5 + SHA-512, per at_auth_unlock.py),
 *   3. an unknown product ID → 404.
 *   4. GET /api/v1/credentials lists the loaded sets (name + product ID
 *      hash only; empty array when no sets are loaded).
 *
 * Both servers get UNLOCK_CREDENTIALS/UNLOCK_API_TOKEN set explicitly on
 * the process (Next.js .env files never override existing process env),
 * so a local .env with real credentials can't leak into the test.
 *
 * Usage: node scripts/selftest.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const CRED_PORT = 3124;
const CRED_BASE = `http://127.0.0.1:${CRED_PORT}`;
const CERT_SIZE = 1620;
const CERT_SUBJECT_OFFSET = 4 + 1032; // per GetCertCertificateSubject

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/** Builds a fake 1620-byte AvbCertCertificate with format version 1 and
 * the given 32-byte subject at the canonical offset. */
function makeCert(subject) {
  const b = Buffer.alloc(CERT_SIZE);
  b.writeUInt32LE(1, 0);
  b.subarray(CERT_SUBJECT_OFFSET, CERT_SUBJECT_OFFSET + 32).set(subject);
  return b;
}

async function post(base, rawBytes) {
  return fetch(`${base}/api/v1/unlock_challenge`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: rawBytes,
  });
}

/**
 * Builds the raw 52-byte AvbCertUnlockChallenge struct:
 * version (u32 LE = 1) + SHA-256(productId) + challengeData.
 */
function buildChallenge(productId, challengeData) {
  const hash = crypto.createHash("sha256").update(productId).digest();
  const version = Buffer.from([1, 0, 0, 0]);
  return { raw: Buffer.concat([version, hash, challengeData]), hash };
}

/**
 * Verifies the raw AvbCertUnlockCredential response byte-for-byte and
 * cryptographically. Returns { matched } (the X-Matched-Credential-Set
 * header) for the caller to assert.
 */
async function verifyCredential(res, expect) {
  check(`status 200 (got ${res.status})`, res.status === 200);
  if (res.status !== 200) return { matched: null };
  const file = Buffer.from(await res.arrayBuffer());

  check(
    "content-type is application/octet-stream",
    res.headers.get("content-type")?.includes("application/octet-stream") ===
      true,
  );
  check("format version is 1", file.readUInt32LE(0) === 1);
  check(
    "PIK cert matches input (offset 4..1624)",
    file.subarray(4, 4 + CERT_SIZE).equals(expect.pikCert),
  );
  check(
    "PUK cert matches input (offset 1624..3244)",
    file.subarray(4 + CERT_SIZE, 4 + 2 * CERT_SIZE).equals(expect.pukCert),
  );
  const signature = file.subarray(4 + 2 * CERT_SIZE);
  check(
    `signature is 256 bytes (2048-bit RSA), got ${signature.length}`,
    signature.length === 256,
  );
  check(
    "signature verifies: PKCS#1 v1.5 over SHA-512(challenge_data)",
    crypto.verify("sha512", expect.challengeData, expect.publicKey, signature) ===
      true,
  );
  return { matched: res.headers.get("x-matched-credential-set") };
}

function startServer(port, env) {
  const server = spawn("npx", ["next", "dev", "-p", String(port)], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // detached → own process group, so killServer() can take down the
    // whole npx → next → next-server tree (a plain .kill() only kills the
    // npx wrapper and orphans next-server).
    detached: true,
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  return { server, getLog: () => log };
}

function killServer(entry) {
  try {
    process.kill(-entry.server.pid, "SIGTERM");
  } catch {
    try {
      entry.server.kill("SIGTERM");
    } catch {}
  }
}

async function waitForReady(base, timeoutMs, getLog, label = "dev server") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // An empty-body POST → 400 (or 401/503) is enough: any routed
      // response means the handler is up.
      const res = await post(base, Buffer.alloc(0));
      if (res.status < 500) return;
      res.body?.cancel();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const tail = getLog().split("\n").slice(-30).join("\n");
  throw new Error(
    `${label} did not become ready in ${timeoutMs}ms\n` +
      `--- ${label} log (tail) ---\n${tail}`,
  );
}

async function main() {
  // Two throwaway credential sets (fake certs + fresh RSA keys).
  const sets = {};
  for (const [name, productId] of [
    ["selftest-a", "selftest-product-a"],
    ["selftest-b", "selftest-product-b"],
  ]) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const pikCert = makeCert(crypto.randomBytes(32));
    const pukCert = makeCert(
      crypto.createHash("sha256").update(productId).digest(),
    );
    sets[name] = { publicKey, pikCert, pukCert, pem };
  }
  const envCredsValue = JSON.stringify(
    Object.values(sets).map((s, i) => ({
      name: Object.keys(sets)[i],
      pik: Buffer.from(s.pikCert).toString("base64"),
      pukCert: Buffer.from(s.pukCert).toString("base64"),
      puk: s.pem,
    })),
  );

  // Server 1: no credentials (the empty env var also blocks a local .env
  // from leaking in — Next.js never overrides existing process env).
  const noCreds = startServer(PORT, {
    UNLOCK_CREDENTIALS: "",
    UNLOCK_API_TOKEN: "",
  });
  try {
    console.log("waiting for dev server…");
    await waitForReady(BASE, 150_000, noCreds.getLog, "no-credentials server");

    console.log("\n[1] no credentials loaded → 503");
    const r503 = await post(
      BASE,
      buildChallenge("anything", crypto.randomBytes(16)).raw,
    );
    check("returns 503", r503.status === 503, `got ${r503.status}`);

    console.log("\n[2] request-validation error paths");
    const wrongLen = await post(BASE, crypto.randomBytes(16)); // 16 bytes
    check(
      `wrong-length body → 400 (got ${wrongLen.status})`,
      wrongLen.status === 400,
    );
    const empty = await post(BASE, Buffer.alloc(0));
    check(`empty body → 400 (got ${empty.status})`, empty.status === 400);

    console.log("\n[3] GET /api/v1/credentials with no sets → 200 []");
    const lc0 = await fetch(`${BASE}/api/v1/credentials`);
    check(`status 200 (got ${lc0.status})`, lc0.status === 200);
    const lc0Body = await lc0.json();
    check(
      "empty array",
      Array.isArray(lc0Body) && lc0Body.length === 0,
    );
  } finally {
    killServer(noCreds);
  }

  // Server 2: the Vercel situation — credentials only from the env var.
  const withCreds = startServer(CRED_PORT, {
    UNLOCK_CREDENTIALS: envCredsValue,
    UNLOCK_API_TOKEN: "",
  });
  try {
    console.log("waiting for credential server…");
    await waitForReady(
      CRED_BASE,
      150_000,
      withCreds.getLog,
      "credential server",
    );

    console.log("\n[3] set A matches and signs");
    const a = buildChallenge("selftest-product-a", crypto.randomBytes(16));
    const resA = await verifyCredential(
      await post(CRED_BASE, a.raw),
      {
        ...sets["selftest-a"],
        challengeData: a.raw.subarray(36, 52),
      },
    );
    check(
      "X-Matched-Credential-Set is set A",
      resA.matched === "selftest-a",
      `got ${resA.matched}`,
    );

    console.log("\n[4] set B matches and signs");
    const b = buildChallenge("selftest-product-b", crypto.randomBytes(16));
    const resB = await verifyCredential(
      await post(CRED_BASE, b.raw),
      {
        ...sets["selftest-b"],
        challengeData: b.raw.subarray(36, 52),
      },
    );
    check(
      "X-Matched-Credential-Set is set B",
      resB.matched === "selftest-b",
      `got ${resB.matched}`,
    );

    console.log("\n[5] unknown product → 404");
    const unknown = await post(
      CRED_BASE,
      buildChallenge("no-such-product", crypto.randomBytes(16)).raw,
    );
    check(
      `unknown product → 404 (got ${unknown.status})`,
      unknown.status === 404,
    );

    console.log("\n[6] GET /api/v1/credentials lists the loaded sets");
    const lc = await fetch(`${CRED_BASE}/api/v1/credentials`);
    check(`status 200 (got ${lc.status})`, lc.status === 200);
    const lcBody = await lc.json();
    const byName = Object.fromEntries(
      lcBody.map((c) => [c.name, c.productIdHash]),
    );
    check(
      "set A listed with its product ID hash",
      byName["selftest-a"] ===
        crypto.createHash("sha256").update("selftest-product-a").digest("hex"),
    );
    check(
      "set B listed with its product ID hash",
      byName["selftest-b"] ===
        crypto.createHash("sha256").update("selftest-product-b").digest("hex"),
    );
    check(
      "entries carry only name + productIdHash (no cert/key material)",
      lcBody.every(
        (c) => Object.keys(c).sort().join(",") === "name,productIdHash",
      ),
    );
  } finally {
    killServer(withCreds);
  }

  console.log(
    failures === 0
      ? "\nALL CHECKS PASSED"
      : `\n${failures} CHECK(S) FAILED`,
  );
  if (failures > 0) {
    console.error("\n--- no-credentials server log (tail) ---");
    console.error(noCreds.getLog().split("\n").slice(-30).join("\n"));
    console.error("\n--- credential server log (tail) ---");
    console.error(withCreds.getLog().split("\n").slice(-30).join("\n"));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
