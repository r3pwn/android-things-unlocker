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
 *   AVB re-lock     — `oem at-lock-vboot!`
 *   bootloader unlock  — `fastboot flashing unlock`
 *   bootloader re-lock — `fastboot flashing lock`
 *
 * Signing happens on the server, so the PUK private key never reaches
 * the browser; this page only ever sees the challenge and the signed
 * credential.
 *
 * Structure: UnlockPage (the exported default) owns the OS colour-scheme
 * detection and provides the antd theme + App context. All the tool
 * logic lives in UnlockTool, which is rendered INSIDE <AntApp> — the
 * useApp() hook can only consume the App context from a descendant, so
 * the message/modal handlers must live there.
 */

type BusyAction =
  | "avb-unlock"
  | "avb-relock"
  | "bl-unlock"
  | "bl-relock"
  | "reboot"
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
  // The antd theme follows the OS colour scheme, exactly like the page
  // background (globals.css `prefers-color-scheme: dark`). It starts
  // light so the server render and the client's first render produce
  // identical class hashes (antd's CSS-in-JS changes them per
  // algorithm); the real scheme is applied in the effect below, before
  // the first paint.
  const [dark, setDark] = useState(false);
  useEffect(() => {
    // Deferred like the other client probes: no synchronous setState in
    // the effect (lint), and the microtask runs before the first paint.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const applyDark = () => setDark(mq.matches);
    queueMicrotask(applyDark);
    mq.addEventListener("change", applyDark);
    return () => mq.removeEventListener("change", applyDark);
  }, []);

  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <AntApp>
        <UnlockTool />
      </AntApp>
    </ConfigProvider>
  );
}

function UnlockTool() {
  // Descendant of <AntApp>, so this resolves to the real themed
  // message/modal (calling it outside the provider yields a
  // non-functional placeholder).
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

  useEffect(() => {
    // `webUsbAvailable()` probes `navigator` — a stable browser feature
    // flag. Defer the setState to a microtask so we (a) don't trigger a
    // synchronous/cascading render inside the effect (lint) and (b) keep
    // the probe client-side, avoiding an SSR hydration mismatch on it.
    queueMicrotask(() => setUsbOk(webUsbAvailable()));
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

  const handleReboot = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    setBusy("reboot");
    setError(null);
    try {
      setStatusText("Rebooting device…");
      await s.reboot();
      // The device is leaving fastboot (and the session with it).
      // Reset to idle; if it reboots back into fastboot, Connect
      // (or a page reload) picks it up.
      await handleDisconnect();
      message.success(
        "Device is rebooting — if it returns to fastboot, press Connect",
      );
    } catch (e) {
      console.error(e);
      setError(humanize(e));
    } finally {
      setBusy(null);
      setStatusText(null);
    }
  }, [handleDisconnect, message]);

  // A post-op state read can race a bootloader reboot (the device
  // reboots right after the command returns). If the read fails, wait
  // for the device to come back into fastboot and try once more.
  const refreshState = useCallback(async (s: FastbootSession) => {
    try {
      return await s.getState();
    } catch {
      await s.waitReady();
      return s.getState();
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
      setState(await refreshState(s));
      message.success("Verified boot (AVB) unlocked");
    } catch (e) {
      console.error(e);
      setError(humanize(e));
    } finally {
      setBusy(null);
      setStatusText(null);
      setProgress(null);
    }
  }, [message, refreshState]);

  const handleAvbRelock = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    setBusy("avb-relock");
    setError(null);
    try {
      setStatusText("Re-locking verified boot…");
      await s.relockVboot();
      setState(await refreshState(s));
      message.success("Verified boot (AVB) re-locked");
    } catch (e) {
      console.error(e);
      setError(humanize(e));
    } finally {
      setBusy(null);
      setStatusText(null);
    }
  }, [message, refreshState]);

  const handleBootloader = useCallback(
    async (unlock: boolean) => {
      const s = sessionRef.current;
      if (!s) return;
      setBusy(unlock ? "bl-unlock" : "bl-relock");
      setError(null);
      try {
        setStatusText(
          unlock ? "Unlocking bootloader…" : "Re-locking bootloader…",
        );
        if (unlock) {
          await s.bootloaderUnlock();
        } else {
          await s.bootloaderRelock();
        }
        setState(await refreshState(s));
        message.success(unlock ? "Bootloader unlocked" : "Bootloader re-locked");
      } catch (e) {
        console.error(e);
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
    [handleDisconnect, message, refreshState],
  );

  // --- confirmation modals -------------------------------------------------

  const confirmAvbUnlock = useCallback(() => {
    modal.confirm({
      title: "Unlock verified boot (AVB)?",
      content:
        "Unlocks the device using some manufacturer-signed data. Verified " +
        "boot will be disabled on the device, which, on some devices, " +
        "may prevent the device from fully booting. This is normal.",
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
            Re-enables Verified Boot. <b>Warning:</b> re-locking
            verified boot while a non-stock build is flashed can
            <b> brick</b> the device. Only do this if the device is
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
              {unlock ? "Unlocks" : "Locks"} the bootloader.
            </p>
            {unlock ? (
              <p>
                On some devices, &quot;standard&quot; unlocking is
                refused by the bootloader — in that case, the AVB unlock is
                what unlocks the device.
              </p>
            ) : (
              <p>
                <b>Warning:</b> re-locking the bootloader while a non-stock
                build is flashed can <b>brick</b> the device. Only do this
                if the device is running stock firmware.
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
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 64px" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Android Things — bootloader unlock tool
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Uses fastboot over WebUSB, with server-side unlock code generation.
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
              <Button
                size="small"
                onClick={handleReboot}
                disabled={busy !== null}
              >
                Reboot
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
  );
}
