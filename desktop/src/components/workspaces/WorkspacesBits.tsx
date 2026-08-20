// Shared presentational bits for the Workspaces center view — the same pills,
// glyphs, and agent chips read identically in the time list and the status
// board. All calm, all real: a row with no diff / no PR / no agent simply
// renders nothing for that slot.

import { AgentIcon } from "../agent/AgentIcon";
import { CloudGlyph } from "../ui/cloud-glyph";
import { labelForAgentId } from "../../lib/useLiveAgentSessions";
import type { CloudPlacement } from "../../lib/api";
import {
  prTint,
  statusMeta,
  type CopyAgent,
  type CopyStatus,
} from "./workspacesModel";
import { compactNumber } from "../../lib/compactNumber";

// The column every fleet lens reads in.
//
// A workspace row is a name, a diff badge and an age — text that ends a third
// of the way across a wide window. Run edge to edge and the age sits an inch of
// empty dark away from the name it belongs to, and the eye has to travel the
// whole window to pair them. So the fleet reads in a centred column, the width
// a list of names actually wants.
//
// The column is the page's, not one lens's: the filter strip, the All list and
// Live all share it, so the search caret and the first row's branch mark line
// up rather than each lens picking its own left edge. (It was once a
// `max-w-3xl` island on the All lens alone, which gave one page three of them.)
//
// The header bar is deliberately NOT in it. Tabs stay hard left and "New
// workspace" hard right, against the window — that bar is chrome for the whole
// surface, not part of what you're reading, and pulling it inward would leave
// the top of the page floating in the middle with dead space either side.
// Chrome frames the window; the column is for the text.
//
// The Board lens is the one deliberate exception: its lanes lay out
// horizontally, so a reading column would crush four of them into a third of
// the window. A board is a canvas, not a column.
export const FLEET_COLUMN = "mx-auto w-full max-w-4xl";

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
    <span className="inline-flex items-center gap-1.5 text-xs tabular-nums flex-none">
      {added > 0 && (
        <span style={{ color: "var(--color-green)" }}>
          +{compactNumber(added)}
        </span>
      )}
      {removed > 0 && (
        <span style={{ color: "var(--color-red)" }}>
          −{compactNumber(removed)}
        </span>
      )}
    </span>
  );
}

// "#816" pill, tinted by open/merged/closed. Nothing when there's no PR.
export function PrPill({ pr }: { pr?: { number: number; state: string } }) {
  if (!pr) return null;
  const tint = prTint(pr.state);
  return (
    <span
      className="inline-flex items-center h-[17px] px-1.5 rounded text-2xs font-medium tabular-nums flex-none border"
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

// "This one isn't running on your disk." Leads the signal cluster on both
// fleet lenses, because where the work is happening changes how everything
// beside it reads: a clean diff on a copy a runner is mid-turn on means the
// machine hasn't pushed yet, not that nothing is going on.
//
// It breathes only once a box has actually claimed the job. `submitted` is
// still queued, and a still glyph is the truthful picture of work nobody has
// picked up — a pulse there would claim a machine is on it when none is.
export function CloudMark({
  cloud,
  size = 13,
}: {
  cloud?: CloudPlacement;
  size?: number;
}) {
  if (!cloud) return null;
  const queued = cloud.status === "submitted";
  const who = labelForAgentId(cloud.agent);
  return (
    <span
      className="inline-flex flex-none items-center text-text-4"
      title={
        queued
          ? `Queued for a machine. ${who} hasn't started yet`
          : `Running on your machine in the cloud. ${who}`
      }
    >
      <CloudGlyph size={size} pulse={!queued} />
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
        <span className="text-2xs text-text-4 tabular-nums">+{extra}</span>
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
