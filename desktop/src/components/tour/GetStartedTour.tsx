// The get-started tour: a short walk through the real app.
//
// A step that names a place (the workspace list, the agent picker, the
// dashboard, Trace) dims the rest of the window, rings that place, and says
// its piece in the shared popover beside it. A step that names a page clicks
// it on enter,
// so the app switches behind the ring — the reader watches the real app move,
// not a screenshot. Steps with nowhere to point (the welcome and the finish)
// use the shared dialog.
//
// If a step's place isn't on screen (an older layout, a hidden section) the
// step falls back to the dialog, so its words still land.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { TOUR_STEPS, findTourAnchor, type TourStep } from "../../lib/tour/tourSteps";
import "../ui/tour.css";

type Props = {
  open: boolean;
  /** Called on finish, skip, close or Esc — the caller marks the tour seen
   *  and closes it. */
  onClose: () => void;
};

type Rect = { top: number; left: number; width: number; height: number };

// Room left between the ring and the place it rings.
const PAD = 6;

export function GetStartedTour({ open, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step: TourStep | undefined = TOUR_STEPS[index];
  const total = TOUR_STEPS.length;

  // Start from the top whenever the tour (re)opens.
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // Find the step's place and keep its box current. A step that switches
  // surface clicks first, then measures once the new section has laid out.
  useEffect(() => {
    if (!open || !step) return;

    let raf = 0;
    let ro: ResizeObserver | null = null;

    const apply = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };

    const measure = () => {
      const el = findTourAnchor(step);
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

    if (step.activate) findTourAnchor(step)?.click();

    // Two frames: one for React to draw the switched section, one to
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

  // Keyboard: → / Enter advance, ← back, Esc skips. Captured so it beats
  // the handlers of the surface behind the tour.
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

  const footer = (
    <TourFooter
      step={step}
      index={index}
      total={total}
      onNext={next}
      onBack={back}
      onSkip={onClose}
    />
  );

  // Welcome, finish, or a place that isn't on screen: the dialog.
  if (!rect) {
    return (
      <Dialog open onOpenChange={(next) => !next && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{step.title}</DialogTitle>
            <DialogDescription>{step.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="ui-tour-footer">{footer}</DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const side = step.placement && step.placement !== "center" ? step.placement : "right";
  const box = {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };

  return (
    // The dim lets clicks through, so a hit test never sees it; it names
    // itself so a terminal under it steps away instead of painting over it.
    <div className="ui-tour-layer" role="presentation" data-over-native-surface>
      <div className="ui-tour-ring" style={box} />
      <Popover open modal={false}>
        <PopoverAnchor asChild>
          <div className="ui-tour-anchor" style={box} />
        </PopoverAnchor>
        <PopoverContent
          side={side}
          align="center"
          className="ui-tour-popover"
          role="dialog"
          aria-labelledby="tour-title"
          // The tour moves on by its own buttons and keys, not by a click
          // somewhere else in the window.
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <strong id="tour-title">{step.title}</strong>
          <p>{step.body}</p>
          <div className="ui-tour-footer">{footer}</div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TourFooter({
  step,
  index,
  total,
  onNext,
  onBack,
  onSkip,
}: {
  step: TourStep;
  index: number;
  total: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const isLast = index === total - 1;
  return (
    <>
      <span className="ui-tour-count">
        {index + 1} of {total}
      </span>
      {index === 0 ? (
        <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
          Skip
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
      )}
      {step.cta ? (
        <Button
          type="button"
          size="sm"
          onClick={() => {
            window.dispatchEvent(new Event(step.cta!.event));
            onNext(); // last step → closes; the handoff takes over
          }}
        >
          {step.cta.label}
        </Button>
      ) : (
        <Button type="button" size="sm" onClick={onNext}>
          {isLast ? "Get started" : "Next"}
        </Button>
      )}
    </>
  );
}
