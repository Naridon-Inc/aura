// The app's one loader. Amber braille frames — if something in this product
// is working, this is what says so, on every surface, at every size.
//
// The header here used to describe a two-loader system: braille for "agent
// thinking", a rotating lucide circle for "panel reloading". Half of that was
// never true. A refresh glyph spinning on the refresh button you just pressed
// is that BUTTON's busy state — the circular arrow is already the thing you
// clicked, so rotating it says "your press landed", and those stay. But four
// surfaces read the sentence as licence to draw a loader of their own:
// `Loader2` stood in for a running check in the PR checks tab, for live agents
// in the crew block, and inside the create-workspace button, and `GoalsPane`
// hand-drew an SVG arc. Four glyphs for "this is running", one of them not in
// the stated system at all.
//
// So the rule is just: something working → this. A refresh control busy with
// its own press → spin its own icon. Nothing else spins.
//
// `size` exists so this can stand in an icon slot. Status glyphs in this app
// are lucide icons taking `size={13}`, and without a matching prop every
// surface that wanted the house loader beside them had to wrap it — which is
// how you end up with four spinners. It's a font-size in px, because this is
// a text glyph, not an SVG.
//
// Lifted from superset.sh's AsciiSpinner. One shared interval would scale
// better if we ever render dozens at once; for the few we mount today the
// per-instance interval is fine.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { cn } from "../../lib/utils";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

export function AsciiSpinner({
  className,
  size,
}: {
  className?: string;
  /** Font size in px, for standing beside lucide icons at their `size`. Leave
   *  it off and the spinner takes the surrounding type size, which is what
   *  every call site inside a line of text wants. */
  size?: number;
}): JSX.Element {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className={cn("font-mono select-none text-amber", className)}
      style={size ? { fontSize: `${size}px`, lineHeight: 1 } : undefined}
      aria-hidden="true"
    >
      {FRAMES[i]}
    </span>
  );
}
