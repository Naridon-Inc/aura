// Mobile remote launcher. Surfaces the LAN URL + PIN so the user can
// hit it from a phone in the same network. The desktop runs an axum
// server inside the Tauri process (see `src-tauri/src/cmd_remote.rs`
// for protocol + auth). Dialog responsibilities:
//   • toggle the server on/off
//   • show the URL big enough to read across a desk
//   • render a minimal QR (data-url canvas) so phone cameras can
//     pair without typing
//   • show how many phones are connected right now
//
// The phone-side UI is a single embedded HTML page served by the same
// server (no separate build artifact).

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { api, type RemoteRelayStatus } from "../../lib/api";
import { useQr } from "../../lib/qr";

type Status = {
  running: boolean;
  url: string | null;
  pin: string | null;
  clients: number;
};

type RemoteDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function RemoteDialog({ open, onClose }: RemoteDialogProps) {
  const [status, setStatus] = useState<Status>({
    running: false,
    url: null,
    pin: null,
    clients: 0,
  });
  const [relay, setRelay] = useState<RemoteRelayStatus>({
    running: false,
    code: null,
    public_url: null,
  });
  const [busy, setBusy] = useState(false);
  const [relayBusy, setRelayBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const qr = useQr(status.url ?? "");
  const relayQr = useQr(relay.public_url ?? "");

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    api
      .remoteStatus()
      .then((s) => mounted && setStatus(s))
      .catch(() => {});
    api
      .remoteRelayStatus()
      .then((s) => mounted && setRelay(s))
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [open]);

  // Backend pushes relay status changes (registered / disconnected) on
  // its own channel — mirror them so the UI doesn't drift.
  useEffect(() => {
    if (!open) return;
    let unl: (() => void) | null = null;
    listen<RemoteRelayStatus>("remote-relay:status", (e) => {
      if (e.payload) setRelay(e.payload);
    })
      .then((u) => {
        unl = u;
      })
      .catch(() => {});
    return () => {
      if (unl) unl();
    };
  }, [open]);

  // Listen for client-count changes from the backend so the chip
  // updates the moment a phone connects/disconnects without polling.
  useEffect(() => {
    if (!open) return;
    let unl: (() => void) | null = null;
    listen<number>("remote:clients-changed", (e) => {
      setStatus((s) => ({ ...s, clients: Number(e.payload) || 0 }));
    })
      .then((u) => {
        unl = u;
      })
      .catch(() => {});
    return () => {
      if (unl) unl();
    };
  }, [open]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const s = await api.remoteStart();
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const s = await api.remoteStop();
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function relayStart() {
    setRelayBusy(true);
    setRelayError(null);
    try {
      const s = await api.remoteRelayStart();
      setRelay(s);
    } catch (e) {
      setRelayError(String(e));
    } finally {
      setRelayBusy(false);
    }
  }
  async function relayStop() {
    setRelayBusy(true);
    setRelayError(null);
    try {
      const s = await api.remoteRelayStop();
      setRelay(s);
    } catch (e) {
      setRelayError(String(e));
    } finally {
      setRelayBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Use Aura on your phone" width={460}>
      <div className="px-5 py-4 flex flex-col gap-4">
        {!status.running ? (
          <div className="flex flex-col gap-3">
            <p className="text-text-2 text-[12.5px] leading-relaxed">
              Turn this on and your phone — on the same Wi-Fi — can drive
              whatever's running here. No login: the link carries a short
              PIN so only you can connect.
            </p>
            <Button
              variant="default"
              size="default"
              onClick={start}
              disabled={busy}
              className="self-start"
            >
              {busy ? "Turning on…" : "Turn on"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-text-4 text-[10px] uppercase tracking-wider mb-0.5">
                  Open on phone
                </div>
                <div className="text-text-1 text-[13px] font-mono break-all">
                  {status.url}
                </div>
              </div>
              {qr && (
                <img
                  src={qr}
                  alt="QR"
                  width={104}
                  height={104}
                  className="rounded bg-white p-1"
                />
              )}
            </div>

            <div className="flex items-center gap-2 text-[11.5px]">
              <span className="text-text-4">PIN</span>
              <span className="font-mono text-text-1 tracking-[0.2em]">
                {status.pin}
              </span>
              <span className="ml-auto text-text-4">
                {status.clients} {status.clients === 1 ? "phone" : "phones"} connected
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="default"
                onClick={stop}
                disabled={busy}
              >
                Turn off
              </Button>
              {status.url && (
                <Button
                  variant="secondary"
                  size="default"
                  onClick={() => {
                    if (status.url) navigator.clipboard.writeText(status.url);
                  }}
                >
                  Copy URL
                </Button>
              )}
            </div>

            <div className="text-text-4 text-[10.5px] leading-relaxed">
              The PIN keeps other devices on your Wi-Fi from connecting by
              accident. It doesn't scramble the connection, though — only
              share this link on a network you trust.
            </div>
          </div>
        )}

        {error && (
          <div className="text-[11.5px] text-fg-error">
            {error}
          </div>
        )}

        <div className="border-t border-bd-2 pt-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-text-1 text-[12px] font-medium">
              Internet access
            </span>
            <span className="text-text-4 text-[10px] uppercase tracking-wider">
              via auravcs.com
            </span>
          </div>

          {!relay.running ? (
            <div className="flex flex-col gap-3">
              <p className="text-text-2 text-[12.5px] leading-relaxed">
                Connect a phone that isn't on your Wi-Fi. Aura gives you a
                short code — share the link and your phone reaches this
                computer over the internet.
              </p>
              <Button
                variant="default"
                size="default"
                onClick={relayStart}
                disabled={relayBusy}
                className="self-start"
              >
                {relayBusy ? "Connecting…" : "Turn on internet access"}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-text-4 text-[10px] uppercase tracking-wider mb-0.5">
                    Open on phone
                  </div>
                  <div className="text-text-1 text-[13px] font-mono break-all">
                    {relay.public_url}
                  </div>
                  <div className="text-text-4 text-[10.5px] mt-1">
                    Code <span className="font-mono text-text-2 tracking-[0.2em]">{relay.code}</span>
                  </div>
                </div>
                {relayQr && (
                  <img
                    src={relayQr}
                    alt="QR"
                    width={104}
                    height={104}
                    className="rounded bg-white p-1"
                  />
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="default"
                  onClick={relayStop}
                  disabled={relayBusy}
                >
                  Disconnect
                </Button>
                {relay.public_url && (
                  <Button
                    variant="secondary"
                    size="default"
                    onClick={() => {
                      if (relay.public_url)
                        navigator.clipboard.writeText(relay.public_url);
                    }}
                  >
                    Copy URL
                  </Button>
                )}
              </div>

              <div className="text-text-4 text-[10.5px] leading-relaxed">
                The code changes every time you reconnect. Aura's cloud
                only passes the connection between your phone and this
                computer — it doesn't read your code or your agents' work.
              </div>
            </div>
          )}

          {relayError && (
            <div className="text-[11.5px] text-fg-error">
              {relayError}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
