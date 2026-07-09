// Tiny green/amber/red dot rendered next to a commit sha. Shows where
// Aura's pre-commit guard rated the commit's stated intent against
// the AST nodes it actually changed:
//
//   green   "aligned"  — every modified identifier appears in intent
//   amber   "drift"    — partial overlap (≥30% but <60%)
//   red     "diverged" — <30% overlap (signature of intent poisoning)
//   gray    "unknown"  — no commit message + no intent log entry
//
// Hovering reveals the score and banner label. Click is a no-op at
// this level — parent decides whether to open IntentInspector.

import { useIntentMatch, type IntentBanner } from "../lib/useIntentMatch";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

type Size = "xs" | "sm";

type Props = {
  repoRoot: string | null | undefined;
  sha: string;
  size?: Size;
  showLabel?: boolean;
  onClick?: () => void;
};

export function IntentMatchChip({
  repoRoot,
  sha,
  size = "xs",
  showLabel = false,
  onClick,
}: Props) {
  const m = useIntentMatch(repoRoot, sha);
  const tone = bannerTone(m.banner);
  const dotSize = size === "xs" ? "size-1.5" : "size-2";
  const pct = Math.round(m.score * 100);

  const body = (
    <span
      className={`inline-flex items-center gap-1 ${onClick ? "cursor-pointer hover:opacity-80" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <span
        className={`${dotSize} rounded-full shrink-0`}
        style={{ background: tone.dot }}
      />
      {showLabel && (
        <span className="text-[10px] font-medium" style={{ color: tone.text }}>
          {tone.label}
        </span>
      )}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="top" className="text-[11px] font-mono">
        {m.loading ? (
          <span>Checking…</span>
        ) : m.banner === "unknown" ? (
          <span>Nothing recorded to check against</span>
        ) : (
          <span>
            {tone.label} · {pct}% of the changes match what was asked
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function bannerTone(b: IntentBanner): {
  dot: string;
  text: string;
  label: string;
} {
  // Plain words that mirror the Alignment tab, so the same idea reads the
  // same everywhere (no "aligned / drift / diverged" jargon for non-engineers).
  if (b === "aligned")
    return {
      dot: "var(--color-green)",
      text: "var(--color-green)",
      label: "Matches",
    };
  if (b === "drift")
    return {
      dot: "var(--color-amber, #d4a017)",
      text: "var(--color-amber, #d4a017)",
      label: "Needs review",
    };
  if (b === "diverged")
    return {
      dot: "var(--color-red)",
      text: "var(--color-red)",
      label: "No clear match",
    };
  return {
    dot: "color-mix(in oklab, var(--color-text-3) 50%, transparent)",
    text: "var(--color-text-3)",
    label: "Not checked",
  };
}
