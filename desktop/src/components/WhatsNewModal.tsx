// The one-time "What's new" card shown once after a MAJOR update. Dismissing
// (Esc, backdrop, the X, or "Got it") marks the version seen upstream, so it
// never shows again.
//
// Sized to its content — a compact centred card, not the full-height focus
// panel it used to inherit. Rendered bespoke through a portal (the same idiom
// as BrainSwitcherModal) so nothing forces it taller than the highlights it
// holds. Plain-language only: the highlights say what the user can now DO,
// never the mechanism. Emerald — the app's one accent — carries the header
// chip, the eyebrow, the row markers, and the primary button; everything
// else stays on the neutral ramp.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";

import { Button } from "./ui/button";
import { MODAL_BACKDROP, MODAL_ESC_HINT, MODAL_FOOTER, MODAL_PANEL } from "./ui/modalSurface";
import { cn } from "../lib/utils";
import type { ReleaseNote } from "../lib/releaseNotes";

type Props = {
  note: ReleaseNote;
  onDismiss: () => void;
  /** Called when the note offers an action and the user takes it. The modal
   *  closes itself first, so the action opens onto a clear screen. */
  onCta?: (kind: NonNullable<ReleaseNote["cta"]>["kind"]) => void;
};

export function WhatsNewModal({ note, onDismiss, onCta }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Land focus on the primary action so Enter/Space dismisses immediately.
  useEffect(() => {
    const id = requestAnimationFrame(() => confirmRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  return createPortal(
    <div
      className={cn(
        MODAL_BACKDROP,
        "z-[70] flex items-center justify-center p-6 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150",
      )}
      onMouseDown={onDismiss}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        }
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whatsnew-title"
        // The shared card recipe, plus the one thing it does not cover: a
        // height cap and a column, so the highlights below can be the scroll
        // region instead of the card growing past the viewport.
        className={cn(
          MODAL_PANEL,
          "flex max-h-[calc(100vh-3rem)] max-w-[440px] flex-col motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header — a whisper of accent so the card reads as a moment, not a
            dialog, without a heavy hero. */}
        <div
          className="relative shrink-0 px-4 pt-4 pb-3.5"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 9%, var(--color-bg-1)) 0%, var(--color-bg-1) 100%)",
          }}
        >
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
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
            <Sparkles className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>

          <div
            className="mt-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: "var(--color-accent)" }}
          >
            What&rsquo;s new · {note.version}
          </div>
          <h2
            id="whatsnew-title"
            className="mt-1.5 text-[17px] font-semibold leading-snug text-text-1"
            style={{ textWrap: "balance" }}
          >
            {note.title}
          </h2>
        </div>

        {/* Highlights — each a small emerald block marker (the app's sharp-block
            identity) beside one plain-language line.
            This is the one part that grows without bound: a big release carries
            three times the highlights of a small one, and the card is clipped to
            the viewport. So the list — not the card — is the scroll region, which
            keeps the title and the "Got it" button reachable at any length. */}
        <ul className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain border-t border-line-soft px-4 py-3">
          {note.highlights.map((h, i) => (
            <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-text-1">
              <span
                className="mt-[6px] h-[6px] w-[6px] shrink-0 rounded-sm"
                style={{ background: "var(--color-accent)" }}
                aria-hidden="true"
              />
              <span>{h}</span>
            </li>
          ))}
        </ul>

        {/* shrink-0 so a long highlights list scrolls against this bar rather
            than squeezing it out of reach. */}
        <div className={cn(MODAL_FOOTER, "shrink-0")}>
          <span className={MODAL_ESC_HINT}>esc to close</span>
          {note.cta && onCta && (
            <Button
              variant="subtle"
              size="xs"
              onClick={() => {
                const { kind } = note.cta!;
                onDismiss();
                onCta(kind);
              }}
            >
              {note.cta.label}
            </Button>
          )}
          <Button ref={confirmRef} size="xs" onClick={onDismiss}>
            Got it
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
