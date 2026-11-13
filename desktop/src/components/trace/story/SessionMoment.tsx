// One session as a moment on Trace's timeline: what happened, in the words
// the agent or the person gave, and one muted line of facts under it. The
// facts are the ones a reader acts on: is it sealed, when, which agent, how
// much it changed, what kind of change, and where, when that is not here.

import type { ReactNode } from "react";
import { Lock, LockOpen, MessagesSquare } from "lucide-react";

import type { ClaudeSession, IntentRow, ManagerSummary } from "../../../lib/api";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import { intentTypeSentence } from "@shared/intentTypeLabels";
import {
  provenanceTag,
  sessionDisplayTitle,
  titleProvenance,
  type SessionDisplayRow,
} from "../../../lib/sessionMeta";
import { TraceMark } from "../../ui/trace-list";
import { TraceStoryMeta } from "../../ui/trace-story";
import { TraceTimelineEntry } from "../../ui/trace-timeline";
import {
  fullStamp,
  managerRowToIntent,
  managerSessionTimestamp,
  managerSessionTitle,
  relTime,
} from "../sessionsFeed";
import { formatCount } from "./storyFormat";

/** Facts on a moment's line, a dot between each. A lock leads without one. */
export function MomentFacts({ lock, facts }: { lock?: "sealed" | "open"; facts: ReactNode[] }) {
  const shown = facts.filter((f) => f !== null && f !== undefined && f !== false && f !== "");
  const parts: ReactNode[] = [];
  shown.forEach((f, i) => {
    if (i > 0) {
      parts.push(
        <span key={`d${i}`} aria-hidden>
          ·
        </span>,
      );
    }
    parts.push(<span key={`f${i}`}>{f}</span>);
  });
  return (
    <TraceStoryMeta>
      {lock === "sealed" && <Lock data-sealed="" aria-label="Sealed" />}
      {lock === "open" && <LockOpen aria-label="Not sealed" />}
      {parts}
    </TraceStoryMeta>
  );
}

/** "+1,240 −980", or nothing when the session changed no lines. A half that
 *  is zero is left out — "+0 −12" reads as a session that added something. */
export function LinesChanged({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null;
  return (
    <span className="ui-diff-count" title={`${formatCount(added)} lines added, ${formatCount(removed)} removed`}>
      {added > 0 && <span>+{formatCount(added)}</span>}
      {removed > 0 && <span>−{formatCount(removed)}</span>}
    </span>
  );
}

export function filesWord(n: number): string {
  return n === 1 ? "1 file" : `${formatCount(n)} files`;
}

export function SessionMoment({
  display,
  sessions,
  nowSecs,
  currentBranch,
  who,
  touchesYourWork,
  active,
  onOpen,
}: {
  display: SessionDisplayRow;
  sessions: ClaudeSession[];
  nowSecs: number;
  /** The branch this checkout is on; a session from any other says where. */
  currentBranch: string | null;
  /** Whose session it was, on a list of everyone's. */
  who?: string;
  /** It changed a file the reader has uncommitted changes in. */
  touchesYourWork?: boolean;
  active?: boolean;
  onOpen: (row: IntentRow) => void;
}) {
  const { row } = display;
  const blocked = row.intent_type === "blocked";
  const sealed = !!row.signed_block_id;
  const elsewhere = row.branch && currentBranch && row.branch !== currentBranch ? row.branch : null;
  // When nobody wrote the title down — Aura read the diff, or the agent
  // described its own turn — the line says so. A reader skimming a story
  // takes the headline as the reason unless told otherwise.
  const writtenBy = provenanceTag(titleProvenance(row, sessions));
  return (
    <TraceTimelineEntry
      title={sessionDisplayTitle(row, sessions)}
      active={active}
      onSelect={() => onOpen(row)}
      detail={
        <MomentFacts
          lock={sealed ? "sealed" : undefined}
          facts={[
            who,
            <time key="t" dateTime={new Date(row.timestamp * 1000).toISOString()} title={fullStamp(row.timestamp)}>
              {relTime(nowSecs - row.timestamp)}
            </time>,
            agentDisplayLabel(canonicalAgentId(row.agent_id)),
            writtenBy,
            display.files > 0 && filesWord(display.files),
            display.hasChurn && <LinesChanged added={display.adds} removed={display.dels} />,
            blocked && <TraceMark tone="danger">Stopped by a check</TraceMark>,
            !blocked && row.intent_type && intentTypeSentence(row.intent_type),
            elsewhere && `on ${elsewhere}`,
            touchesYourWork && <TraceMark tone="warn">Touches your work</TraceMark>,
          ]}
        />
      }
    />
  );
}

/** A chat with Aura: no changeset of its own, so its line says how far its
 *  plan got instead of how many lines it changed. */
export function ChatMoment({
  summary,
  nowSecs,
  active,
  onOpen,
}: {
  summary: ManagerSummary;
  nowSecs: number;
  active?: boolean;
  onOpen: (row: IntentRow) => void;
}) {
  const ts = managerSessionTimestamp(summary);
  return (
    <TraceTimelineEntry
      title={managerSessionTitle(summary)}
      active={active}
      onSelect={() => onOpen(managerRowToIntent(summary))}
      detail={
        <MomentFacts
          facts={[
            <time key="t" title={fullStamp(ts)}>
              {relTime(nowSecs - ts)}
            </time>,
            <>
              <MessagesSquare aria-hidden /> Aura chat
            </>,
            summary.task_count > 0 && `${summary.done_count} of ${summary.task_count} steps done`,
          ]}
        />
      }
    />
  );
}
