"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  ConfigProvider,
  Descriptions,
  Divider,
  Progress,
  Spin,
  Space,
  Tag,
  theme,
  Typography,
} from "antd";
import {
  connectFastboot,
  webUsbAvailable,
  ReconnectError,
  type DeviceState,
  type FastbootSession,
  type LockState,
} from "@/lib/fastboot-unlock";

/**
 * WebUSB unlock tool for the Android Things authenticated AVB unlock.
 *
 * One page, one card (modelled on the LineageOS flash tool). While no
 * device is attached it waits; once a fastboot device is connected it
 * reports the AVB + standard-bootloader lock state and the serial, and
 * offers the actions that are valid for that state:
 *
 *   AVB unlock      — the at_auth_unlock.py flow: read the challenge,
 *                     sign it via the same-origin API, stage the
 *                     credential, `oem at-unlock-vboot`
 *   AVB re-lock     — `oem at-lock-vboot`
 *   bootloader unlock  — `fastboot flashing unlock`
 *   bootloader re-lock — `fastboot flashing lock`
 *
 * Signing happens on the server, so the PUK private key never reaches
 * the browser; this page only ever sees the challenge and the signed
 * credential.
 */

type BusyAction =
  | "avb-unlock"
  | "avb-relock"
  | "bl-unlock"
  | "bl-relock"
  | null;

function humanize(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function LockTag({ state }: { state: LockState }) {
  if (state === "unlocked") return <Tag color="orange">unlocked</Tag>;
  if (state === "locked") return <Tag color="green">locked</Tag>;
  return <Tag>unknown</Tag>;
}

export default function UnlockPage() {
  const { message, modal } = AntApp.useApp();

  const sessionRef = useRef<FastbootSession | null>(null);

  const [usbOk, setUsbOk] = useState<boolean | null>(null);

  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<DeviceState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [busy, setBusy] = useState<BusyAction>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [matchedSet, setMatchedSet] = useState<string | null>(null);
  // The antd theme follows the OS colour scheme, exactly like the page
  // background (globals.css `prefers-color-scheme: dark`). It starts
  // light so the server render and the client's first render produce
  // identical class hashes (antd's CSS-in-JS changes them per
  // algorithm); the real scheme is applied in the mount effect, before
  // the first paint.
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // `webUsbAvailable()` probes `navigator` — a stable browser feature
    // flag. Defer the setState to a microtask so we (a) don't trigger a
    // synchronous/cascading render inside the effect (lint) and (b) keep
    // the probe client-side, avoiding an SSR hydration mismatch on it.
    queueMicrotask(() => setUsbOk(webUsbAvailable()));
    // Detect the OS colour scheme (the same signal the background
    // uses). Deferred like the WebUSB probe: no synchronous setState in
    // the effect (lint), and the microtask runs before the first paint.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const applyDark = () => setDark(mq.matches);
    queueMicrotask(applyDark);
    mq.addEventListener("change", applyDark);
    // Auto-connect if a device is already paired + connected (the
    // LineageOS-tool behaviour). No prompt here; if there isn't exactly
    // one device, NoDeviceError is thrown and we stay in the idle state.
    if (webUsbAvailable()) {
      connectFastboot({ auto: true })
        .then(async (s) => {
          sessionRef.current = s;
          const st = await s.getState();
          setState(st);
          setConnected(true);
        })
        .catch(() => {
          // No device / not in fastboot — stay idle.
        });
    }
    return () => mq.removeEventListener("change", applyDark);
  }, []);

  const handleConnect = useCallback(async () => {
    if (usbOk !== true) {
      message.error(
        "WebUSB is not available in this browser (use Chrome or Edge over https or localhost).",
      );
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const s = await connectFastboot();
      sessionRef.current = s;
      const st = await s.getState();
      setState(st);
      setConnected(true);
      message.success(`Connected: ${st.serial ?? "device"}`);
    } catch (e) {
      setError(humanize(e));
    } finally {
      setConnecting(false);
    }
  }, [usbOk, message]);

  const handleDisconnect = useCallback(async () => {
    await sessionRef.current?.close();
    sessionRef.current = null;
    setConnected(false);
    setState(null);
    setMatchedSet(null);
  }, []);

  const handleRefresh = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      const st = await s.getState();
      setState(st);
      setError(null);
    } catch (e) {
      setError(humanize(e));
    }
  }, []);

  const handleAvbUnlock = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    setBusy("avb-unlock");
    setError(null);
    try {
      setStatusText("Reading challenge from device…");
      const challenge = await s.getChallenge();
      setStatusText("Signing via API…");
      const res = await fetch("/api/v1/unlock_challenge", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        // The array is backed by a real ArrayBuffer; narrow the generic
        // so it satisfies BodyInit under TS 5.7+ typed-array types.
        body: challenge as Uint8Array<ArrayBuffer>,
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string; detail?: string };
          if (j.error) detail = `${j.error}${j.detail ? ` — ${j.detail}` : ""}`;
        } catch {
          // non-JSON error body
        }
        throw new Error(detail);
      }
      const cred = new Uint8Array(await res.arrayBuffer());
      setMatchedSet(res.headers.get("x-matched-credential-set"));
      setStatusText("Staging credential…");
      await s.stageCredential(cred, (p) => setProgress(p));
      setStatusText("Unlocking verified boot…");
      await s.unlockVboot();
      const st = await s.getState();
      setState(st);
      message.success("Verified boot (AVB) unlocked");
    } catch (e) {
      setError(humanize(e));
    } finally {
      setBusy(null);
      setStatusText(null);
      setProgress(null);
    }
  }, [message]);

  const handleAvbRelock = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    setBusy("avb-relock");
    setError(null);
    try {
      setStatusText("Re-locking verified boot…");
      await s.relockVboot();
      const st = await s.getState();
      setState(st);
      message.success("Verified boot (AVB) re-locked");
    } catch (e) {
      setError(humanize(e));
    } finally {
      setBusy(null);
      setStatusText(null);
    }
  }, [message]);

  const handleBootloader = useCallback(
    async (unlock: boolean) => {
      const s = sessionRef.current;
      if (!s) return;
      setBusy(unlock ? "bl-unlock" : "bl-relock");
      setError(null);
      try {
        setStatusText(
          unlock
            ? "Unlocking bootloader — the device is rebooting into fastboot…"
            : "Re-locking bootloader — the device is rebooting into fastboot…",
        );
        if (unlock) {
          await s.bootloaderUnlock();
        } else {
          await s.bootloaderRelock();
        }
        const st = await s.getState();
        setState(st);
        message.success(unlock ? "Bootloader unlocked" : "Bootloader re-locked");
      } catch (e) {
        if (e instanceof ReconnectError) {
          // The device is no longer in fastboot (it booted into the OS or
          // never came back). Reset to the idle state so the user can
          // re-pair once it's back in the bootloader.
          await handleDisconnect();
          setError(
            "The device did not return to fastboot. Boot it back into the " +
              "bootloader, then press Connect.",
          );
        } else {
          setError(humanize(e));
        }
      } finally {
        setBusy(null);
        setStatusText(null);
      }
    },
    [handleDisconnect, message],
  );

  // --- confirmation modals -------------------------------------------------

  const confirmAvbUnlock = useCallback(() => {
    modal.confirm({
      title: "Unlock verified boot (AVB)?",
      content:
        "Sends the device's unlock challenge to the API for signing, stages " +
        "the signed credential, and runs `oem at-unlock-vboot`. Verified " +
        "boot will be disabled on the device.",
      okText: "Unlock",
      okType: "danger",
      onOk: handleAvbUnlock,
    });
  }, [modal, handleAvbUnlock]);

  const confirmAvbRelock = useCallback(() => {
    modal.confirm({
      title: "Re-lock verified boot (AVB)?",
      okText: "Re-lock",
      okType: "danger",
      content: (
        <div>
          <p>
            Runs <code>oem at-lock-vboot</code>. <b>Warning:</b> re-locking
            verified boot while a non-stock build is flashed can
            <b> hard-brick</b> the device. Only do this if the device is
            running stock firmware.
          </p>
        </div>
      ),
      onOk: handleAvbRelock,
    });
  }, [modal, handleAvbRelock]);

  const confirmBootloader = useCallback(
    (unlock: boolean) => {
      modal.confirm({
        title: unlock ? "Unlock the bootloader?" : "Re-lock the bootloader?",
        okText: unlock ? "Unlock" : "Re-lock",
        okType: "danger",
        content: (
          <div>
            <p>
              Runs <code>fastboot flashing {unlock ? "unlock" : "lock"}</code>.
              The device will reboot into fastboot and re-attach; the tool
              waits for it to come back.
            </p>
            {unlock && (
              <p>
                On some Android Things builds <code>flashing unlock</code> is
                refused by the bootloader — in that case the AVB unlock is
                what unlocks the device.
              </p>
            )}
          </div>
        ),
        onOk: () => handleBootloader(unlock),
      });
    },
    [modal, handleBootloader],
  );

  // --- render --------------------------------------------------------------

  const lockedHint =
    error && error.includes("only allow when locked")
      ? " The bootloader must be LOCKED to request an unlock challenge — refresh or re-lock it first."
      : "";

  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <AntApp>
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 64px" }}>
          <Typography.Title level={3} style={{ marginTop: 0 }}>
            Android Things — fastboot unlock tool
          </Typography.Title>
          <Typography.Paragraph type="secondary">
            Browser fastboot over WebUSB + server-side signing. The PUK
            private key never leaves the server; this page only ever sees the
            challenge and the signed credential.
          </Typography.Paragraph>

          <Tag
            color={usbOk ? "green" : usbOk === false ? "red" : "default"}
            style={{ marginBottom: 16 }}
          >
            {usbOk === null
              ? "checking WebUSB…"
              : usbOk
                ? "WebUSB available"
                : "WebUSB unavailable (Chrome/Edge + https)"}
          </Tag>

          {usbOk === false && (
            <Alert
              type="warning"
              showIcon
              title="WebUSB is not supported here"
              description="Open this page in Chrome or Edge, over https (or localhost)."
              style={{ marginBottom: 16 }}
            />
          )}
          {error && (
            <Alert
              type="error"
              showIcon
              title="Error"
              description={`${error}${lockedHint}`}
              style={{ marginBottom: 16 }}
            />
          )}

          <Card>
            {!connected ? (
              // --- idle: waiting for a device -------------------------------
              <div style={{ textAlign: "center", padding: "48px 16px" }}>
                {connecting && <Spin size="large" />}
                <Typography.Title level={4} style={{ marginTop: 24, marginBottom: 8 }}>
                  {connecting ? "Connecting…" : "Waiting for fastboot device…"}
                </Typography.Title>
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginBottom: 24 }}
                >
                  {connecting
                    ? "Opening the fastboot device…"
                    : "Put the device in fastboot mode, then press Connect. On first use, pick it in the WebUSB dialog."}
                </Typography.Paragraph>
                <Button
                  type="primary"
                  size="large"
                  loading={connecting}
                  onClick={handleConnect}
                >
                  Connect
                </Button>
              </div>
            ) : (
              // --- connected: state + actions -----------------------------
              <div>
                <Descriptions
                  size="small"
                  bordered
                  column={2}
                  style={{ marginBottom: 16 }}
                  items={[
                    {
                      key: "serial",
                      label: "Serial",
                      children: state?.serial ?? "—",
                    },
                    {
                      key: "product",
                      label: "Product",
                      children: state?.product ?? "—",
                    },
                    {
                      key: "blver",
                      label: "Bootloader",
                      children: state?.bootloaderVersion ?? "—",
                    },
                    {
                      key: "avb",
                      label: "Verified boot (AVB)",
                      children: <LockTag state={state?.avb ?? "unknown"} />,
                    },
                    {
                      key: "bl",
                      label: "Bootloader lock",
                      children: (
                        <LockTag state={state?.bootloader ?? "unknown"} />
                      ),
                    },
                  ]}
                />

                <Space
                  style={{
                    width: "100%",
                    justifyContent: "flex-end",
                    marginBottom: 8,
                  }}
                >
                  <Button
                    size="small"
                    onClick={handleRefresh}
                    disabled={busy !== null}
                  >
                    Refresh state
                  </Button>
                  <Button size="small" onClick={handleDisconnect}>
                    Disconnect
                  </Button>
                </Space>

                <Divider style={{ margin: "16px 0" }} />

                {/* --- actions -------------------------------------------- */}
                <Space
                  style={{
                    width: "100%",
                    justifyContent: "space-between",
                    marginBottom: 16,
                  }}
                >
                  <Space>
                    <Typography.Text strong>Verified boot (AVB)</Typography.Text>
                    <LockTag state={state?.avb ?? "unknown"} />
                  </Space>
                  <Space>
                    {state?.avb === "locked" && (
                      <Button
                        type="primary"
                        disabled={busy !== null}
                        onClick={confirmAvbUnlock}
                      >
                        AVB unlock
                      </Button>
                    )}
                    {state?.avb === "unlocked" && (
                      <Button
                        danger
                        disabled={busy !== null}
                        onClick={confirmAvbRelock}
                      >
                        AVB re-lock
                      </Button>
                    )}
                    {state?.avb === "unknown" && (
                      <Typography.Text type="secondary">
                        state unknown — refresh
                      </Typography.Text>
                    )}
                  </Space>
                </Space>

                <Space
                  style={{
                    width: "100%",
                    justifyContent: "space-between",
                    marginBottom: 16,
                  }}
                >
                  <Space>
                    <Typography.Text strong>Bootloader</Typography.Text>
                    <LockTag state={state?.bootloader ?? "unknown"} />
                  </Space>
                  <Space>
                    {state?.bootloader === "locked" && (
                      <Button
                        type="primary"
                        disabled={busy !== null}
                        onClick={() => confirmBootloader(true)}
                      >
                        Bootloader unlock
                      </Button>
                    )}
                    {state?.bootloader === "unlocked" && (
                      <Button
                        danger
                        disabled={busy !== null}
                        onClick={() => confirmBootloader(false)}
                      >
                        Bootloader re-lock
                      </Button>
                    )}
                    {state?.bootloader === "unknown" && (
                      <Typography.Text type="secondary">
                        state unknown — refresh
                      </Typography.Text>
                    )}
                  </Space>
                </Space>

                {busy && (
                  <div style={{ marginTop: 8 }}>
                    {statusText && (
                      <Typography.Text style={{ display: "block", marginBottom: 8 }}>
                        {statusText}
                      </Typography.Text>
                    )}
                    {progress !== null && (
                      <Progress
                        percent={Math.round(progress * 100)}
                        status="active"
                      />
                    )}
                  </div>
                )}

                {matchedSet && (
                  <div style={{ marginTop: 12 }}>
                    <Typography.Text type="secondary">
                      Signed by credential set{" "}
                      <Tag color="blue">{matchedSet}</Tag>
                    </Typography.Text>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </AntApp>
    </ConfigProvider>
  );
}
