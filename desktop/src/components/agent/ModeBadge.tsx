// ModeBadge — visual identity for a run/model mode. The headline case is
// "auto" (Claude's per-task auto-routing), which previously read as bare
// "Auto · <model>" text. A small pill with a mode glyph + label so a mode is
// recognisable at a glance, matched to the footer chip skin. Used in the
// StatusBar model picker today; reusable anywhere a mode is shown (the user:
// "auto and such modes should have proper visual identity").

import { type CSSProperties } from "react";
import { cn } from "../../lib/utils";

const ACCENT = "var(--color-accent, #a78bfa)";

function AutoSparkle({ size = 11 }: { size?: number }) {
  // A compact "auto" sparkle — deliberately unlike any agent brand mark.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d="M12 2l1.6 4.8L18 8l-4.4 1.2L12 14l-1.6-4.8L6 8l4.4-1.2z" />
      <path d="M18 13l.9 2.6L21 16l-2.1.6L18 19l-.9-2.4L15 16l2.1-.4z" opacity="0.8" />
    </svg>
  );
}

export function ModeBadge({
  mode,
  sub,
  className,
}: {
  mode: string;
  /** Optional secondary text — e.g. the concrete model running under Auto. */
  sub?: string | null;
  className?: string;
}) {
  const isAuto = mode.trim().toLowerCase() === "auto";
  const style: CSSProperties = isAuto
    ? { color: ACCENT, background: `color-mix(in srgb, ${ACCENT} 14%, transparent)` }
    : { background: "var(--color-bg-2)" };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px]",
        isAuto ? "" : "text-text-2",
        className,
      )}
      style={style}
      title={isAuto ? "Auto — the system picks a model per task" : mode}
    >
      {isAuto ? <AutoSparkle /> : null}
      <span className="font-medium">{isAuto ? "Auto" : mode}</span>
      {sub ? <span className="text-text-4">· {sub}</span> : null}
    </span>
  );
}
