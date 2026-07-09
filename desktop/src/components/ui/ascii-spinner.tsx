// Braille-frame spinner — distinct from the lucide refresh-circle
// rotation we use elsewhere so the eye can tell "agent thinking" apart
// from "panel reloading". Lifted from superset.sh's AsciiSpinner. One
// shared interval would scale better if we ever render dozens at once;
// for the few we mount today the per-instance interval is fine.

import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

export function AsciiSpinner({ className }: { className?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className={cn("font-mono select-none text-amber", className)}
      aria-hidden="true"
    >
      {FRAMES[i]}
    </span>
  );
}
