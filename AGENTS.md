<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project rules

## Toolchain

- **pnpm only** (pinned via the `packageManager` field). Never npm/yarn.
- After any file edit, check for CR bytes — the edit tool injects `0x0D`. `node -e` one-liner counting `0x0D` in the touched files, expect 0; fix with a strip if found. Then `pnpm lint` and `pnpm build` (and `pnpm test` when touching `lib/` logic).
- The terminal is a plain `sh` PTY: bashisms (arrays, `$'\r'`, multi-line loops with variables) hang or misbehave. Use single-line commands and `node -e` one-liners.

## Commits

- Imperative subject ≤50 chars, capitalized, no trailing punctuation; a body only when it adds value, wrapped at 72. One logical change per commit. Do not push to `origin` unless asked.

## Verified wire-protocol facts (MT8167 "amber" — do not "fix")

- Commands are written with **no trailing newline**.
- `download:<8hex>` is ack'd with a bare `OKAY` **or** `DATA<8hex>`.
- Upload: host writes `upload`; device sends `DATA<8hex>` + N bytes, then its final `OKAY` — the host sends **no** OKAY.
- The 30 s response window resets on INFO/TEXT.
- `oem at-lock-vboot!` (the bang is required) re-locks AVB.
- `flashing unlock|lock` does NOT reboot this board.
- A **power-cycle** (not a USB unplug/replug) resets the bootloader's staged state after a failed stage.

## WebUSB (Chrome 158, whatwg/usb)

- `USBDeviceFilter` supports only `vendorId`/`productId`/`classCode`/`subclassCode`/`protocolCode`/`serialNumber` — there is **no** `deviceClass`; the old names are silently ignored (picker lists everything).
- `requestDevice` resolves a **single** `USBDevice`, not an array — handle both; guard with `!device`, not `=== null` (undefined slips past).
- `USBInterface` = `interfaceNumber` + `alternates` (not `id`/`alternateSettings`); `USBAlternateInterface` = `interfaceClass`/`interfaceSubclass`/`interfaceProtocol`; `USBEndpoint` = `endpointNumber`/`packetSize`. `libfastboot.ts` reads both current and legacy names via helpers — **keep that duality**.
- **Do not re-chunk the stage write.** The single continuous transfer is what works; every chunked/block-wise experiment parked at the FIFO boundary.
- `libfastboot.connect()` never resets the device — a reset drops the bootloader's staged state.

## UI

- **antd components** are the UI kit. The antd theme **follows the OS colour scheme** (light/dark, live-updating on change) to match the page background.
- The theme **starts light** on server + first client render so both produce identical class hashes (antd's CSS-in-JS changes them per algorithm); the real scheme is applied in an effect, deferred to a microtask before the first paint. Don't probe `matchMedia` synchronously in an effect (lint) or render the scheme server-side (hydration mismatch).

## API/UI constraints

- API: `POST /api/v1/unlock_challenge` (raw 52-byte body, raw credential out) and `GET /api/v1/credentials` (per loaded set: `name` + `productIdHash` only — never certificates/keys). The credential list itself is not shown in the UI (only the matched set name is, and the browser caches the list in `localStorage` with a 30-day TTL); the connect-time check matches the device's challenge hash against the cached list — it does NOT call `unlock_challenge`. Credentials via the `UNLOCK_CREDENTIALS` env var only.
