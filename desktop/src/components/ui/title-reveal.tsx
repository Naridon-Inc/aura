// A name that arrives in pixels, and a mark that builds in with it.
//
// Tabs and sidebar rows start out called what they are ("New chat", "Claude
// Code", "Untitled workspace") and later learn what they are about. When that
// happens the label re-forms letter by letter through a ripple of pixels, and
// the tab's mark swaps to the one that fits what it turned out to be, on the
// same beat. Which changes count, and every frame, are decided in
// lib/titleReveal.ts; this file only draws them.
//
// Both pieces render exactly their plain children when nothing is playing, so
// a row that never gets renamed carries no extra markup.

import { useEffect, useReducer, type CSSProperties, type ReactNode } from "react";
import { noteReveal, revealFrame, type RevealCell, type RevealState } from "../../lib/titleReveal";
import "./title-reveal.css";

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/** Re-render every display frame while a reveal plays, and stop the moment it
 *  ends — the render that finds it over is the one that shows the plain name. */
function useRevealTicker(state: RevealState | null): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const playing = state !== null;
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame === "undefined") return;
    let frame = requestAnimationFrame(function step() {
      tick();
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);
}

/** A frame's cells as text runs and pixels, consecutive letters joined so a
 *  long title is a handful of nodes rather than one per character. */
function drawCells(cells: RevealCell[]): ReactNode[] {
  const out: ReactNode[] = [];
  let run = "";
  cells.forEach((cell, i) => {
    if (cell.kind === "char") {
      run += cell.ch;
      return;
    }
    if (run) out.push(run);
    run = "";
    out.push(<i key={i} data-level={cell.level} />);
  });
  if (run) out.push(run);
  return out;
}

/**
 * A label that reveals itself when `text` changes for the same `revealKey`.
 *
 * `revealKey` names the thing, not the text: a tab's pane ref, a row's path.
 * Without one the label is plain text and never animates — two different
 * things that happen to share a slot must not read as one being renamed.
 *
 * Mount it inside the element that already truncates the label; it fills that
 * element and keeps its width to the new name's, so the strip does not jostle
 * while the pixels settle.
 */
export function TitleReveal({ revealKey, text }: { revealKey?: string; text: string }) {
  const state = revealKey
    ? noteReveal(`title:${revealKey}`, text, { reducedMotion: prefersReducedMotion() })
    : null;
  useRevealTicker(state);
  if (!state) return <>{text}</>;
  return (
    <span className="ui-title-reveal" data-revealing="">
      {/* The real name holds the width and is what a screen reader reads; the
          frame drawn over it is decoration. */}
      <span className="ui-title-reveal-final">{text}</span>
      <span className="ui-title-reveal-frame" aria-hidden="true">
        {drawCells(revealFrame(state.from, state.to, state.progress, state.seed))}
      </span>
    </span>
  );
}

/** Brightness steps the mark builds in through: few, so it reads as pixels
 *  snapping on rather than a smooth fade. */
const MARK_STEPS = 5;

/**
 * A tab's or row's mark that builds in when `markKey` changes for the same
 * `revealKey` — the mark for what the thing turned out to be, landing with its
 * new name. `markKey` is a word for which mark it is ("pending", "review",
 * "aura"), not the element, so a re-render never reads as a swap.
 */
export function RevealMark({
  revealKey,
  markKey,
  children,
}: {
  revealKey?: string;
  markKey: string;
  children: ReactNode;
}) {
  const state = revealKey
    ? noteReveal(`mark:${revealKey}`, markKey, { reducedMotion: prefersReducedMotion() })
    : null;
  useRevealTicker(state);
  if (!state) return <>{children}</>;
  const q = Math.ceil(state.progress * MARK_STEPS) / MARK_STEPS;
  const style = {
    "--reveal-mark-opacity": String(0.25 + 0.75 * q),
    "--reveal-mark-scale": String(0.55 + 0.45 * q),
  } as CSSProperties;
  return (
    <span className="ui-reveal-mark" data-revealing="" style={style}>
      {children}
    </span>
  );
}
