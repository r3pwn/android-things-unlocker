#!/usr/bin/env node
/**
 * Host-side (node-usb / libusb) run of the Android Things AVB-unlock
 * flow — a diagnostic mirror of the browser WebUSB tool, using the
 * same driver mode the fastboot CLI uses (which completes the
 * `download`/stage step in ~20 ms on this board).
 *
 * Flow (mirrors the browser tool and at_auth_unlock.py):
 *   getvar state
 *   -> oem at-get-vboot-unlock-challenge  (upload handshake reads 52 B)
 *   -> POST /api/v1/unlock_challenge      (raw 52 B -> raw credential)
 *   -> download:<size>                    (stage the credential, one write)
 *   -> oem at-unlock-vboot
 *   -> re-read state
 *
 * Usage:
 *   node scripts/stage-cli.mjs --api http://localhost:3000 [--token TOKEN]
 *                             [--reset] [--no-unlock] [--file cred.bin]
 *                             [--vid 0bb4 --pid 0c01] [--usbdk]
 *                             [--dummy | --file-in cred.bin] [--timeout N]
 *
 * Stage-only mode: --dummy stages a random 3756-byte payload (the real
 * credential size) with no challenge, no API, and no unlock; --file-in
 * stages the given file instead. Useful on an already-unlocked device.
 * --timeout N gives the payload write a finite endpoint transfer timeout
 * in ms (default 0 = infinite, the node-usb default).
 *
 * IMPORTANT: close the browser page first — WebUSB holds the device
 * exclusively. If the stage step fails, the bootloader is left
 * desynced: POWER-CYCLE the device before retrying (a USB replug does
 * NOT reset the bootloader).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { usb } from "usb";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(`--${name}`);
if (flag("help") || !argv.length) {
  console.log(
    "usage: node scripts/stage-cli.mjs --api URL [--token TOKEN] " +
      "[--reset] [--no-unlock] [--file cred.bin] [--list] " +
      "[--vid XXXX --pid YYYY] [--usbdk] " +
      "[--dummy | --file-in cred.bin] [--timeout N]",
  );
  process.exit(argv.length ? 0 : 1);
}
const apiUrl = (opt("api") ?? "http://localhost:3000").replace(/\/$/, "");
const token = opt("token");
const doReset = flag("reset");
const doUnlock = !flag("no-unlock");
const outFile = opt("file");
const useUsbDk = flag("usbdk");
const dummy = flag("dummy");
const fileIn = opt("file-in");
const xferTimeout = opt("timeout")
  ? Number.parseInt(opt("timeout"), 10)
  : 0;

const log = (...a) => console.log("[stage-cli]", ...a);

function describeDevice(d) {
  const dd = d.deviceDescriptor ?? {};
  const x = (n, w = 2) => (n ?? 0).toString(16).padStart(w, "0");
  const lines = [
    `  vid=0x${x(dd.idVendor, 4)} pid=0x${x(dd.idProduct, 4)} ` +
      `class=0x${x(dd.bDeviceClass)}/0x${x(dd.bDeviceSubClass)}/0x${x(dd.bDeviceProtocol)}`,
  ];
  for (const [i, iface] of (d.interfaces ?? []).entries()) {
    const id = iface.descriptor ?? {};
    lines.push(
      `  iface[${i}] class=0x${x(id.bInterfaceClass)}/0x${x(id.bInterfaceSubClass)}/0x${x(id.bInterfaceProtocol)}` +
        (iface.endpoints?.length
          ? ` endpoints=${iface.endpoints
              .map((e) => `${e.direction}@0x${x(e.descriptor.bEndpointAddress)}`)
              .join(", ")}`
          : ""),
    );
  }
  return lines.join("\n");
}

function dumpDevices() {
  const all = usb.getDeviceList();
  log(`found ${all.length} USB device(s)`);
  for (const d of all) console.log(describeDevice(d));
  return all;
}
const hex = (b, cap = 64) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const s = buf
    .subarray(0, cap)
    .toString("hex")
    .replace(/(.{2})/g, "$1 ")
    .trim();
  return buf.length > cap ? `${s} …(+${buf.length - cap} bytes)` : s;
};
const dec = new TextDecoder();

function withWatch(p, ms, label) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out in ${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}

if (flag("list")) {
  dumpDevices();
  process.exit(0);
}

async function main() {
  if (useUsbDk) usb.useUsbDkBackend();

  // --- connect (same sequence as the browser library) ---
  log("enumerating USB devices...");
  const all = usb.getDeviceList();
  const parseId = (s) => parseInt(s.startsWith("0x") ? s : `0x${s}`, 16);
  const vid = opt("vid") ? parseId(opt("vid")) : undefined;
  const pid = opt("pid") ? parseId(opt("pid")) : undefined;
  // Device-level fastboot class (some devices report it here; this board
  // uses interface-level classing with a 0x00 device class).
  const isFastbootClass = (d) => {
    const dd = d.deviceDescriptor;
    return !!(
      dd &&
      dd.bDeviceClass === 0xff &&
      dd.bDeviceSubClass === 0x42 &&
      dd.bDeviceProtocol === 0x03
    );
  };
  let device =
    (vid !== undefined &&
      pid !== undefined &&
      all.find(
        (d) =>
          d.deviceDescriptor.idVendor === vid &&
          d.deviceDescriptor.idProduct === pid,
      )) ||
    all.find(isFastbootClass) ||
    null;
  if (!device) {
    // Interface-level classing: `device.interfaces` is only populated
    // after open(), so open each candidate (no claim — non-destructive),
    // check the interface descriptor, and close again.
    log("no device-level 0xff/0x42/0x03 match; probing interface classes...");
    for (const d of all) {
      try {
        d.open();
        const id = d.interfaces?.[0]?.descriptor;
        const match = !!(
          id &&
          id.bInterfaceClass === 0xff &&
          id.bInterfaceSubClass === 0x42 &&
          id.bInterfaceProtocol === 0x03
        );
        d.close();
        if (match) {
          device = d;
          break;
        }
      } catch {
        // held by another driver or unopenable; skip
      }
    }
  }
  if (!device) {
    console.error("No fastboot device found (class 0xff/0x42/0x03).");
    console.error(`All ${all.length} USB device(s) seen:`);
    for (const d of all) console.error(describeDevice(d));
    console.error(
      "If the device is in fastboot mode but the probe above missed it, " +
        "target it explicitly with --vid/--pid (Device Manager shows e.g. " +
        "USB\\VID_0BB4&PID_0C01). If open/claim then fails with an access " +
        "error, the driver is not WinUSB — re-run with --usbdk, or switch " +
        "the device to the WinUSB driver (Zadig) first.",
    );
    process.exit(1);
  }
  const dd = device.deviceDescriptor;
  log(
    `device: vid=0x${dd.idVendor.toString(16).padStart(4, "0")} ` +
      `pid=0x${dd.idProduct.toString(16).padStart(4, "0")}`,
  );

  device.open(); // auto-configures (default configuration 1)
  if (doReset) {
    log("resetting device (port reset, mirroring the browser library)");
    await withWatch(
      new Promise((res, rej) => device.reset((e) => (e ? rej(e) : res()))),
      10_000,
      "reset",
    );
  }
  const iface = device.interfaces[0];
  try {
    iface.claim();
  } catch (e) {
    console.error(`Could not claim the interface: ${e.message}`);
    console.error(
      "If a browser page is open with this device (WebUSB), close it " +
        "first — WebUSB holds the device exclusively. If the access error " +
        "persists with no page open, the device's driver is not WinUSB: " +
        "re-run with --usbdk, or switch the device to WinUSB (Zadig) first.",
    );
    process.exit(1);
  }
  const bulk = iface.endpoints.filter(
    (e) => e.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK,
  );
  const epOut = bulk.find((e) => e.direction === "out");
  const epIn = bulk.find((e) => e.direction === "in");
  if (!epOut || !epIn) throw new Error("bulk in/out endpoints not found");
  log(
    `endpoints: out=0x${epOut.descriptor.bEndpointAddress
      .toString(16)
      .padStart(2, "0")} in=0x${epIn.descriptor.bEndpointAddress
      .toString(16)
      .padStart(2, "0")} maxPacketSize=${epOut.descriptor.wMaxPacketSize}`,
  );

  // --- transfer helpers (JS watch-dog; libusb itself has infinite timeout,
  // and on timeout the process exits, dropping the pending URB) ---
  const outWrite = (bytes, ms, label) =>
    withWatch(
      new Promise((res, rej) =>
        epOut.transfer(Buffer.from(bytes), (e) => (e ? rej(e) : res()))),
      ms,
      label,
    );
  const inRead = (len, ms, label) =>
    withWatch(
      new Promise((res, rej) =>
        epIn.transfer(len, (e, data) => (e ? rej(e) : res(data)))),
      ms,
      label,
    );
  const cmd = (text, ms = 10_000) => {
    log(`host>>> ${text}`);
    return outWrite(new TextEncoder().encode(text), ms, text);
  };

  // Command response: "OKAY <value>" ends; "INFO <line>" continues;
  // "FAIL" is an error. (Same semantics as the fastboot library's
  // _readResponse.)
  async function readCommandResponse() {
    let text = "";
    let status;
    do {
      const buf = await inRead(64, 10_000, "response");
      const t = dec.decode(buf);
      status = t.substring(0, 4);
      const msg = t.substring(4);
      log(`<<<device ${JSON.stringify((status + msg).trim())} | ${hex(buf)}`);
      if (status === "FAIL")
        throw new Error(`Bootloader replied with FAIL: ${msg}`);
      if (status === "OKAY") text += msg;
      else if (status === "INFO") text += msg + "\n";
      else throw new Error(`unexpected response status: ${status}`);
    } while (status === "INFO");
    return text.trim();
  }
  const getVar = async (name) => {
    await cmd(`getvar:${name}`);
    const v = await readCommandResponse();
    return v || "(empty)";
  };

  // --- state ---
  log("== state ==");
  const serial = await getVar("serialno");
  const product = await getVar("product");
  const vboot = await getVar("at-vboot-state");
  const blLocked = await getVar("bootloader-locked");
  log(`serial=${serial} product=${product} at-vboot-state=${vboot} bootloader-locked=${blLocked}`);

  // --- payload source: challenge + API (full flow), or stage-only ---
  let payload;
  const stageOnly = !!(dummy || fileIn);
  if (stageOnly) {
    log("== stage-only ==");
    if (fileIn) {
      payload = readFileSync(fileIn);
      log(`note payload from ${fileIn} (${payload.length} bytes)`);
    } else {
      payload = randomBytes(3756); // real credential size (0x00000eac)
      log("note payload: 3756 random bytes (real credential size)");
    }
  } else {
    // --- challenge (oem command, then the fastboot "upload" read-back) ---
    log("== challenge ==");
    await cmd("oem at-get-vboot-unlock-challenge");
    await readCommandResponse();
    await cmd("upload");
    let size;
    for (;;) {
      const buf = await inRead(64, 10_000, "upload-ack");
      const t = dec.decode(buf);
      const s = t.substring(0, 4);
      log(`<<<device ${JSON.stringify(t.trim())} | ${hex(buf)}`);
      if (s === "FAIL")
        throw new Error(`Bootloader replied with FAIL: ${t.substring(4)}`);
      if (s === "OKAY")
        throw new Error('no staged data (upload response: "OKAY")');
      if (s === "DATA") {
        size = parseInt(t.substring(4), 16);
        break;
      }
      // INFO lines are skipped.
    }
    const challenge = await inRead(size, 10_000, "upload-data");
    await cmd("OKAY", 10_000); // completes the upload handshake
    log(`note challenge (${challenge.length} bytes): ${hex(challenge)}`);
    if (challenge.length !== 52)
      throw new Error(`challenge is ${challenge.length} bytes, expected 52`);

    // --- API: raw 52-byte challenge -> raw credential ---
    log("== api ==");
    log(`POST ${apiUrl}/api/v1/unlock_challenge (raw ${challenge.length} bytes)`);
    const res = await fetch(`${apiUrl}/api/v1/unlock_challenge`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: new Uint8Array(challenge),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = `${j.error} — ${j.detail ?? ""}`;
      } catch {
        detail = "(no JSON body)";
      }
      throw new Error(`API ${res.status}: ${detail}`);
    }
    const matchedSet = res.headers.get("x-matched-credential-set");
    payload = Buffer.from(await res.arrayBuffer());
    log(
      `note credential (${payload.length} bytes) from set "${matchedSet ?? "?"}"`,
    );
    if (outFile) {
      writeFileSync(outFile, payload);
      log(`note wrote ${outFile}`);
    }
  }

  // --- stage: the diagnostic core. One continuous write, exactly like
  // the fastboot CLI — libusb keeps the URB pending and the host
  // re-polls NAK'd packets, which is what drives this bootloader to
  // process each 1024-byte FIFO chunk. ---
  log("== stage ==");
  await cmd(`download:${payload.length.toString(16).padStart(8, "0")}`);
  const ackBuf = await inRead(64, 10_000, "download-ack");
  const ackT = dec.decode(ackBuf);
  log(`<<<device ${JSON.stringify(ackT.trim())} | ${hex(ackBuf)}`);
  const ackS = ackT.substring(0, 4);
  if (ackS === "FAIL")
    throw new Error(`Bootloader replied with FAIL: ${ackT.substring(4)}`);
  if (ackS !== "OKAY" && ackS !== "DATA")
    throw new Error(`unexpected download ack: ${ackT.trim()}`);
  const t0 = Date.now();
  if (xferTimeout > 0) {
    epOut.timeout = xferTimeout;
    log(`note endpoint transfer timeout set to ${xferTimeout} ms`);
  }
  log(
    `host>>> payload: single continuous write of ${payload.length} bytes (120s watch-dog)`,
  );
  await outWrite(payload, 120_000, "download-payload");
  log(`payload complete in ${Date.now() - t0} ms`);

  // Final status: 5 s window for the device OKAY; if silent, send the
  // host "OKAY" (old-style) and keep waiting to a 30 s deadline — same
  // as the browser tool.
  const deadline = Date.now() + 30_000;
  let sentHostAck = false;
  for (;;) {
    let buf;
    try {
      buf = await inRead(
        64,
        sentHostAck ? Math.max(1000, deadline - Date.now()) : 5000,
        "download-final-okay",
      );
    } catch (e) {
      if (!sentHostAck && Date.now() < deadline) {
        log("host>>> OKAY (post-payload, old-style ack)");
        await outWrite(
          new TextEncoder().encode("OKAY"),
          10_000,
          "download-host-ack",
        );
        sentHostAck = true;
        continue;
      }
      throw e;
    }
    const t = dec.decode(buf);
    const s = t.substring(0, 4);
    log(`<<<device ${JSON.stringify(t.trim())} | ${hex(buf)}`);
    if (s === "OKAY") break;
    if (s === "FAIL")
      throw new Error(`Bootloader replied with FAIL: ${t.substring(4)}`);
    // INFO/DATA lines are skipped; keep waiting.
  }
  log("note STAGED — download accepted");

  // --- unlock (full flow only) ---
  if (doUnlock && !stageOnly) {
    log("== unlock ==");
    await cmd("oem at-unlock-vboot");
    await readCommandResponse();
    log("note at-unlock-vboot accepted");
  }

  // --- final state ---
  log("== final state ==");
  const vboot2 = await getVar("at-vboot-state");
  const blLocked2 = await getVar("bootloader-locked");
  log(`at-vboot-state=${vboot2} bootloader-locked=${blLocked2}`);
  console.log(
    stageOnly
      ? "\nSTAGE COMPLETE (stage-only)"
      : doUnlock
        ? "\nUNLOCK COMPLETE"
        : "\nSTAGE COMPLETE (--no-unlock; run the unlock manually)",
  );
  try {
    device.close();
  } catch {
    // best effort
  }
}

main().catch((e) => {
  console.error(`\n[stage-cli] FAILED: ${e.message ?? e}`);
  console.error(
    "If this failed mid-payload, the bootloader is desynced (part of the " +
      "declared size received). POWER-CYCLE the device (a USB replug does " +
      "NOT reset the bootloader), then retry.",
  );
  process.exit(1);
});
