/**
 * Browser-only wrapper around `libfastboot` (the AOSP-faithful WebUSB
 * port of the AOSP fastboot host) for the WebUSB unlock tool.
 * Implements the device side of the Android Things
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
 *   relockVboot()            — `oem at-lock-vboot!`
 *   bootloaderUnlock()       — `fastboot flashing unlock` + wait for the
 *                              device to reboot back into fastboot
 *   bootloaderRelock()       — `fastboot flashing lock` + wait for the
 *                              device to reboot back into fastboot
 *
 * State variables (verified against a real MT8167 "amber" device):
 *   getvar at-vboot-state     -> "avb-locked=0" (unlocked) / "avb-locked=1"
 *   getvar bootloader-locked  -> "1" (locked) / "0" (unlocked)
 *   getvar warranty / unlocked-> boolean-ish ("yes"/"true" = unlocked,
 *                              fallbacks when `bootloader-locked` is absent)
 *
 * The `getChallenge()` staged-data read (the fastboot protocol "upload"
 * exchange, device -> host) and the `stageCredential()` write (the
 * "download"/`stage` exchange, host -> device) both go through
 * libfastboot's AOSP-faithful implementations: "upload" -> device
 * replies "DATA<8-hex>" + the bytes -> the device's final "OKAY";
 * "download:%08x" -> one continuous write of the whole buffer -> the
 * device's final "OKAY".
 *
 * `libfastboot` is SSR-safe (no top-level browser access), so this
 * module is safe to import from a "use client" component.
 */
import {
  logFastboot,
  setDebugLevel,
  FastbootDevice,
} from "@/lib/libfastboot";
import { CHALLENGE_STRUCT_SIZE } from "@/lib/avb-unlock";

/** A lock/unlock tri-state; "unknown" when the device doesn't expose it. */
export type LockState = "locked" | "unlocked" | "unknown";

export interface DeviceState {
  serial: string | null;
  product: string | null;
  bootloaderVersion: string | null;
  /** Verified-boot (AVB) state, from `getvar at-vboot-state`. */
  avb: LockState;
  /** Standard bootloader state, from `getvar bootloader-locked`, with
   *  boolean-ish `warranty`/`unlocked` as fallbacks. */
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
  /** `oem at-lock-vboot!` — re-lock verified boot. */
  relockVboot(): Promise<void>;
  /** `fastboot reboot` — the device leaves fastboot. The OKAY may
   *  never arrive (the connection drops first); a timeout is
   *  "rebooting", not an error. */
  reboot(): Promise<void>;
  /** `fastboot flashing unlock`, then wait for the reboot-into-fastboot
   *  (a no-op wait if the bootloader doesn't reboot). */
  bootloaderUnlock(): Promise<void>;
  /** `fastboot flashing lock`, then wait for the reboot-into-fastboot
   *  (a no-op wait if the bootloader doesn't reboot). */
  bootloaderRelock(): Promise<void>;
  /** Wait until the device is ready to accept fastboot commands again
   *  (a post-op state read can race a bootloader reboot). */
  waitReady(): Promise<void>;
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

/**
 * The bulk endpoint's maxPacketSize (diagnostic only — the staging
 * write is a single continuous transfer, like the fastboot CLI).
 * Falls back to 512 (the high-speed default) if the non-standard
 * USBDevice doesn't expose the configuration.
 */
function endpointMaxPacketSize(
  fb: FastbootDevice,
): { size: number; fromConfig: boolean } {
  for (const c of fb.device?.configurations ?? []) {
    for (const i of c.interfaces ?? []) {
      for (const a of i.alternates ?? i.alternateSettings ?? []) {
        for (const e of a.endpoints ?? []) {
          const size = e.packetSize ?? e.maxPacketSize;
          if (size && size > 0) return { size, fromConfig: true };
        }
      }
    }
  }
  return { size: 512, fromConfig: false };
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

/** Permissive boolean parse for fastboot variable values. */
function parseBool(s: string | null): boolean | null {
  if (s === null) return null;
  const v = s.toLowerCase();
  if (
    v === "yes" ||
    v === "true" ||
    v === "y" ||
    v === "t" ||
    v === "1" ||
    v === "on"
  )
    return true;
  if (
    v === "no" ||
    v === "false" ||
    v === "n" ||
    v === "f" ||
    v === "0" ||
    v === "off"
  )
    return false;
  return null;
}

/**
 * Reads the full device state. `at-vboot-state` is authoritative for the
 * AVB/verified-boot lock; when absent, an unlocked *standard bootloader*
 * implies AVB is unlocked too (a standard unlock on these devices
 * disables verified boot). Never infer "locked" from the bootloader
 * variable: it is documented that `bootloader-locked` stays `1` while
 * AVB is unlocked. For the standard bootloader, `bootloader-locked`
 * (0/1) is authoritative, with boolean-ish `warranty`/`unlocked` as
 * fallbacks (a re-lock that only flips some of these is still unlocked,
 * so any "on" value that is present wins).
 */
async function readState(fb: FastbootDevice): Promise<DeviceState> {
  const [serial, product, bootloaderVersion, vboot, blLocked, warranty, unlocked] =
    await Promise.all([
      safeGetVar(fb, "serialno"),
      safeGetVar(fb, "product"),
      safeGetVar(fb, "version-bootloader"),
      safeGetVar(fb, "at-vboot-state"),
      safeGetVar(fb, "bootloader-locked"),
      safeGetVar(fb, "warranty"),
      safeGetVar(fb, "unlocked"),
    ]);

  const blClean = clean(blLocked);
  let bootloader: LockState = "unknown";
  if (blClean === "0" || blClean === "1") {
    bootloader = blClean === "0" ? "unlocked" : "locked";
  } else {
    const state = parseBool(clean(warranty)) ?? parseBool(clean(unlocked));
    if (state !== null) {
      bootloader = state ? "unlocked" : "locked";
    }
  }

  const vbootClean = clean(vboot);
  const avbMatch = vbootClean?.match(/avb-locked\s*[:=]\s*([01])/);
  const avb: LockState = avbMatch
    ? avbMatch[1] === "0"
      ? "unlocked"
      : "locked"
    : bootloader === "unlocked"
      ? "unlocked"
      : "unknown";

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
  // libfastboot is SSR-safe (no top-level browser access), so the
  // old dynamic import is no longer needed.
  // Verbose library logging (every command + response) to the console,
  // to help diagnose bootloader protocol quirks.
  setDebugLevel(2);
  const fb = new FastbootDevice();

  if (opts?.auto) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const devices = await (navigator as any).usb.getDevices();
    if (!devices || devices.length !== 1) {
      throw new NoDeviceError();
    }
  }

  // libfastboot's connect() never resets the device (AOSP's Windows
  // Reset() is unsupported; a reset would drop the bootloader's
  // staged state).
  await fb.connect(opts?.auto ? { auto: true } : undefined);
  // Version marker: if this line is missing from the console, the
  // running bundle predates the current code (stale dev server or
  // production build) and the trace can't be trusted.
  logFastboot(
    "note",
    "unlock-tool v7 connected (libfastboot: AOSP-faithful fastboot host " +
      "over WebUSB; no reset; single continuous write; 30s response window)",
  );
  const mps = endpointMaxPacketSize(fb);
  logFastboot(
    "note",
    `endpoint maxPacketSize: ${mps.size}${mps.fromConfig ? "" : " (fallback)"}`,
  );
  return {
    getState: () => readState(fb),
    getChallenge: async () => {
      // Stages the 52-byte AvbCertUnlockChallenge on the device. Throws
      // on failure (e.g. "FAIL: only allow when locked").
      await fb.runCommand("oem at-get-vboot-unlock-challenge");
      const data = (await fb.upload()).bytes;
      if (data.length !== CHALLENGE_STRUCT_SIZE) {
        throw new Error(
          `staged challenge is ${data.length} bytes, expected ` +
            `${CHALLENGE_STRUCT_SIZE} (AvbCertUnlockChallenge)`,
        );
      }
      return data;
    },
    stageCredential: async (data, onProgress) => {
      try {
        // AOSP-faithful `download` sequence (libfastboot.download):
        // DownloadCommand -> one continuous write of the whole buffer
        // -> HandleResponse. Every transfer is time-boxed so a
        // desynced device fails with a clear error instead of
        // hanging the tool forever.
        await fb.download(data);
        if (onProgress) onProgress(1);
      } catch (e) {
        console.error("[fastboot] stage failed:", e);
        if (e instanceof Error && e.message.startsWith("timed out")) {
          throw new Error(
            `Staging the credential timed out [${e.message}] — the device ` +
              "did not respond. It is probably stuck in a bad state " +
              "(e.g. still waiting for a payload from a previously " +
              "failed stage; note a USB unplug/replug does NOT reset " +
              "the bootloader — power-cycle the device), then " +
              "reconnect and try again. See the console for the raw " +
              "exchange.",
          );
        }
        throw e;
      }
    },
    unlockVboot: async () => {
      await fb.runCommand("oem at-unlock-vboot");
    },
    relockVboot: async () => {
      await fb.runCommand("oem at-lock-vboot!");
    },
    reboot: async () => {
      // The device usually drops the connection before the OKAY
      // arrives; a timeout/disconnect here means "rebooting", not a
      // failure. The time-box also guards against a zombie read that
      // never settles.
      try {
        await withTimeout(fb.runCommand("reboot"), 10_000);
      } catch {
        console.warn(
          "[fastboot] reboot: no response before disconnect (expected)",
        );
      }
    },
    bootloaderUnlock: async () => {
      // A FAIL here (e.g. "refused on this build") means the device did
      // NOT reboot — it's still in fastboot, so rethrow as-is.
      await fb.runCommand("flashing unlock");
      await waitUntilReady(fb);
    },
    bootloaderRelock: async () => {
      await fb.runCommand("flashing lock");
      await waitUntilReady(fb);
    },
    waitReady: () => waitUntilReady(fb),
    close: async () => {
      try {
        await fb.close();
      } catch {
        // already released
      }
    },
  };
}

/**
 * Waits until the device is ready to accept fastboot commands again.
 *
 * `flashing unlock`/`lock` writes a persistent flag; on many devices the
 * bootloader reboots as part of that operation, which drops the USB
 * connection, and the bootloader re-enumerates a moment later. But not
 * all: on some (including MT8167 Android Things boards) the command
 * simply completes and the device stays connected in fastboot. So probe
 * the existing session first, and only wait for a reconnect (libfastboot
 * polls for the re-appearing device and re-opens it) if the device
 * actually went away. If it doesn't come back within the window, throw
 * ReconnectError so the caller can reset to the idle state.
 */
async function waitUntilReady(fb: FastbootDevice): Promise<void> {
  // The command may still be finalizing on the device side (e.g. a
  // "Start unlock flow" pause), so probe a few times before concluding
  // the device rebooted.
  for (let attempt = 0; attempt < 10; attempt++) {
    let timedOut = false;
    try {
      await withTimeout(fb.getVariable("serialno"), 2000);
      // Still in fastboot and answering: nothing to wait for.
      return;
    } catch (e) {
      timedOut = e instanceof Error && e.message === "timed out";
    }
    if (!timedOut) break; // USB/protocol error: connection is gone
    // Timeout: if the USB device is already gone, stop probing and fall
    // through to the reconnect wait.
    if (fb.device == null || fb.device.connected === false) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    await withTimeout(fb.waitForConnect(), RECONNECT_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof Error && e.message === "timed out") {
      throw new ReconnectError();
    }
    throw e;
  }
}


