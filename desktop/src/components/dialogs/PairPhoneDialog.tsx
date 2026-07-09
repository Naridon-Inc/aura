// Pair-phone dialog. Shows a QR the Aura mobile companion scans to sign in —
// no code typing on the phone. This desktop is already signed in to Aura
// Cloud, so `cloud_pair_create` starts a device-code request and approves it
// on our behalf; the QR carries the cloud URL + the now-approved device_code,
// and the phone only has to poll once to collect its token.
//
// Showing the QR is the grant (same model as WhatsApp Web / Discord
// scan-to-login): only paint it for your own phone. The code expires in ~10
// minutes and is single-use, so a scanned QR is inert afterward.

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { api, type CloudPairResp } from "../../lib/api";
import { useQr } from "../../lib/qr";

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
      setRemaining(resp.expires_in);
    } catch (e) {
      setPair(null);
      setRemaining(null);
      setError(humanizeError(String(e)));
    } finally {
      setBusy(false);
    }
  }, []);

  // Mint a fresh code each time the dialog opens; drop it when it closes so a
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

  return (
    <Dialog open={open} onClose={onClose} title="Pair phone" width={420}>
      <div className="px-5 py-4 flex flex-col gap-4">
        <p className="text-text-2 text-[12.5px] leading-relaxed">
          Open the Aura app on your phone, tap{" "}
          <span className="text-text-1 font-medium">Scan QR code</span>, and
          point it here. Your phone signs in to the same account — nothing to
          type.
        </p>

        {error ? (
          <div className="flex flex-col gap-3">
            <div className="text-[12px] text-fg-error">{error}</div>
            <Button
              variant="default"
              size="default"
              onClick={create}
              disabled={busy}
              className="self-start"
            >
              {busy ? "Retrying…" : "Try again"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="relative h-[200px] w-[200px] rounded-lg bg-white p-2 flex items-center justify-center">
              {qr && !expired ? (
                <img src={qr} alt="Pairing QR code" className="h-full w-full" />
              ) : (
                <div className="text-[11.5px] text-neutral-500">
                  {expired ? "Code expired" : busy ? "Generating…" : ""}
                </div>
              )}
            </div>

            {pair && (
              <div className="flex flex-col items-center gap-1">
                <div className="text-text-4 text-[10px] uppercase tracking-wider">
                  Or enter this code
                </div>
                <div className="font-mono text-text-1 text-[15px] tracking-[0.18em]">
                  {pair.user_code}
                </div>
              </div>
            )}

            <div className="text-text-4 text-[11px]">
              {expired
                ? "This code is no longer valid."
                : remaining !== null
                  ? `Expires in ${formatRemaining(remaining)}`
                  : ""}
            </div>

            <Button
              variant="secondary"
              size="default"
              onClick={create}
              disabled={busy}
            >
              {busy ? "Refreshing…" : "Refresh code"}
            </Button>
          </div>
        )}

        <div className="text-text-4 text-[10.5px] leading-relaxed border-t border-bd-2 pt-3">
          Only scan this with your own phone. The code grants access to your
          account, expires in about 10 minutes, and works once.
        </div>
      </div>
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
  return raw.replace(/^Error:\s*/, "");
}
