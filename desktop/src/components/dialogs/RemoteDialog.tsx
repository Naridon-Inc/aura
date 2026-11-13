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
//
// The frame is the shared dialog, the same one Pair phone uses: two tabs
// (same Wi-Fi, or anywhere through auravcs.com), each either one sentence
// and a Turn on button, or the QR with its link and code under it.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Copy } from "lucide-react";

import { api, type RemoteRelayStatus } from "../../lib/api";
import { useQr } from "../../lib/qr";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tab-panels";
import "../ui/pair-phone.css";
import "../ui/remote-phone.css";

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

type Reach = "wifi" | "internet";

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
  const [reach, setReach] = useState<Reach>("wifi");
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
      .then((s) => {
        if (!mounted) return;
        setRelay(s);
        // Open on the link that's live, so a phone already reaching this
        // computer over the internet isn't hidden behind the Wi-Fi tab.
        if (s.running) setReach("internet");
      })
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

  // Listen for client-count changes from the backend so the count
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

  const wifiOn = status.running;
  const netOn = relay.running;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="ui-pair-phone ui-remote-phone">
        <DialogHeader>
          <DialogTitle>Use Aura on your phone</DialogTitle>
          <DialogDescription>
            Your phone drives whatever's running here. No login: the link
            carries a short code so only you can connect.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={reach} onValueChange={(v) => setReach(v as Reach)}>
          <TabsList aria-label="How your phone reaches this computer">
            <TabsTrigger value="wifi">
              Same Wi-Fi
              {wifiOn && <span className="ui-remote-phone-live" aria-label="on" />}
            </TabsTrigger>
            <TabsTrigger value="internet">
              Anywhere
              {netOn && <span className="ui-remote-phone-live" aria-label="on" />}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="wifi" className="ui-remote-phone-panel">
            {wifiOn ? (
              <Live
                qr={qr}
                url={status.url}
                codeLabel="PIN"
                code={status.pin}
                note="The PIN keeps other devices on your Wi-Fi from connecting by accident. It doesn't scramble the connection, though. Only share this link on a network you trust."
              />
            ) : (
              <p className="ui-remote-phone-off">
                Turn this on and a phone on the same Wi-Fi can open Aura from
                its browser.
              </p>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </TabsContent>

          <TabsContent value="internet" className="ui-remote-phone-panel">
            {netOn ? (
              <Live
                qr={relayQr}
                url={relay.public_url}
                codeLabel="Code"
                code={relay.code}
                note="The code changes every time you reconnect. Aura's cloud only passes the connection between your phone and this computer. It doesn't read your code or your agents' work."
              />
            ) : (
              <p className="ui-remote-phone-off">
                Connect a phone that isn't on your Wi-Fi. Aura gives you a
                short code; share the link and your phone reaches this
                computer over the internet, through auravcs.com.
              </p>
            )}
            {relayError && (
              <Alert variant="destructive">
                <AlertDescription>{relayError}</AlertDescription>
              </Alert>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          {reach === "wifi" ? (
            <>
              <span className="ui-pair-phone-expiry">
                {wifiOn
                  ? `${status.clients} ${status.clients === 1 ? "phone" : "phones"} connected`
                  : ""}
              </span>
              {wifiOn ? (
                <Button variant="outline" size="sm" onClick={stop} disabled={busy}>
                  {busy ? "Turning off…" : "Turn off"}
                </Button>
              ) : (
                <Button size="sm" onClick={start} disabled={busy}>
                  {busy ? "Turning on…" : "Turn on"}
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="ui-pair-phone-expiry" />
              {netOn ? (
                <Button variant="outline" size="sm" onClick={relayStop} disabled={relayBusy}>
                  {relayBusy ? "Disconnecting…" : "Disconnect"}
                </Button>
              ) : (
                <Button size="sm" onClick={relayStart} disabled={relayBusy}>
                  {relayBusy ? "Connecting…" : "Turn on"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A live link: the QR on its white ground, the link with a copy button, the
 *  code to type if the camera won't scan, and what the code does and doesn't
 *  protect. */
function Live({
  qr,
  url,
  codeLabel,
  code,
  note,
}: {
  qr: string | null;
  url: string | null;
  codeLabel: string;
  code: string | null;
  note: string;
}) {
  return (
    <>
      <div className="ui-pair-phone-code">
        <div className="ui-pair-phone-qr ui-remote-phone-qr">
          {qr ? <img src={qr} alt="QR code for the phone link" /> : <span>No link yet</span>}
        </div>
        {url && (
          <div className="ui-remote-phone-url">
            <code>{url}</code>
            <CopyLink url={url} />
          </div>
        )}
        {code && (
          <p className="ui-pair-phone-typed">
            {codeLabel} <code>{code}</code>
          </p>
        )}
      </div>
      <p className="ui-pair-phone-note">{note}</p>
    </>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={copied ? "Copied" : "Copy link"}
      aria-label={copied ? "Copied" : "Copy link"}
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => setCopied(true), () => {});
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
