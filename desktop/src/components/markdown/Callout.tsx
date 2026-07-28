/** GitHub-style callouts (alerts) — the box a `> [!NOTE]` blockquote becomes.
 *
 *  `remarkCallouts` tags the blockquote in the mdast with an `aura-callout`
 *  class plus `aura-callout-<type>`; every react-markdown surface then routes
 *  its `blockquote` override through {@link calloutFromBlockquote}, which
 *  swaps the tagged blockquote for one of these boxes and leaves ordinary
 *  quotes untouched.
 *
 *  The five types map to GitHub's five. Their colours are FIXED (not the
 *  theme-remapped `--color-*` tokens): a callout's colour *is* its meaning —
 *  a warning must read amber and a caution red in both light and dark — and
 *  `--color-amber` is repurposed to a slate-cyan "dirty" marker in the dark
 *  themes, which would turn a warning cyan. The low-alpha `color-mix`
 *  background keeps them legible on either ground. */

import type { ReactElement, ReactNode } from "react";
import {
  AlertTriangle,
  Info,
  Lightbulb,
  Megaphone,
  OctagonAlert,
  type LucideIcon,
} from "lucide-react";

export type CalloutType = "note" | "tip" | "important" | "warning" | "caution";

const CALLOUTS: Record<
  CalloutType,
  { label: string; Icon: LucideIcon; color: string }
> = {
  note: { label: "Note", Icon: Info, color: "#78a6df" },
  tip: { label: "Tip", Icon: Lightbulb, color: "#5fb38a" },
  important: { label: "Important", Icon: Megaphone, color: "#a78bfa" },
  warning: { label: "Warning", Icon: AlertTriangle, color: "#d9a441" },
  caution: { label: "Caution", Icon: OctagonAlert, color: "#d05a76" },
};

export function Callout({
  type,
  children,
}: {
  type: CalloutType;
  children: ReactNode;
}) {
  const { label, Icon, color } = CALLOUTS[type];
  return (
    <div
      className="aura-callout my-3 rounded-md px-3 py-2"
      style={{
        borderLeft: `3px solid ${color}`,
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
      }}
    >
      <div
        className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold not-italic"
        style={{ color }}
      >
        <Icon size={14} strokeWidth={2.2} />
        <span>{label}</span>
      </div>
      <div className="aura-callout-body not-italic">{children}</div>
    </div>
  );
}

function classList(cn: unknown): string[] {
  if (Array.isArray(cn)) return cn.map(String);
  if (typeof cn === "string") return cn.split(/\s+/);
  return [];
}

/** If a blockquote was tagged by `remarkCallouts`, return the matching callout
 *  box; otherwise `null` so the caller renders its ordinary blockquote. Keeps
 *  every renderer's callout handling to a single guard line. */
export function calloutFromBlockquote(
  className: unknown,
  children: ReactNode,
): ReactElement | null {
  const classes = classList(className);
  if (!classes.includes("aura-callout")) return null;
  const tagged = classes.find((c) => c.startsWith("aura-callout-"));
  const raw = tagged?.slice("aura-callout-".length);
  const type: CalloutType =
    raw && raw in CALLOUTS ? (raw as CalloutType) : "note";
  return <Callout type={type}>{children}</Callout>;
}
