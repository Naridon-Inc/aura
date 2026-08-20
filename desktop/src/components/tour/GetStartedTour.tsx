// The Get-started tour engine. A bespoke spotlight walkthrough (no tour
// library) rendered through a portal — the same idiom as WhatsNewModal.
//
// Each step either spotlights a real UI element (dims the rest of the screen,
// rings the anchor in accent, floats a bubble beside it) or, for the
// welcome/finish beats, shows a centered card. Steps that name a surface click
// their anchor on enter so the app switches to that surface behind the
// spotlight — the user watches the real app move, not a screenshot.
//
// Robust by design: if an anchor isn't in the DOM (e.g. a legacy layout
// without the section buttons), the step degrades to a centered card so its
// copy still lands. All colour comes from the theme tokens (var(--color-*)),
// never literal hex, so the tour tracks every theme variant.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";

import { Button } from "../ui/button";
import { TOUR_STEPS, type TourStep } from "../../lib/tour/tourSteps";

type Props = {
  open: boolean;
  /** Called on finish, skip, X, backdrop-Esc — the caller marks the tour
   *  seen and closes it. */
  onClose: () => void;
};

type Rect = { top: number; left: number; width: number; height: number };

// Spotlight padding around the anchor, and the gap between anchor and bubble.
const PAD = 6;
const GAP = 14;

export function GetStartedTour({ open, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step: TourStep | undefined = TOUR_STEPS[index];
  const total = TOUR_STEPS.length;

  // Start from the top whenever the tour (re)opens.
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // Resolve and keep the anchor rect in sync for the current step. When the
  // step asks to switch surface, click the anchor first, then measure on the
  // next frame once the newly-shown section has laid out.
  useEffect(() => {
    if (!open || !step) return;

    let raf = 0;
    let ro: ResizeObserver | null = null;

    const apply = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };

    const measure = () => {
      if (!step.anchor) {
        setRect(null);
        return;
      }
      const el = document.querySelector(step.anchor) as HTMLElement | null;
      if (!el) {
        setRect(null);
        return;
      }
      apply(el);
      if (!ro) {
        ro = new ResizeObserver(() => apply(el));
        ro.observe(el);
      }
    };

    if (step.anchor && step.activate) {
      const el = document.querySelector(step.anchor) as HTMLElement | null;
      el?.click();
    }

    // Two frames: one for React to re-render the switched section, one to
    // measure the settled layout.
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(measure);
    });

    const onViewportChange = () => measure();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      ro?.disconnect();
    };
  }, [open, step]);

  const next = useCallback(() => {
    setIndex((i) => {
      if (i >= total - 1) {
        onClose();
        return i;
      }
      return i + 1;
    });
  }, [total, onClose]);

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Keyboard: → / Enter advance, ← back, Esc skips. Capture so it beats
  // surface-level handlers behind the overlay.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, next, back, onClose]);

  if (!open || !step) return null;

  const centered = !rect; // welcome / finish, or an anchor that wasn't found

  return createPortal(
    <div
      className="fixed inset-0 z-[80] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
      role="presentation"
    >
      {centered ? (
        <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px]" />
      ) : (
        <div
          className="absolute pointer-events-none transition-all duration-200"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 10,
            // Same scrim the app's dialogs use (black/55), punched out around the
            // highlighted element by a huge spread.
            boxShadow:
              "0 0 0 9999px rgb(0 0 0 / 0.55), 0 0 0 2px var(--color-accent), 0 0 22px 2px color-mix(in srgb, var(--color-accent) 55%, transparent)",
          }}
        />
      )}

      <TourBubble
        step={step}
        rect={rect}
        index={index}
        total={total}
        onNext={next}
        onBack={back}
        onSkip={onClose}
      />
    </div>,
    document.body,
  );
}

function TourBubble({
  step,
  rect,
  index,
  total,
  onNext,
  onBack,
  onSkip,
}: {
  step: TourStep;
  rect: Rect | null;
  index: number;
  total: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const isLast = index === total - 1;

  // Position the bubble once it (and the anchor rect) are measurable. Placed
  // beside the anchor per the step's placement, then flipped/clamped to stay
  // on screen. Centered when there's no anchor.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const bw = node.offsetWidth;
    const bh = node.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 12; // viewport margin

    if (!rect) {
      setPos({ left: (vw - bw) / 2, top: (vh - bh) / 2 });
      return;
    }

    const placement = step.placement ?? "right";
    let left: number;
    let top: number;

    if (placement === "left") {
      left = rect.left - GAP - bw;
      top = rect.top + rect.height / 2 - bh / 2;
    } else if (placement === "top") {
      left = rect.left + rect.width / 2 - bw / 2;
      top = rect.top - GAP - bh;
    } else if (placement === "bottom") {
      left = rect.left + rect.width / 2 - bw / 2;
      top = rect.top + rect.height + GAP;
    } else {
      // right
      left = rect.left + rect.width + GAP;
      top = rect.top + rect.height / 2 - bh / 2;
    }

    // Flip horizontally if the preferred side overflows.
    if (placement === "right" && left + bw > vw - M) {
      left = rect.left - GAP - bw;
    } else if (placement === "left" && left < M) {
      left = rect.left + rect.width + GAP;
    }

    left = Math.max(M, Math.min(left, vw - bw - M));
    top = Math.max(M, Math.min(top, vh - bh - M));
    setPos({ left, top });
  }, [rect, step]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      className="absolute w-[340px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
        background: "var(--color-bg-1)",
        border: "1px solid var(--color-line)",
      }}
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
          onClick={onSkip}
          aria-label="Skip tour"
          className="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded-md text-text-4 transition-colors hover:bg-state-hover hover:text-text-2"
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

        <div className="eyebrow mt-3">
          {step.eyebrow ?? "Get started"}
        </div>
        <h2
          id="tour-title"
          className="mt-1.5 text-lg font-semibold leading-snug text-text-1"
          style={{ textWrap: "balance" }}
        >
          {step.title}
        </h2>
      </div>

      <p className="border-t border-line-soft px-5 py-4 text-base leading-relaxed text-text-2">
        {step.body}
      </p>

      <div className="flex items-center justify-between border-t border-line-soft px-5 py-3.5">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              className="h-1.5 rounded-full transition-all"
              style={{
                width: i === index ? 16 : 6,
                background:
                  i === index
                    ? "var(--color-accent)"
                    : "var(--color-line)",
              }}
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          {index === 0 ? (
            <button
              type="button"
              onClick={onSkip}
              className="text-sm text-text-4 transition-colors hover:text-text-2"
            >
              Skip
            </button>
          ) : (
            <button
              type="button"
              onClick={onBack}
              className="text-sm text-text-3 transition-colors hover:text-text-1"
            >
              Back
            </button>
          )}
          {step.cta ? (
            <Button
              size="sm"
              onClick={() => {
                window.dispatchEvent(new Event(step.cta!.event));
                onNext(); // last step → closes; the handoff takes over
              }}
            >
              {step.cta.label}
            </Button>
          ) : (
            <Button size="sm" onClick={onNext}>
              {isLast ? "Get started" : "Next"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
