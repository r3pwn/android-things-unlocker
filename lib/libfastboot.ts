/**
 * libfastboot.ts — a faithful WebUSB port of the AOSP fastboot host
 * (platform/system/core/fastboot, `main`): the protocol layer of
 * fastboot_driver.cpp with the usb transport semantics of
 * usb_windows.cpp / usb_linux.cpp.
 *
 * Ported one-to-one (one transfer per call — no chunking, no re-poll,
 * no ZLP — "ioctl on 0-length buffer causes freezing"):
 *   UsbTransport::Write/Read  one bulk-OUT / bulk-IN of the whole
 *                            buffer (a short read is an error, as in
 *                            ReadBuffer)
 *   RawCommand                one write of the exact command bytes (no
 *                            trailing newline), then HandleResponse
 *   DownloadCommand           "download:%08x" (8-hex, zero-padded),
 *                            SendBuffer, then the device's final status
 *   RunAndReadBuffer          "upload" -> DATA<size> -> read exactly
 *                            `size` bytes (1 MiB chunks) ->
 *                            HandleResponse. No host "OKAY" is sent
 *                            (AOSP doesn't; the device sends its final
 *                            status itself)
 *   HandleResponse            256-byte status reads within a 30 s
 *                            window, resetting on INFO/TEXT;
 *                            OKAY/FAIL/DATA end it
 *   usb_open                  match interface 0xff/0x42/0x03 (bulk in +
 *                            out), open the default pipes; never reset
 *                            (a reset would drop the bootloader's
 *                            staged state)
 *
 * Non-AOSP (safety layer): every transfer is time-boxed (aborted via
 * the WebUSB EventTarget API when available) so a desynced device
 * fails with a clear error instead of hanging the tool; console
 * tracing of the raw wire exchange; the reconnect wait.
 *
 * SSR-safe: no top-level browser access, so it can be imported from
 * "use client" modules without a dynamic import.
 */

/** AOSP fastboot_driver.h: FB_RESPONSE_SZ. */
const FB_RESPONSE_SZ = 256;
/** AOSP fastboot_driver.h: FB_COMMAND_SZ. */
const FB_COMMAND_SZ = 4096;
/** AOSP fastboot_driver.h: RESP_TIMEOUT (30 seconds). */
const RESP_TIMEOUT_MS = 30_000;
/** Tool window for the payload write (AOSP's own is 5 s on Windows). */
const PAYLOAD_WRITE_MS = 60_000;
/** Tool window for short (command/ack) writes. */
const CMD_WRITE_MS = 10_000;
/** AOSP RunAndReadBuffer read chunk size (1 MiB). */
const READ_CHUNK = 1024 * 1024;

let debugLevel = 0;

/** 0 = errors only, 2 = verbose (every command + response). */
export function setDebugLevel(level: number): void {
  debugLevel = level;
}

function verbose(): boolean {
  return debugLevel >= 2;
}

/** Console trace of the raw fastboot wire exchange (diagnostic aid). */
export function logFastboot(
  dir: "host>>>" | "<<<device" | "note",
  detail: string,
): void {
  console.log(`[fastboot] ${dir} ${detail}`);
}

/** Hex dump for console logging (capped so large payloads don't flood it). */
export function hexBytes(bytes: Uint8Array, cap = 128): string {
  const slice = bytes.slice(0, cap);
  let out = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
  if (bytes.length > cap) out += ` …(+${bytes.length - cap} bytes)`;
  return out;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
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
 * Normalizes a WebUSB `transferIn` payload. The spec says `data` is an
 * ArrayBuffer, but be permissive about whatever BufferSource the runtime
 * actually hands us (some implementations deliver a typed view instead);
 * anything else is a programming error, so throw with the actual type
 * for diagnosis.
 */
function normalizeTransferData(raw: unknown): Uint8Array {
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    const v = raw as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    raw instanceof SharedArrayBuffer
  ) {
    return new Uint8Array(raw);
  }
  throw new Error(
    `unexpected transfer data type: ${Object.prototype.toString.call(raw)}`,
  );
}

interface UsbTransferResult {
  data: unknown;
  status?: string;
}

/**
 * The raw WebUSB USBDevice surface this port uses. Typed loosely
 * (instead of @types/w3c-web-usb) so it works with non-standard
 * implementations as well.
 */
export interface RawUsbDevice {
  opened?: boolean;
  connected?: boolean;
  transferIn(ep: number, length: number): Promise<UsbTransferResult>;
  transferOut(ep: number, data: Uint8Array): Promise<UsbTransferResult>;
  addEventListener?(type: string, listener: (e: Event) => void): void;
  removeEventListener?(type: string, listener: (e: Event) => void): void;
  abortTransfer?(transfer: unknown): void;
  open?(): Promise<void>;
  selectConfiguration?(index: number): Promise<void>;
  claimInterface?(index: number): Promise<void>;
  release?(): Promise<void>;
  deviceClass?: number;
  deviceSubclass?: number;
  deviceProtocol?: number;
  configurations?: {
    configurationValue?: number;
    interfaces?: {
      id?: number;
      interfaceNumber?: number;
      alternates?: RawUsbAlternateLike[];
      // Legacy spec name, for older implementations
      alternateSettings?: RawUsbAlternateLike[];
    }[];
  }[];
}

/**
 * USBAlternateInterface (current spec names interfaceClass/...;
 * legacy names class/subclass/protocol also accepted).
 */
interface RawUsbAlternateLike {
  interfaceClass?: number;
  interfaceSubclass?: number;
  interfaceProtocol?: number;
  class?: number;
  subclass?: number;
  protocol?: number;
  endpoints?: RawUsbEndpointLike[];
}

/**
 * USBEndpoint (current spec: endpointNumber/packetSize; legacy
 * names number/maxPacketSize also accepted).
 */
interface RawUsbEndpointLike {
  endpointNumber?: number;
  number?: number;
  direction: "in" | "out";
  type?: string;
  packetSize?: number;
  maxPacketSize?: number;
}

type RawUsbConfigurationLike = NonNullable<
  RawUsbDevice["configurations"]
>[number];
type RawUsbInterfaceLike = NonNullable<
  RawUsbConfigurationLike["interfaces"]
>[number];

/** The interface's alternates (current spec name, legacy fallback). */
function alternatesOf(i: RawUsbInterfaceLike): RawUsbAlternateLike[] {
  return i.alternates ?? i.alternateSettings ?? [];
}

function interfaceNumberOf(i: RawUsbInterfaceLike): number {
  return i.interfaceNumber ?? i.id ?? 0;
}

function isFastbootAlternate(a: RawUsbAlternateLike): boolean {
  return (
    (a.interfaceClass ?? a.class) === 0xff &&
    (a.interfaceSubclass ?? a.subclass) === 0x42 &&
    (a.interfaceProtocol ?? a.protocol) === 0x03
  );
}

function endpointNumberOf(e: RawUsbEndpointLike): number | undefined {
  return e.endpointNumber ?? e.number;
}

/**
 * AOSP's match_fastboot (fastboot.cpp): the *interface* descriptor must
 * be 0xff/0x42/0x03. (Some devices also expose it at the device
 * descriptor level; accept that too.)
 */
function isFastbootDevice(d: RawUsbDevice): boolean {
  if (
    d.deviceClass === 0xff &&
    d.deviceSubclass === 0x42 &&
    d.deviceProtocol === 0x03
  ) {
    return true;
  }
  for (const c of d.configurations ?? []) {
    for (const i of c.interfaces ?? []) {
      for (const a of alternatesOf(i)) {
        if (
          isFastbootAlternate(a) &&
          a.endpoints &&
          a.endpoints.some((e) => e.direction === "in" && e.type === "bulk") &&
          a.endpoints.some((e) => e.direction === "out" && e.type === "bulk")
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * AOSP's do_usb_open: open the interface, then the *default* bulk
 * read/write endpoints — the first interface with both, preferring the
 * 0xff/0x42/0x03 one (recognized_device requires exactly two
 * endpoints).
 */
function findFastbootEndpoints(
  d: RawUsbDevice,
): { index: number; in: number; out: number } {
  let fallback: { index: number; in: number; out: number } | null = null;
  for (const c of d.configurations ?? []) {
    for (const i of c.interfaces ?? []) {
      for (const a of alternatesOf(i)) {
        const eps = a.endpoints ?? [];
        const inEp = eps.find(
          (e) => e.direction === "in" && e.type === "bulk",
        );
        const outEp = eps.find(
          (e) => e.direction === "out" && e.type === "bulk",
        );
        if (!inEp || !outEp) continue;
        const inNum = endpointNumberOf(inEp);
        const outNum = endpointNumberOf(outEp);
        if (inNum === undefined || outNum === undefined) continue;
        const idx = interfaceNumberOf(i);
        if (isFastbootAlternate(a)) {
          return { index: idx, in: inNum, out: outNum };
        }
        if (fallback === null) {
          fallback = { index: idx, in: inNum, out: outNum };
        }
      }
    }
  }
  if (fallback !== null) return fallback;
  throw new Error("no bulk in+out endpoints found on the device");
}

export class FastbootDevice {
  /** The raw WebUSB device (null before open / after close). */
  device: RawUsbDevice | null = null;
  epIn: number | null = null;
  epOut: number | null = null;

  private closed = false;

  /**
   * AOSP's usb_open: enumerate the granted devices, match
   * 0xff/0x42/0x03, open the interface and its default bulk pipes.
   * Never resets (a reset would drop the bootloader's staged state).
   * `{ auto: true }`: take the single granted device without prompting.
   */
  async connect(opts?: { auto?: boolean }): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usb = (navigator as any).usb;
    if (!usb) throw new Error("WebUSB is not available in this browser");
    const granted: RawUsbDevice[] = (await usb.getDevices()) ?? [];
    let device: RawUsbDevice | null = null;
    if (opts?.auto) {
      device = granted[0] ?? null;
    } else {
      const matching = granted.filter(isFastbootDevice);
      if (matching.length > 0) {
        device = matching[0];
      } else {
        logFastboot("note", "no paired fastboot device; opening picker");
        // Spec USBDeviceFilter has no deviceClass field —
        // classCode/subclassCode/protocolCode match the *interface*
        // descriptor (the spec's bInterfaceClass/.../...), so the
        // picker only lists fastboot devices.
        const picked: unknown = await usb.requestDevice({
          filters: [
            { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 },
          ],
        });
        // Older Chrome resolves an array (empty when the picker is
        // cancelled); the current spec resolves a single USBDevice.
        // Handle both — `picked[0]` on a single device is undefined,
        // which must not reach openDevice().
        const pickedDevice = (Array.isArray(picked)
          ? picked[0]
          : picked) as RawUsbDevice | null | undefined;
        if (!pickedDevice) {
          throw new Error("no fastboot device selected");
        }
        device = pickedDevice;
      }
    }
    logFastboot(
      "note",
      `paired: ${granted.length} device(s), fastboot-matching: ` +
        `${granted.filter(isFastbootDevice).length}`,
    );
    if (!device) {
      throw new Error(
        `no fastboot device available (granted: ${granted.length}, ` +
          `typeof granted[0]: ${typeof granted[0]})`,
      );
    }
    await this.openDevice(device);
  }

  private async openDevice(d: RawUsbDevice): Promise<void> {
    if (!d) {
      throw new Error(
        "openDevice: undefined device (granted list was empty or the " +
          "device vanished between enumeration and open — check the " +
          "console trace above for the 'paired:' line)",
      );
    }
    if (!d.opened && typeof d.open === "function") {
      await d.open();
    }
    if (typeof d.selectConfiguration === "function") {
      // AOSP uses the driver's default configuration; WebUSB requires
      // an explicit select after open — use the device's first
      // configuration value (1 in practice).
      await d.selectConfiguration(
        d.configurations?.[0]?.configurationValue ?? 1,
      );
    }
    const iface = findFastbootEndpoints(d);
    if (typeof d.claimInterface === "function") {
      await d.claimInterface(iface.index);
    }
    this.device = d;
    this.epIn = iface.in;
    this.epOut = iface.out;
    logFastboot(
      "note",
      `open: interface ${iface.index}, out=0x${iface.out.toString(16)} ` +
        `in=0x${iface.in.toString(16)}`,
    );
  }

  /**
   * AOSP transport Write/Read, ported: one WebUSB transfer per call —
   * no chunking, no re-poll (a NAK'd transfer stays parked until the
   * device re-arms or the time-box expires).
   */
  private async writeRaw(
    data: Uint8Array,
    ms: number,
    label: string,
  ): Promise<void> {
    const device = this.device;
    if (device === null || this.epOut === null) {
      throw new Error("USB device not connected");
    }
    // AOSP SendBuffer: "ioctl on 0-length buffer causes freezing"
    if (data.length === 0) {
      throw new Error(`refusing a zero-length write (${label})`);
    }
    const canAbort =
      typeof device.addEventListener === "function" &&
      typeof device.removeEventListener === "function" &&
      typeof device.abortTransfer === "function";
    let transfer: unknown = null;
    const onProgress = canAbort
      ? (e: Event) => {
          transfer = (e as unknown as { transfer: unknown }).transfer;
        }
      : null;
    if (onProgress !== null) {
      device.addEventListener!("transferoutprogress", onProgress);
    }
    try {
      await withTimeout(device.transferOut(this.epOut, data), ms);
    } catch (e) {
      if (onProgress !== null && transfer !== null) {
        try {
          device.abortTransfer!(transfer);
        } catch {
          // the transfer already settled — nothing left to abort
        }
      }
      if (e instanceof Error && e.message === "timed out") {
        throw new Error(`timed out in ${label}`);
      }
      throw e;
    } finally {
      if (onProgress !== null) {
        device.removeEventListener!("transferoutprogress", onProgress);
      }
    }
  }

  private async readRaw(
    length: number,
    ms: number,
    label: string,
  ): Promise<Uint8Array> {
    const device = this.device;
    if (device === null || this.epIn === null) {
      throw new Error("USB device not connected");
    }
    const canAbort =
      typeof device.addEventListener === "function" &&
      typeof device.removeEventListener === "function" &&
      typeof device.abortTransfer === "function";
    let transfer: unknown = null;
    const onProgress = canAbort
      ? (e: Event) => {
          transfer = (e as unknown as { transfer: unknown }).transfer;
        }
      : null;
    if (onProgress !== null) {
      device.addEventListener!("transferinprogress", onProgress);
    }
    let result: Uint8Array;
    try {
      const r = await withTimeout(device.transferIn(this.epIn, length), ms);
      result = normalizeTransferData(r.data);
    } catch (e) {
      if (onProgress !== null && transfer !== null) {
        try {
          device.abortTransfer!(transfer);
        } catch {
          // the transfer already settled — nothing left to abort
        }
      }
      if (e instanceof Error && e.message === "timed out") {
        throw new Error(`timed out in ${label}`);
      }
      throw e;
    } finally {
      if (onProgress !== null) {
        device.removeEventListener!("transferinprogress", onProgress);
      }
    }
    return result;
  }

  /**
   * AOSP FastBootDriver::HandleResponse: read status packets
   * (FB_RESPONSE_SZ) within a 30 s window; the window resets on INFO
   * and TEXT lines; OKAY/FAIL/DATA end it.
   */
  private async handleResponse(): Promise<{
    response: string;
    info: string[];
  }> {
    const info: string[] = [];
    let deadline = Date.now() + RESP_TIMEOUT_MS;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("timed out waiting for the device response (30s window)");
      }
      const raw = await this.readRaw(FB_RESPONSE_SZ, remaining, "response");
      if (raw.length === 0) continue;
      const text = new TextDecoder().decode(raw);
      logFastboot(
        "<<<device",
        `${JSON.stringify(text.trim())} | ${hexBytes(raw)}`,
      );
      if (text.startsWith("INFO")) {
        info.push(text.slice(4));
        // AOSP: reset the timer — INFO lines may keep coming
        deadline = Date.now() + RESP_TIMEOUT_MS;
      } else if (text.startsWith("OKAY")) {
        return { response: text.slice(4), info };
      } else if (text.startsWith("FAIL")) {
        throw new Error(`FAIL: ${text.slice(4)}`);
      } else if (text.startsWith("TEXT")) {
        // AOSP: reset the timer — more TEXT may come
        deadline = Date.now() + RESP_TIMEOUT_MS;
      } else if (text.startsWith("DATA")) {
        return { response: text.slice(4), info };
      } else {
        throw new Error(`device sent unknown status code: ${text}`);
      }
    }
  }

  /**
   * AOSP FastBootDriver::RawCommand: write the exact command bytes (one
   * write, no trailing newline), then HandleResponse.
   */
  async runCommand(
    cmd: string,
  ): Promise<{ response: string; info: string[] }> {
    if (cmd.length > FB_COMMAND_SZ) {
      throw new Error("command length is too long");
    }
    logFastboot("host>>>", cmd);
    await this.writeRaw(new TextEncoder().encode(cmd), CMD_WRITE_MS, "command");
    return this.handleResponse();
  }

  /**
   * AOSP FastBootDriver::GetVar. The value is the OKAY suffix; some
   * variables (e.g. `at-vboot-state`) also emit INFO lines — those are
   * concatenated in front so a single string carries the whole answer.
   */
  async getVariable(key: string): Promise<string> {
    const { response, info } = await this.runCommand(`getvar:${key}`);
    if (info.length === 0) return response;
    return `${info.join("\n")}\n${response}`;
  }

  /**
   * AOSP FastBootDriver::Download (the "stage" / `download` sequence):
   * DownloadCommand -> SendBuffer (one write of the whole buffer) ->
   * HandleResponse. The per-step windows are the tool's safety layer;
   * the wire behaviour is faithful: one continuous write, no chunking,
   * no re-poll, no ZLP, and no host "OKAY" after the payload (AOSP
   * doesn't send one; the device sends its final status itself).
   */
  async download(
    data: Uint8Array,
  ): Promise<{ response: string; info: string[] }> {
    if (data.length === 0) {
      throw new Error("Buffer is too large or 0 bytes");
    }
    if (verbose()) {
      logFastboot("note", `credential: ${hexBytes(data)}`);
    }
    // DownloadCommand: "download:%08x"
    const cmd = `download:${data.length.toString(16).padStart(8, "0")}`;
    logFastboot("host>>>", cmd);
    await this.writeRaw(new TextEncoder().encode(cmd), CMD_WRITE_MS, "download-command");
    const ack = await this.handleResponse();
    logFastboot(
      "note",
      ack.response !== ""
        ? `download ack: DATA${ack.response}`
        : "download ack: OKAY",
    );
    // SendBuffer: one continuous write of the whole buffer.
    logFastboot(
      "note",
      `staging: single continuous write of ${data.length} bytes ` +
        `(${PAYLOAD_WRITE_MS / 1000}s window)`,
    );
    await this.writeRaw(data, PAYLOAD_WRITE_MS, "download-payload");
    logFastboot("note", `payload complete (${data.length} bytes)`);
    // HandleResponse: the device's final status.
    return this.handleResponse();
  }

  /**
   * AOSP FastBootDriver::RunAndReadBuffer (the "upload" direction, i.e.
   * `fastboot get_staged`): RawCommand("upload") -> DATA<size> -> read
   * exactly `size` bytes (1 MiB chunks; a short read is an error, as in
   * AOSP's ReadBuffer) -> HandleResponse. No host "OKAY" is sent
   * (AOSP doesn't; the device sends its final status itself).
   */
  async upload(): Promise<{ bytes: Uint8Array; info: string[] }> {
    const { response, info } = await this.runCommand("upload");
    const size = parseInt(response, 16);
    if (!Number.isFinite(size) || size <= 0 || size > 65536) {
      throw new Error(
        `upload request failed, device reports ${size} bytes available`,
      );
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < size) {
      const n = Math.min(size - received, READ_CHUNK);
      const b = await this.readRaw(n, RESP_TIMEOUT_MS, "upload-data");
      // AOSP ReadBuffer: "Failed to read all %zu bytes"
      if (b.length !== n) {
        throw new Error(`failed to read all ${n} bytes (got ${b.length})`);
      }
      chunks.push(b);
      received += n;
    }
    // AOSP: RunAndReadBuffer ends with HandleResponse.
    await this.handleResponse();
    const out = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    logFastboot("note", `staged data (${out.length} bytes): ${hexBytes(out)}`);
    return { bytes: out, info };
  }

  /**
   * Waits for the device to (re)appear in fastboot mode: if it is
   * still attached (e.g. `flashing unlock` completed without a reboot,
   * as on this board) it returns immediately; otherwise it polls for a
   * re-enumeration and re-opens the new device object. The caller
   * bounds this with its own window.
   */
  async waitForConnect(): Promise<void> {
    if (this.closed) throw new Error("device was released");
    if (this.device !== null && this.device.connected !== false) {
      return;
    }
    const deadline = Date.now() + 300_000;
    for (;;) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usb = (navigator as any).usb;
      let found: RawUsbDevice | null = null;
      for (const d of (await usb.getDevices()) ?? []) {
        if (d !== this.device && isFastbootDevice(d)) {
          found = d;
          break;
        }
      }
      if (found) {
        logFastboot("note", "device re-appeared; reopening");
        await this.openDevice(found);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the device to reconnect");
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Release the WebUSB device (a released device leaves getDevices()). */
  async close(): Promise<void> {
    this.closed = true;
    const d = this.device;
    this.device = null;
    this.epIn = null;
    this.epOut = null;
    if (d !== null && typeof d.release === "function") {
      try {
        await d.release();
      } catch {
        // already gone
      }
    }
  }
}
