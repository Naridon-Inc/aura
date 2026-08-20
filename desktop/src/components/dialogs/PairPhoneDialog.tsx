// Pair-phone overlay. Shows a QR the Aura mobile companion scans to sign in —
// no code typing on the phone. This desktop is already signed in to Aura
// Cloud, so `cloud_pair_create` starts a device-code request and approves it
// on our behalf; the QR carries the cloud URL + the now-approved device_code,
// and the phone only has to poll once to collect its token.
//
// Presented full-screen over a dimmed backdrop (not a small dialog card) so the
// QR is large and scans in one pass from across a desk. Showing the QR is the
// grant (same model as WhatsApp Web / Discord scan-to-login): only paint it for
// your own phone. The code expires in ~10 minutes and is single-use, so a
// scanned QR is inert afterward.

import { useCallback, useEffect, useState } from "react";
import { IconButton } from "@medusajs/ui";
import { XMark } from "@medusajs/icons";
import { Button } from "../ui/button";
import { AsciiSpinner } from "../ui/ascii-spinner";
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

  // Esc closes the overlay.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const expired = remaining !== null && remaining <= 0;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Pair phone"
      onClick={onClose}
    >
      <IconButton
        type="button"
        size="large"
        variant="transparent"
        onClick={onClose}
        aria-label="Close"
        title="Close (esc)"
        className="absolute right-6 top-6 text-white/70 hover:text-white"
      >
        <XMark aria-hidden />
      </IconButton>

      {/* Stop backdrop clicks from bubbling so tapping the content never closes. */}
      <div
        className="flex flex-col items-center gap-6 px-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
          <h2 className="text-lg font-medium text-white">Pair phone</h2>
          <p className="text-base leading-relaxed text-white/60">
            Open the Aura app on your phone, tap{" "}
            <span className="font-medium text-white/90">Scan QR code</span>, and
            point it at this screen. Your phone signs in to the same account. 
            nothing to type.
          </p>
        </div>

        {error ? (
          <div className="flex flex-col items-center gap-4">
            <div role="alert" className="max-w-[380px] text-center text-base text-red">
              {error}
            </div>
            <Button
              variant="default"
              size="lg"
              onClick={create}
              disabled={busy}
            >
              {busy ? "Retrying…" : "Try again"}
            </Button>
          </div>
        ) : (
          <>
            {/* Large white QR panel — sized to fill most of the viewport's
                shorter side so it reads from a distance, capped for big screens. */}
            <div
              className="relative flex items-center justify-center rounded-2xl bg-white p-5 shadow-2xl"
              style={{
                width: "min(70vmin, 460px)",
                height: "min(70vmin, 460px)",
              }}
            >
              {qr && !expired ? (
                <img
                  src={qr}
                  alt="Pairing QR code"
                  className="h-full w-full"
                />
              ) : (
                <div className="flex items-center gap-2 text-md text-neutral-500">
                  {expired ? (
                    "Code expired"
                  ) : (
                    <>
                      <AsciiSpinner /> Generating…
                    </>
                  )}
                </div>
              )}
            </div>

            {pair && (
              <div className="flex flex-col items-center gap-1">
                <div className="section-label text-white/40">
                  Or enter this code
                </div>
                <div className="font-mono text-xl tracking-[0.22em] text-white/90">
                  {pair.user_code}
                </div>
              </div>
            )}

            <div className="flex items-center gap-4">
              <div className="text-sm text-white/45">
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
          </>
        )}

        <div className="max-w-[380px] text-center text-sm leading-relaxed text-white/35">
          Only scan this with your own phone. The code grants access to your
          account, expires in about 10 minutes, and works once.
        </div>
      </div>
    </div>
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
