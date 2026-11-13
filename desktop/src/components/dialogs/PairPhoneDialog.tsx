// Pair phone. Shows a QR the Aura mobile companion scans to sign in, with no
// code typing on the phone. This desktop is already signed in to Aura Cloud,
// so `cloud_pair_create` starts a device-code request and approves it on our
// behalf; the QR carries the cloud URL + the now-approved device_code, and the
// phone only has to poll once to collect its token.
//
// The shared dialog is the frame, with the QR as large as the window allows
// so it scans in one pass from across a desk. Showing the QR is the grant
// (same model as scan-to-login on a messaging web app): only paint it for
// your own phone. The code expires in ~10 minutes and is single-use, so a
// scanned QR is inert afterward.

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { api, type CloudPairResp } from "../../lib/api";
import { useQr } from "../../lib/qr";
import "../ui/pair-phone.css";

type PairPhoneDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function PairPhoneDialog({ open, onClose }: PairPhoneDialogProps) {
  const [pair, setPair] = useState<CloudPairResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seconds left before the code expires; null until a code is minted.
  const [remaining, setRemaining] = useState<number | null>(null);

  const qr = useQr(pair?.qr_payload ?? "");

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const resp = await api.cloudPairCreate();
      setPair(resp);
      setRemaining(Number.isFinite(resp.expires_in) ? resp.expires_in : null);
    } catch (e) {
      setPair(null);
      setRemaining(null);
      setError(humanizeError(String(e)));
    } finally {
      setBusy(false);
    }
  }, []);

  // Mint a fresh code each time the overlay opens; drop it when it closes so a
  // stale QR never lingers on screen.
  useEffect(() => {
    if (open) {
      void create();
    } else {
      setPair(null);
      setRemaining(null);
      setError(null);
    }
  }, [open, create]);

  // Count the code down so the user knows when to refresh.
  useEffect(() => {
    if (!open || remaining === null) return;
    const id = setInterval(() => {
      setRemaining((r) => (r === null ? null : Math.max(0, r - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [open, remaining === null]);

  const expired = remaining !== null && remaining <= 0;

  const expiry = expired
    ? "This code is no longer valid."
    : remaining !== null
      ? `Expires in ${formatRemaining(remaining)}`
      : "";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="ui-pair-phone">
        <DialogHeader>
          <DialogTitle>Pair phone</DialogTitle>
          <DialogDescription>
            Open the Aura app on your phone, tap Scan QR code, and point it at
            this screen. Your phone signs in to the same account, with nothing
            to type.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <div className="ui-pair-phone-code">
            <div className="ui-pair-phone-qr">
              {qr && !expired ? (
                <img src={qr} alt="Pairing QR code" />
              ) : (
                <span>
                  {expired ? (
                    "Code expired"
                  ) : (
                    <>
                      <AsciiSpinner /> Generating…
                    </>
                  )}
                </span>
              )}
            </div>
            {pair && (
              <p className="ui-pair-phone-typed">
                Or enter this code <code>{pair.user_code}</code>
              </p>
            )}
          </div>
        )}

        <p className="ui-pair-phone-note">
          Only scan this with your own phone. The code grants access to your
          account, expires in about 10 minutes, and works once.
        </p>

        <DialogFooter>
          {!error && <span className="ui-pair-phone-expiry">{expiry}</span>}
          <Button variant="outline" size="sm" onClick={create} disabled={busy}>
            {error
              ? busy
                ? "Retrying…"
                : "Try again"
              : busy
                ? "Refreshing…"
                : "Refresh code"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatRemaining(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function humanizeError(raw: string): string {
  if (/sign in/i.test(raw)) {
    return "Sign in to Aura Cloud first, then pair your phone.";
  }
  if (/401|403/.test(raw)) {
    return "Your session has expired. Sign in again, then pair your phone.";
  }
  // Transport failures (DNS, timeout, refused) — reqwest surfaces these as
  // "error sending request". Speak to the person, not the stack.
  if (/sending request|timed out|timeout|dns|connect|network|unreachable|reach/i.test(raw)) {
    return "Couldn't reach Aura Cloud. Check your connection and try again.";
  }
  return raw.replace(/^Error:\s*/, "");
}
