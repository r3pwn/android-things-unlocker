/**
 * Minimal type declarations for the `android-fastboot` package, which ships
 * no TypeScript definitions. Only the surface used by this project is
 * declared. The bundle's class properties (device/epIn/epOut) are not
 * `#private` in the JS, so they are accessed directly for the raw
 * get_staged/stage protocol phases that the high-level API does not cover.
 */
declare module "android-fastboot" {
  /** Response to a raw fastboot command (64-byte status packet). */
  export interface CommandResponse {
    /** Concatenated OKAY/INFO messages from the bootloader. */
    text: string;
    /**
     * When the bootloader answered with a DATA header, the 8-digit hex
     * ASCII payload size decoded from the status packet (e.g. "00000034").
     * Undefined for plain OKAY/FAIL responses.
     */
    dataSize?: string;
  }

  export class FastbootError extends Error {
    status: string;
  }
  export class UsbError extends Error {}
  export class TimeoutError extends Error {}

  export type FlashProgressCallback = (progress: number) => void;

  export class FastbootDevice {
    /** The underlying WebUSB device (available once connect() succeeds). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    device: any;
    /** In-bulk endpoint number, or null before connect. */
    epIn: number | null;
    /** Out-bulk endpoint number, or null before connect. */
    epOut: number | null;

    constructor();

    get isConnected(): boolean;

    /**
     * Prompt the user to select a fastboot USB device (or reuse a single
     * already-paired one) and open it. Throws UsbError on failure.
     */
    connect(): Promise<void>;

    /** Release the USB device. */
    close(): Promise<void>;

    /**
     * Send a raw fastboot command (e.g. "oem at-get-vboot-unlock-challenge",
     * "getvar:version", "download:00000034") and read the status response.
     * Throws FastbootError when the bootloader answers FAIL.
     */
    runCommand(command: string): Promise<CommandResponse>;

    /**
     * Read a bootloader variable. Returns null when it does not exist.
     */
    getVariable(varName: string): Promise<string | null>;

    /**
     * Host → device data phase: send `download:<8-hex>` for the buffer
     * length, wait for the DATA ack, send the payload, wait for OKAY.
     * This is the wire-level operation behind `fastboot download`/`stage`.
     */
    upload(
      partition: string,
      buffer: ArrayBuffer,
      onProgress?: FlashProgressCallback,
    ): Promise<void>;

    reboot(
      target?: string,
      wait?: boolean,
      onReconnect?: () => void,
    ): Promise<void>;

    /** Resolves on the next USB connection. */
    waitForConnect(onReconnect?: () => void): Promise<void>;

    /** Resolves when the current device disconnects. */
    waitForDisconnect(): Promise<void>;
  }

  export function setDebugLevel(level: number): void;
}
