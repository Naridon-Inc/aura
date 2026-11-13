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
import { relativeAgeAuto } from "../../../lib/relativeTime";
import { monogram } from "../../../lib/monogram";
import { AgentIcon } from "../../agent/AgentIcon";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import type { ChipTone } from "../../ui/statusChip";
import { Avatar, AvatarFallback } from "../../ui/avatar";
import { Badge } from "../../ui/badge";
import { StateGlyph } from "../../tasks/StatePill";
import { proofLabel, type CrewProof } from "./crewProof";
import { WORK_STATE } from "../../../lib/workState";
import "../../ui/crew-bits.css";

// One palette, used as a left-border accent everywhere — the crew's key names
// for the app's work-state ramp. Green and red are status-only, never
// affordances.
//
// This said "arctic-blue for ready to go". --color-accent has been emerald
// since the theme was re-cut, so `ready` and `done` were two greens one ramp
// apart, which on a row of dots reads as one colour. Ready isn't a live state
// and doesn't need a hue — see lib/workState.
export const CREW_ACCENT = {
  ready: WORK_STATE.ready.color,
  working: WORK_STATE.working.color,
  done: WORK_STATE.done.color,
  failed: WORK_STATE.failed.color,
  blocked: WORK_STATE.blocked.color,
  paused: WORK_STATE.paused.color,
  other: WORK_STATE.queued.color,
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
  // One ladder for the whole app — see lib/relativeTime. The seconds-or-millis
  // tolerance moved there with it; this file is where it was worked out, and
  // it is a fact about our data rather than a nicety.
  //
  // The rungs it used to carry had the 45-to-60-second hole: under 45 seconds
  // was "just now", and the next line divided by 60 and floored, so anything
  // 45s to 59s old printed "0m ago".
  return relativeAgeAuto(unix);
}

/** Whether stamping the agent on every row of a list tells the reader anything.
 *
 *  It only does when they differ. Hand a whole queue to one agent — the normal
 *  case — and the mark repeats down twenty-four rows in the one colour this app
 *  reserves for agents, distinguishing none of them: the loudest thing in the
 *  pane, saying the same word over and over. Put a second agent on the board and
 *  it becomes the fastest way to tell whose is whose, so it comes back on its
 *  own. Callers that know the whole visible set decide; a row can't see its
 *  neighbours. */
export function agentsWorthNaming(
  kinds: Iterable<string | null | undefined>,
): boolean {
  let first: string | null = null;
  for (const k of kinds) {
    if (!k) continue;
    if (first === null) first = k;
    else if (k !== first) return true;
  }
  return false;
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
      <Avatar className="ui-crew-avatar" style={{ width: size, height: size }} title="No agent assigned yet">
        <AvatarFallback>?</AvatarFallback>
      </Avatar>
    );
  }
  return (
    <span className="ui-crew-agent" data-dim={dim ? "" : undefined}>
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
  // One monogram for the whole app — see lib/monogram.
  return monogram(name);
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
    <Avatar className="ui-crew-avatar" style={{ width: size, height: size }} title={`Assigned to ${name}`}>
      <AvatarFallback style={{ fontSize: size * 0.42 }}>{initials(name)}</AvatarFallback>
    </Avatar>
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
        <Badge variant="outline" className="ui-crew-badge" data-tone="blue">
          Jira {task.external_id}
        </Badge>
      ) : null}
      {isBeads ? (
        <Badge variant="outline" className="ui-crew-badge">
          Beads {task.external_id}
        </Badge>
      ) : null}
    </>
  );
}

export function PriorityChip({ priority }: { priority: string }) {
  if (!priority || priority === "low") return null;
  return (
    <Badge variant="outline" className="ui-crew-badge" data-tone={PRIORITY_TONE[priority] ?? "neutral"}>
      {priority}
    </Badge>
  );
}

/** The commit a done node landed (short, copy-friendly title). */
export function CommitChip({ sha }: { sha: string }) {
  return (
    <span className="ui-crew-commit" title={sha}>
      <GitCommitHorizontal />
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
    <Badge variant="outline" className="ui-crew-badge" data-tone={tone}>
      <ShieldCheck />
      {proofLabel(proof)}
    </Badge>
  );
}

/** A live "working on X" line for in-flight nodes. */
export function WorkingLine({ agentKind }: { agentKind?: string | null }) {
  const canonical = agentKind ? canonicalAgentId(agentKind) : null;
  return (
    <span className="ui-crew-working">
      <AsciiSpinner />
      running on {canonical ? agentDisplayLabel(canonical) : "the Aura brain"}
    </span>
  );
}
