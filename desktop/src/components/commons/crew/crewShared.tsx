// crewShared — the small UI atoms every Crew surface shares: the agent avatar,
// provenance chips, priority chip, the proof pill, status accents, and a
// plain-language relative-time. Kept here so the Queue tab, Activity tab and
// detail drawer read identically and nobody re-rolls a chip.

import {
  GitCommitHorizontal,
  ShieldCheck,
} from "lucide-react";
import { AsciiSpinner } from "../../ui/ascii-spinner";

import type { LoopTask } from "../../../lib/api";
import { AgentIcon } from "../../agent/AgentIcon";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import { StatusChip, type ChipTone } from "../../ui/statusChip";
import { StateGlyph } from "../../tasks/StatePill";
import { proofLabel, type CrewProof } from "./crewProof";

// One palette, used as a left-border accent everywhere. Arctic-blue for "ready
// to go", amber for "an agent is on it", green for done, red for a failure,
// muted for blocked/other. Green/red are status-only — never affordances.
export const CREW_ACCENT = {
  ready: "var(--color-accent)",
  working: "var(--color-amber)",
  done: "var(--color-accent-green)",
  failed: "var(--color-red)",
  blocked: "var(--color-text-5)",
  paused: "var(--color-text-5)",
  other: "var(--color-text-5)",
} as const;

export const PRIORITY_TONE: Record<string, ChipTone> = {
  critical: "red",
  high: "amber",
  medium: "blue",
  low: "neutral",
};

// Each lifecycle state → the SAME per-group glyph the tasks board draws
// (dashed ring / solid ring / half-conic / filled), tinted by our status
// palette. Started→half-fill (amber), ready→solid ring, blocked→dashed ring,
// paused→muted solid ring, done→filled green, failed→filled red. So a status
// reads as a shape, not a colour you have to decode.
const CREW_STATUS_GLYPH: Record<string, { group: string; color: string }> = {
  working: { group: "started", color: CREW_ACCENT.working },
  ready: { group: "unstarted", color: CREW_ACCENT.ready },
  blocked: { group: "backlog", color: CREW_ACCENT.blocked },
  paused: { group: "unstarted", color: CREW_ACCENT.paused },
  failed: { group: "completed", color: CREW_ACCENT.failed },
  done: { group: "completed", color: CREW_ACCENT.done },
  other: { group: "unstarted", color: CREW_ACCENT.other },
};

/** The tasks-board status glyph, keyed by a crew lifecycle status — one shape
 *  vocabulary for state everywhere. */
export function StatusGlyph({
  status,
  size = 9,
}: {
  status: string;
  size?: number;
}) {
  const g = CREW_STATUS_GLYPH[status] ?? CREW_STATUS_GLYPH.other!;
  return <StateGlyph group={g.group} color={g.color} size={size} />;
}

/** Plain-language "how long ago", tolerant of seconds- or millis-epoch (loop
 *  nodes stamp seconds; the goals ledger stamps millis). Empty for missing. */
export function relativeTime(unix: number | null | undefined): string {
  if (!unix || unix <= 0) return "";
  const ms = unix < 1e12 ? unix * 1000 : unix;
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** The agent logo for a node, or a neutral "unassigned" dot. */
export function AgentBit({
  agentKind,
  size = 20,
  dim,
}: {
  agentKind?: string | null;
  size?: number;
  dim?: boolean;
}) {
  const canonical = agentKind ? canonicalAgentId(agentKind) : null;
  if (!canonical) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full bg-bg-2 text-[9px] font-medium text-text-4"
        style={{ width: size, height: size }}
        title="No agent assigned yet"
      >
        ?
      </span>
    );
  }
  return (
    <span className={dim ? "opacity-60" : undefined}>
      <AgentIcon
        agentId={canonical}
        label={agentDisplayLabel(canonical)}
        size={size}
      />
    </span>
  );
}

/** Initials for a human assignee — "Ada Lovelace" → "AL". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** A small initials chip standing in for the TEAMMATE who owns this task —
 *  distinct from the agent (robot) logo. */
export function AssigneeBit({
  name,
  size = 16,
}: {
  name: string;
  size?: number;
}) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-bg-2 font-semibold text-text-3 ring-1 ring-line-soft"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      title={`Assigned to ${name}`}
    >
      {initials(name)}
    </span>
  );
}

/** Where this task came from — Jira / Beads import, or nothing for native. */
export function ProvenanceChips({ task }: { task: LoopTask }) {
  const isJira = task.external_source === "jira" && !!task.external_id;
  const isBeads = task.external_source === "beads" && !!task.external_id;
  if (!isJira && !isBeads) return null;
  return (
    <>
      {isJira ? (
        <StatusChip tone="blue" dense>
          JIRA {task.external_id}
        </StatusChip>
      ) : null}
      {isBeads ? (
        <StatusChip tone="neutral" dense>
          Beads {task.external_id}
        </StatusChip>
      ) : null}
    </>
  );
}

export function PriorityChip({ priority }: { priority: string }) {
  if (!priority || priority === "low") return null;
  return (
    <StatusChip tone={PRIORITY_TONE[priority] ?? "neutral"} dense dot>
      {priority}
    </StatusChip>
  );
}

/** The commit a done node landed (short, copy-friendly title). */
export function CommitChip({ sha }: { sha: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10.5px] text-text-4"
      title={sha}
    >
      <GitCommitHorizontal size={11} />
      {sha.slice(0, 7)}
    </span>
  );
}

/** The proof verdict — the moat. Green when proven, amber when almost, muted
 *  otherwise. Reads in plain language ("Proven · 3/3 checks"). */
export function ProofPill({ proof }: { proof: CrewProof }) {
  const tone: ChipTone =
    proof.verdict === "verified"
      ? "green"
      : proof.verdict === "partial"
        ? "amber"
        : "neutral";
  return (
    <StatusChip tone={tone} dense>
      <ShieldCheck size={10} className="mr-1 inline-block" />
      {proofLabel(proof)}
    </StatusChip>
  );
}

/** A live "working on X" line for in-flight nodes. */
export function WorkingLine({ agentKind }: { agentKind?: string | null }) {
  const canonical = agentKind ? canonicalAgentId(agentKind) : null;
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] text-text-4">
      <AsciiSpinner />
      running on {canonical ? agentDisplayLabel(canonical) : "the Aura brain"}
    </span>
  );
}
