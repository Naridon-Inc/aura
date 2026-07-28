// Shared presentational bits for the Workspaces center view — the same pills,
// glyphs, and agent chips read identically in the time list and the status
// board. All calm, all real: a row with no diff / no PR / no agent simply
// renders nothing for that slot.

import { AgentIcon } from "../agent/AgentIcon";
import { compactCount, statusMeta, type CopyAgent, type CopyStatus } from "./workspacesModel";

// Stable, subtle per-folder tint (FNV-1a hash → hue), matching the roster's
// folderTint so a project reads the same colour in the sidebar and the view.
function folderTint(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = (h >>> 0) % 360;
  return `hsl(${hue} 24% 62%)`;
}

// Small project avatar — emoji when the workspace has one, else its letter on
// a tinted chip. Kept lightweight (no async image fetch) so a 40-copy list
// paints instantly.
export function ProjectGlyph({
  root,
  emoji,
  letter,
  accent,
  size = 18,
}: {
  root: string;
  emoji?: string;
  letter: string;
  accent?: string;
  size?: number;
}) {
  const tint = accent || folderTint(root);
  if (emoji) {
    return (
      <span
        aria-hidden
        style={{ fontSize: size - 2, lineHeight: 1 }}
        className="inline-flex items-center justify-center flex-none"
      >
        {emoji}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center flex-none rounded-md font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.55,
        color: tint,
        background: `color-mix(in srgb, ${tint} 18%, transparent)`,
      }}
    >
      {letter.toUpperCase()}
    </span>
  );
}

// "+207 −1" — green adds, red dels. Nothing when the copy is clean.
// `--color-green` and `--color-red` are the pack's own diff pair; the old
// `--color-success` / `--color-danger` names are defined by no theme here, so
// these only ever rendered their hard-coded fallbacks — two hues the palette
// does not contain, frozen against every retune.
export function DiffPill({ added, removed }: { added: number; removed: number }) {
  if (added <= 0 && removed <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] tabular-nums flex-none">
      {added > 0 && (
        <span style={{ color: "var(--color-green)" }}>
          +{compactCount(added)}
        </span>
      )}
      {removed > 0 && (
        <span style={{ color: "var(--color-red)" }}>
          −{compactCount(removed)}
        </span>
      )}
    </span>
  );
}

// "#816" pill, tinted by open/merged/closed. Nothing when there's no PR.
export function PrPill({ pr }: { pr?: { number: number; state: string } }) {
  if (!pr) return null;
  const state = pr.state.toLowerCase();
  // merged = landed (the accent, the one PR state you can still navigate to),
  // closed = went nowhere (red), open = live (mint). Was three undefined token
  // names falling through to a violet/red/green trio the palette never had.
  const tint =
    state === "merged"
      ? "var(--color-accent)"
      : state === "closed"
        ? "var(--color-red)"
        : "var(--color-accent-green)";
  return (
    <span
      className="inline-flex items-center h-[17px] px-1.5 rounded text-[10px] font-medium tabular-nums flex-none border"
      style={{
        color: tint,
        borderColor: `color-mix(in srgb, ${tint} 40%, transparent)`,
        background: `color-mix(in srgb, ${tint} 12%, transparent)`,
      }}
      title={`PR #${pr.number} · ${pr.state}`}
    >
      #{pr.number}
    </span>
  );
}

// Up to three agent brand marks; the first waiting-on-you agent gets an amber
// ring. "+N" when more are parked than fit.
export function AgentChips({ agents }: { agents: CopyAgent[] }) {
  if (!agents.length) return null;
  const shown = agents.slice(0, 3);
  const extra = agents.length - shown.length;
  return (
    <span className="inline-flex items-center gap-1 flex-none">
      {shown.map((a, i) => (
        <span
          key={`${a.agentId}-${i}`}
          className="inline-flex rounded-full"
          title={`${a.label}${a.attention ? " · waiting on you" : ""}`}
          style={
            a.attention
              // The comment above already calls this an amber ring — it just
              // named a token no theme defines, so it was drawing a literal.
              ? { boxShadow: "0 0 0 1.5px var(--color-amber)" }
              : undefined
          }
        >
          <AgentIcon agentId={a.agentId} label={a.label} size={15} />
        </span>
      ))}
      {extra > 0 && (
        <span className="text-[10px] text-text-4 tabular-nums">+{extra}</span>
      )}
    </span>
  );
}

// A 6px status swatch — the same colour language as the board columns.
export function StatusDot({ status }: { status: CopyStatus }) {
  const { tint, label } = statusMeta(status);
  return (
    <span
      aria-label={label}
      title={label}
      className="inline-block flex-none rounded-full"
      style={{ width: 6, height: 6, background: tint }}
    />
  );
}
