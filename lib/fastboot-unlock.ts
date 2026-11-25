/**
 * Browser-only wrapper around `android-fastboot` for the WebUSB unlock
 * tool. Implements the device side of the Android Things
 * authenticated-AVB-unlock (the mirror image of `at_auth_unlock.py`'s
 * fastboot calls) plus the standard bootloader lock/unlock:
 *
 *   connect()                  — open the fastboot USB device
 *   getState()                — serial, product, bootloader version, and
 *                              the AVB + standard-bootloader lock state
 *   getChallenge()            — `oem at-get-vboot-unlock-challenge` +
 *                              read the staged 52-byte
 *                              AvbCertUnlockChallenge
 *   stageCredential(bytes)    — `fastboot stage <credential>`
 *   unlockVboot()            — `oem at-unlock-vboot`
 *   relockVboot()            — `oem at-lock-vboot`
 *   bootloaderUnlock()       — `fastboot flashing unlock` + wait for the
 *                              device to reboot back into fastboot
 *   bootloaderRelock()       — `fastboot flashing lock` + wait for the
 *                              device to reboot back into fastboot
 *
 * State variables (verified against a real MT8167 "amber" device):
 *   getvar at-vboot-state     -> "avb-locked=0" (unlocked) / "avb-locked=1"
 *   getvar bootloader-locked  -> "1" (locked) / "0" (unlocked)
 *   getvar warranty           -> "yes" (bootloader unlocked; fallback)
 *
 * `getChallenge()`'s staged-data read is done at the raw WebUSB level
 * because the library's high-level API only covers host -> device data
 * (flashing). The fastboot protocol "upload" exchange (device -> host)
 * is: host sends "upload" -> the device replies "DATA<8-hex>" and then
 * sends the bytes -> the host confirms with "OKAY" — the same sequence
 * the AOSP fastboot host uses for `get_staged`.
 *
 * BROWSER ONLY: `android-fastboot` is imported dynamically inside
 * connectFastboot(), so this module is safe to import from a
 * "use client" component without SSR issues (the package is never
 * evaluated outside the browser).
 */
import type { FastbootDevice } from "android-fastboot";
import { CHALLENGE_STRUCT_SIZE } from "@/lib/avb-unlock";

/** A lock/unlock tri-state; "unknown" when the device doesn't expose it. */
export type LockState = "locked" | "unlocked" | "unknown";

export interface DeviceState {
  serial: string | null;
  product: string | null;
  bootloaderVersion: string | null;
  /** Verified-boot (AVB) state, from `getvar at-vboot-state`. */
  avb: LockState;
  /** Standard bootloader state, from `getvar bootloader-locked`/`warranty`. */
  bootloader: LockState;
}

/**
 * Thrown when `flashing unlock`/`lock` succeeded but the device did not
 * come back into fastboot within the reconnect window (e.g. it booted
 * into the OS). The caller should reset to the idle "waiting" state.
 */
export class ReconnectError extends Error {
  constructor() {
    super("device did not return to fastboot");
    this.name = "ReconnectError";
  }
}

/** A sentinel for "no fastboot device is paired/connected" (auto mode). */
export class NoDeviceError extends Error {
  constructor() {
    super("no fastboot device");
    this.name = "NoDeviceError";
  }
}

export interface FastbootSession {
  /** Read identification + lock state (re-validates the connection). */
  getState(): Promise<DeviceState>;
  /** `oem at-get-vboot-unlock-challenge` + read the staged challenge. */
  getChallenge(): Promise<Uint8Array>;
  /** `fastboot stage <data>` — host -> device data phase. */
  stageCredential(
    data: Uint8Array,
    onProgress?: (p: number) => void,
  ): Promise<void>;
  /** `oem at-unlock-vboot` — consume the staged credential. */
  unlockVboot(): Promise<void>;
  /** `oem at-lock-vboot` — re-lock verified boot. */
  relockVboot(): Promise<void>;
  /** `fastboot flashing unlock`, then wait for the reboot-into-fastboot. */
  bootloaderUnlock(): Promise<void>;
  /** `fastboot flashing lock`, then wait for the reboot-into-fastboot. */
  bootloaderRelock(): Promise<void>;
  /** Release the device (best effort). */
  close(): Promise<void>;
}

export function webUsbAvailable(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

const RECONNECT_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function safeGetVar(
  fb: FastbootDevice,
  name: string,
): Promise<string | null> {
  try {
    return await fb.getVariable(name);
  } catch {
    // A missing/unsupported variable shouldn't fail the whole read.
    return null;
  }
}

/** Strip a leading "name:" prefix some bootloaders include, then trim. */
function clean(s: string | null): string | null {
  if (s === null) return null;
  const t = s.replace(/^[a-z0-9_-]+:\s*/i, "").trim();
  return t === "" ? null : t;
}

/**
 * Reads the full device state. `at-vboot-state` is authoritative for the
 * AVB/verified-boot lock; `bootloader-locked` (0/1) is authoritative for
 * the standard bootloader, with `warranty` as a fallback (a re-lock that
 * only flips `unlocked`/`secure` but leaves `warranty: yes` is still
 * unlocked, so `warranty` is the real marker).
 */
async function readState(fb: FastbootDevice): Promise<DeviceState> {
  const [serial, product, bootloaderVersion, vboot, blLocked, warranty] =
    await Promise.all([
      safeGetVar(fb, "serialno"),
      safeGetVar(fb, "product"),
      safeGetVar(fb, "version-bootloader"),
      safeGetVar(fb, "at-vboot-state"),
      safeGetVar(fb, "bootloader-locked"),
      safeGetVar(fb, "warranty"),
    ]);

  const vbootClean = clean(vboot);
  const avbMatch = vbootClean?.match(/avb-locked\s*[:=]\s*([01])/);
  const avb: LockState = avbMatch
    ? avbMatch[1] === "0"
      ? "unlocked"
      : "locked"
    : "unknown";

  const blClean = clean(blLocked);
  let bootloader: LockState = "unknown";
  if (blClean === "0" || blClean === "1") {
    bootloader = blClean === "0" ? "unlocked" : "locked";
  } else if (clean(warranty) === "yes") {
    bootloader = "unlocked";
  }

  return {
    serial: clean(serial),
    product: clean(product),
    bootloaderVersion: clean(bootloaderVersion),
    avb,
    bootloader,
  };
}

/**
 * Opens the fastboot device (prompting the user to pick it unless a
 * single device is already paired) and returns a session.
 *
 * With `{ auto: true }` (used for the mount-time auto-connect), it does
 * NOT prompt: if there isn't exactly one already-paired+connected device
 * it throws NoDeviceError instead, so the page can show the idle
 * "waiting for fastboot device" state.
 */
export async function connectFastboot(opts?: {
  auto?: boolean;
}): Promise<FastbootSession> {
  // Dynamic import: keeps the WebUSB-only package out of SSR/Node.
  const { FastbootDevice } = await import("android-fastboot");
  const fb = new FastbootDevice();

  if (opts?.auto) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const devices = await (navigator as any).usb.getDevices();
    if (!devices || devices.length !== 1) {
      throw new NoDeviceError();
    }
  }

  await fb.connect();
  return {
    getState: () => readState(fb),
    getChallenge: async () => {
      // Stages the 52-byte AvbCertUnlockChallenge on the device. Throws
      // FastbootError (e.g. "only allow when locked") on failure.
      await fb.runCommand("oem at-get-vboot-unlock-challenge");
      const data = await readStaged(fb);
      if (data.length !== CHALLENGE_STRUCT_SIZE) {
        throw new Error(
          `staged challenge is ${data.length} bytes, expected ` +
            `${CHALLENGE_STRUCT_SIZE} (AvbCertUnlockChallenge)`,
        );
      }
      return data;
    },
    stageCredential: async (data, onProgress) => {
      // ArrayBuffer (the library API's shape); detach from the caller's
      // buffer so the upload can't race with UI reads.
      const ab = new ArrayBuffer(data.byteLength);
      new Uint8Array(ab).set(data);
      // The "partition" argument is log-only in the library; the wire
      // command is `download:<8-hex>` — the same operation behind
      // `fastboot stage`/`download`.
      await fb.upload("stage", ab, onProgress);
    },
    unlockVboot: async () => {
      await fb.runCommand("oem at-unlock-vboot");
    },
    relockVboot: async () => {
      await fb.runCommand("oem at-lock-vboot");
    },
    bootloaderUnlock: async () => {
      // A FAIL here (e.g. "refused on this build") means the device did
      // NOT reboot — it's still in fastboot, so rethrow as-is.
      await fb.runCommand("flashing unlock");
      await waitForReconnect(fb);
    },
    bootloaderRelock: async () => {
      await fb.runCommand("flashing lock");
      await waitForReconnect(fb);
    },
    close: async () => {
      try {
        await fb.close();
      } catch {
        // already released
      }
      // The library's close() is a no-op; actually release the WebUSB
      // device so "Disconnect" is meaningful and the next "Connect"
      // re-prompts (a released device isn't in getDevices()).
      const d = fb.device;
      if (d && typeof d.release === "function") {
        try {
          await d.release();
        } catch {
          // already gone
        }
      }
    },
  };
}

/**
 * `flashing unlock`/`lock` reboots the device, which drops the USB
 * connection; the bootloader re-enumerates a moment later. Wait for that
 * reconnect (the library's global USB "connect" listener re-validates and
 * re-opens the endpoints). If it doesn't come back within the window,
 * throw ReconnectError so the caller can reset to the idle state.
 */
async function waitForReconnect(fb: FastbootDevice): Promise<void> {
  try {
    await withTimeout(fb.waitForConnect(), RECONNECT_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof Error && e.message === "timed out") {
      throw new ReconnectError();
    }
    throw e;
  }
}

/**
 * Reads the data staged by the previous command (the fastboot protocol
 * "upload" direction, i.e. `fastboot get_staged`):
 *
 *   host -> "upload"
 *   device -> "DATA<8-hex size>"  (read by the library's runCommand)
 *   device -> <size bytes>        (read here, raw)
 *   host -> "OKAY"
 *
 * The library's runCommand() reads the DATA header but deliberately
 * ignores the payload, so the bytes are read directly from the bulk-in
 * endpoint (the class stores the UsbDevice/endpoints as plain
 * properties).
 */
async function readStaged(fb: FastbootDevice): Promise<Uint8Array> {
  const resp = await fb.runCommand("upload");
  if (resp.dataSize === undefined) {
    throw new Error(
      `no staged data (upload response: "${resp.text || "OKAY"}")`,
    );
  }
  const size = parseInt(resp.dataSize, 16);
  if (!Number.isFinite(size) || size <= 0 || size > 65536) {
    throw new Error(`invalid staged data size: "${resp.dataSize}"`);
  }
  if (!fb.device || fb.epIn === null || fb.epOut === null) {
    throw new Error("USB device not connected");
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < size) {
    const packet = await fb.device.transferIn(fb.epIn, size - received);
    const bytes = new Uint8Array(packet.data.slice(0));
    if (bytes.length === 0) {
      throw new Error("short read while receiving staged data");
    }
    chunks.push(bytes);
    received += bytes.length;
  }
  await fb.device.transferOut(fb.epOut, new TextEncoder().encode("OKAY"));
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
