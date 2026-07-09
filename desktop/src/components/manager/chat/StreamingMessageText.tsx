//! Cosmetic text-drip for streaming assistant prose.
//!
//! The brain delivers text in coarse SSE chunks — often a whole sentence at
//! once — which reads as a jerky "pop" rather than a smooth type-out. This
//! component decouples the *displayed* length from the *received* length: it
//! reveals 2 characters every 16ms (one animation frame's worth) while the
//! turn is live, catching up to whatever the brain has sent so far. Once the
//! turn ends (`streaming=false`) the full text is shown immediately — we never
//! hold back content after the model is done.
//!
//! The drip is presentation-only: the underlying `text` is the source of
//! truth, so a reload (which renders the persisted turn through `MarkdownBody`
//! directly, not this) shows the complete message with no animation.

import { useEffect, useRef, useState } from "react";

import { MarkdownBody } from "./Markdown";

const CHARS_PER_TICK = 2;
const TICK_MS = 16;

/** Reveal `text` two characters at a time while `streaming`. The revealed
 *  prefix is rendered through `MarkdownBody` so partial markdown still
 *  formats (a half-streamed `**bold` simply shows the literal until the
 *  closing marker arrives — same as the non-animated path). A trailing
 *  cursor is shown while the reveal is still catching up. */
export function StreamingMessageText({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  // How many characters of `text` are currently revealed. Held in state so a
  // tick re-renders; held in a ref too so the interval reads the live value
  // without re-subscribing every frame.
  const [shown, setShown] = useState(streaming ? 0 : text.length);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    // Not streaming → reveal everything at once and stop any running timer.
    if (!streaming) {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setShown(text.length);
      return;
    }
    // If the source text shrank (a stream reset / new turn reusing the same
    // mount) clamp the cursor so we don't read past the end.
    if (shownRef.current > text.length) setShown(text.length);
    // Already caught up — nothing to animate until more text arrives.
    if (shownRef.current >= text.length) {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (timerRef.current != null) return; // a timer is already draining
    timerRef.current = window.setInterval(() => {
      setShown((prev) => {
        const next = Math.min(prev + CHARS_PER_TICK, text.length);
        if (next >= text.length && timerRef.current != null) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return next;
      });
    }, TICK_MS);
    return () => {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [text, streaming]);

  const revealed = streaming ? text.slice(0, shown) : text;
  const catchingUp = streaming && shown < text.length;
  return <MarkdownBody source={revealed} trailingCursor={catchingUp} />;
}
