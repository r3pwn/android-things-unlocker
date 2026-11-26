This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser — the
unlock tool is the home page. The page auto-updates as you make changes.

## API: authenticated AVB unlock challenge-response

`POST /api/v1/unlock_challenge` implements the credential side of the Android
Things authenticated AVB unlock protocol, as defined by
[`at_auth_unlock.py`](https://android.googlesource.com/platform/external/avb/+/master/tools/at_auth_unlock.py).
It replaces everything between `fastboot get_staged` and `fastboot stage`
in that script: you send it the unlock challenge from the device, and it
returns the signed `AvbCertUnlockCredential` struct.

### Credentials

The unlock credentials are **never part of this repository**. The single
source is the `UNLOCK_CREDENTIALS` env var (a JSON array, one object per
set), which works identically locally and on serverless hosts:

1. Drop the **zip bundles exactly as downloaded** from the Android Things
   Developer Console into `creds/` (gitignored, no extraction needed).
2. Run `npm run prepare-creds`. It parses every `creds/*.zip` and writes the
   `UNLOCK_CREDENTIALS` value to `.env` (gitignored).
3. `npm run dev` — Next.js loads `.env` automatically, and the endpoint is
   ready.

Each bundle holds the three credential files:

| file | pattern | what it is |
| --- | --- | --- |
| PIK certificate | `pik_certificate.*.bin` | 1620-byte `AvbCertCertificate` |
| PUK certificate | `puk_certificate.*.bin` | 1620-byte `AvbCertCertificate` |
| PUK private key | `puk.*.pem` | RSA private key (PKCS#1 or PKCS#8) |

Each set's `name` (reported in `X-Matched-Credential-Set`) is the device
codename derived from the bundle filename — `amber-unlock_credentials.zip`
or `cube_unlock_credentials.zip` becomes `amber` / `cube`.

Sets are matched to the device by the product ID: the PUK certificate's
subject is the SHA-256 hash of the product ID, which is also carried in the
challenge — exactly like `SelectMatchingUnlockCredential` in the reference
tool. The PUK private key is the only secret; it is used server-side to sign
and never appears in any response.

> Note: the Developer Console bundles carry a slightly inconsistent zip
> metadata field that some parsers reject; `prepare-creds` repairs it
> transparently before parsing.

Optionally set `UNLOCK_API_TOKEN` to require
`Authorization: Bearer <token>` on all requests.

### Request

The request body is the **raw 52-byte `AvbCertUnlockChallenge` struct** —
no encoding, exactly what `fastboot get_staged` produces. The whole unlock
is a clean binary pipe:

```bash
# 1. Get the challenge from the device
fastboot oem at-get-vboot-unlock-challenge
fastboot get_staged challenge.bin

# 2. Send the raw struct, save the raw credential struct
#    (add `-H "Authorization: Bearer <token>" if UNLOCK_API_TOKEN is set)
curl -s localhost:3000/api/v1/unlock_challenge \
  --data-binary @challenge.bin -o unlock_credential.bin

# 3. Stage it and unlock, as the reference tool does
fastboot stage unlock_credential.bin
fastboot oem at-unlock-vboot
```

### Response

On success the body is the **raw `AvbCertUnlockCredential` struct** — the
exact byte sequence the reference tool writes to disk and stages. Metadata
is carried in headers, not the body:

```
HTTP/1.1 200 OK
Content-Type: application/octet-stream
X-Matched-Credential-Set: amber
X-Credential-Format-Version: 1

<raw AvbCertUnlockCredential struct bytes>
```

The struct layout is `format_version (u32 LE = 1)` + PIK certificate (1620
bytes) + PUK certificate (1620 bytes) + PKCS#1 v1.5 / SHA-512 signature
(256 bytes for a 2048-bit key).

Errors return a JSON body `{ "ok": false, "error": <code>, "detail": ... }`
with `400` (bad request), `401` (token, if configured), `404` (no credential
set matches the device), and `503` (no credentials loaded).

### Self-test

`node scripts/selftest.mjs` starts two dev servers (one with no credentials,
one with `UNLOCK_CREDENTIALS` set to two throwaway sets — fake 1620-byte
certificates + fresh RSA keys), exercises the endpoint end-to-end, and
cryptographically verifies the returned struct. It is isolated from any local
`.env` (it sets the env vars explicitly, which `.env` never overrides) and
cleans up after itself.

`node scripts/e2e-local.mjs` is a manual verification against the *real*
bundles: it reads `.env` (after `npm run prepare-creds`), starts a dev server
with no env overrides (so `.env` loads exactly like a deployment), and for
every set drives the endpoint with a challenge built from the set's real PUK
cert, verifying the returned struct byte-for-byte and the signature against
the real PUK public key.

## WebUSB unlock tool

The home page (`/`) is a browser tool that performs the **device side**
of the unlock
without the `fastboot` CLI — a single card, in the spirit of the
[LineageOS flash tool](https://download.lineageos.org/flash/fastboot).
It speaks fastboot over
[WebUSB](https://wicg.github.io/webusb/) using the
[`android-fastboot`](https://www.npmjs.com/package/android-fastboot)
package, and signs the challenge through the same-origin API. The PUK
private key stays on the server — the browser only ever sees the 52-byte
challenge and the signed credential.

While no device is attached it shows "Waiting for fastboot device…"; when
a fastboot device is connected (it auto-connects if one is already paired,
or via the Connect button) it reports the serial and the lock state of
both the verified-boot (AVB) and the standard bootloader, and offers the
actions valid for that state:

| action | command |
| --- | --- |
| AVB unlock | `oem at-get-vboot-unlock-challenge` → API → `stage` → `oem at-unlock-vboot` |
| AVB re-lock | `oem at-lock-vboot!` |
| Bootloader unlock | `fastboot flashing unlock` |
| Bootloader re-lock | `fastboot flashing lock` |

State is read from the device: `getvar at-vboot-state`
(`avb-locked=0/1`) for the AVB lock, and `getvar bootloader-locked`
(with `warranty` as fallback) for the standard bootloader. After
`flashing unlock`/`lock` the device reboots into fastboot; the tool waits
for it to re-attach and re-reads the state.

> **Warning:** the AVB re-lock action (`oem at-lock-vboot!`) is gated behind
> a confirmation dialog because re-locking verified boot while a non-stock
> build is flashed can hard-brick some Android Things devices.

Open it at `http://localhost:3000` (after `pnpm dev`) or on a deployed
URL. Requirements:

- **Chrome or Edge, over https (or `localhost`)** — WebUSB is a
  secure-context-only API in those two browsers. The page shows a tag with
  the WebUSB availability.
- **The device in fastboot mode** — for the AVB unlock it must also be
  *locked* (`at-get-vboot-unlock-challenge` is only available on a locked
  device; the state tags tell you what the device is currently doing).
- **The API loaded with at least one credential set** — the same
  `UNLOCK_CREDENTIALS` as the CLI/API flow; the page shows how many sets
  are loaded.
- **Theming** — the UI follows the OS colour scheme: the antd light/dark
  theme switches to match the page background (and live-updates if the
  system setting changes).

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel (free tier)

Vercel functions have no persistent filesystem, so the credentials live in
an env var — the same `UNLOCK_CREDENTIALS` value `prepare-creds` produces:

1. `npm run prepare-creds -- --vercel --print` — validates the value fits
   Vercel's budget (exits 1 if not, without writing `.env`) and prints it.
   Plain `npm run prepare-creds` only *warns* when over budget, since the
   value is still valid for local use regardless of size.
2. Vercel dashboard → Project → Settings → **Environment Variables** → add
   `UNLOCK_CREDENTIALS` with type **Secret** (encrypted at rest, cannot be
   read back) and paste the printed value.
3. Optionally add `UNLOCK_API_TOKEN` (Secret) for bearer-token auth.
4. **Redeploy** — env var changes require a redeploy.

Budget: Vercel's total env-var limit is **64 KB per deployment** (all
plans, shared across *all* env vars). A 2048-bit bundle is roughly 8 KB,
so this comfortably fits about 8 credential sets; beyond that, self-host
(the app is a plain Next.js app — `npm run build && npm start` — with the
same env var).

The private key stays on Vercel and never appears in any response; the
endpoint only ever returns the public certificates plus a signature that is
valid solely for the specific challenge it was computed for.
