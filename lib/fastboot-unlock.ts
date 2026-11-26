/**
 * Browser-only wrapper around `libfastboot` for the WebUSB unlock
 * tool: the device side of the Android Things authenticated-AVB
 * unlock (mirrors `at_auth_unlock.py`'s fastboot calls) plus the
 * standard bootloader lock/unlock — see `FastbootSession` for the
 * operations.
 *
 * State variables (verified against a real MT8167 "amber" device):
 *   getvar at-vboot-state    -> "avb-locked=0" (unlocked) / "avb-locked=1"
 *   getvar bootloader-locked -> "1" (locked) / "0" (unlocked)
 *   getvar warranty/unlocked -> boolean-ish fallbacks when
 *   `bootloader-locked` is absent
 *
 * `libfastboot` is SSR-safe (no top-level browser access), so this
 * module is safe to import from a "use client" component.
 */
import {
  logFastboot,
  setDebugLevel,
  withTimeout,
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
 * Reads the full device state. `at-vboot-state` is authoritative for
 * the AVB lock; when absent, an unlocked standard bootloader implies
 * AVB is unlocked too (a standard unlock on these devices disables
 * verified boot). Never infer "locked" from `bootloader-locked`: it
 * stays `1` while AVB is unlocked. For the standard bootloader,
 * `bootloader-locked` (0/1) wins, with boolean-ish `warranty`/`unlocked`
 * fallbacks (any present "on" value wins).
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
  // Verbose library logging (every command + response) to the console.
  setDebugLevel(2);
  const fb = new FastbootDevice();

  if (opts?.auto) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const devices = await (navigator as any).usb.getDevices();
    if (!devices || devices.length !== 1) {
      throw new NoDeviceError();
    }
  }

  // Never resets the device: a reset would drop the bootloader's
  // staged state.
  await fb.connect(opts?.auto ? { auto: true } : undefined);
  // Version marker: if this line is missing, the running bundle
  // predates the current code and the trace can't be trusted.
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
        // AOSP-faithful `download`: DownloadCommand -> one continuous
        // write of the whole buffer -> HandleResponse.
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
      // failure.
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
 * `flashing unlock`/`lock` reboots the bootloader on many devices (the
 * USB drops, then re-enumerates), but on some — including MT8167
 * Android Things boards — it completes without a reboot. So probe the
 * existing session first and only wait for a reconnect (libfastboot
 * polls for the re-appearing device and re-opens it) if the device
 * actually went away; if it doesn't come back within the window, throw
 * ReconnectError so the caller can reset to idle.
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


