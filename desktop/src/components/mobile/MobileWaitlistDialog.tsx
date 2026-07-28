// The waitlist as a moment — a compact centred card, opened from the What's
// New note. Same bespoke-portal idiom as WhatsNewModal so the two read as one
// sequence when they appear back to back after an update.
//
// Everything about the form itself lives in MobileWaitlistPane; this file is
// only the frame.

import { createPortal } from "react-dom";
import { Smartphone, X } from "lucide-react";

import { MobileWaitlistPane } from "./MobileWaitlistPane";
import { Button } from "../ui/button";

export function MobileWaitlistDialog({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center p-6 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
      style={{ background: "rgba(5,5,5,0.55)", backdropFilter: "blur(3px)" }}
      onMouseDown={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-waitlist-title"
        className="w-full max-w-[420px] overflow-hidden rounded-xl shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150"
        style={{
          background: "var(--color-bg-1)",
          border: "1px solid var(--color-line)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="relative px-5 pt-5 pb-4"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 9%, var(--color-bg-1)) 0%, var(--color-bg-1) 100%)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded-md text-text-4 transition-colors hover:bg-bg-2 hover:text-text-2"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          <span
            className="grid h-9 w-9 place-items-center rounded-lg"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 16%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            <Smartphone className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>

          <div
            className="mt-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: "var(--color-accent)" }}
          >
            Coming soon
          </div>
          <h2
            id="mobile-waitlist-title"
            className="mt-1.5 text-[17px] font-semibold leading-snug text-text-1"
            style={{ textWrap: "balance" }}
          >
            Aura on your phone
          </h2>
        </div>

        <div className="border-t border-line-soft px-5 py-4">
          <MobileWaitlistPane
            footer={
              <Button variant="ghost" size="sm" onClick={onClose}>
                Not now
              </Button>
            }
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
