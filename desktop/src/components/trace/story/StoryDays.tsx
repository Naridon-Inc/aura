// A list of sessions told day by day: each day a caption, its sessions on the
// shared timeline under it, newest first. ↑ and ↓ move between moments and
// Enter opens one; the moment last opened stays marked, so coming Back lands
// the reader where they left.

import { useCallback, type KeyboardEvent, type ReactNode } from "react";
import type { ClaudeSession, IntentRow } from "../../../lib/api";
import { TraceStoryDay } from "../../ui/trace-story";
import { TraceTimeline } from "../../ui/trace-timeline";
import type { DayGroup } from "../sessionsFeed";
import { ChatMoment, SessionMoment } from "./SessionMoment";

/** The key a row is remembered by, so the one opened can be found again. */
export function momentKey(row: IntentRow): string {
  return row.manager_session_id
    ? `chat:${row.manager_session_id}`
    : `${row.timestamp}:${row.agent_id}`;
}

/** ↑/↓ between the moments inside `container`, wherever focus sits in it. */
export function useMomentKeys() {
  return useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable]")) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>("button.ui-trace-timeline-entry")];
    if (all.length === 0) return;
    const at = all.indexOf(target.closest("button.ui-trace-timeline-entry") as HTMLElement);
    const next = at < 0 ? 0 : Math.min(all.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    e.preventDefault();
    all[next]?.focus();
    all[next]?.scrollIntoView({ block: "nearest" });
  }, []);
}

export function StoryDays({
  groups,
  sessions,
  nowSecs,
  currentBranch,
  activeKey,
  whoOf,
  touches,
  onOpen,
  after,
}: {
  groups: DayGroup[];
  sessions: ClaudeSession[];
  nowSecs: number;
  currentBranch: string | null;
  /** The moment last opened, kept marked. */
  activeKey?: string | null;
  /** Whose session it was, on a list of everyone's. */
  whoOf?: (row: IntentRow) => string | undefined;
  /** Whether a session touched a file the reader is changing. */
  touches?: (paths: string[]) => boolean;
  onOpen: (row: IntentRow) => void;
  after?: ReactNode;
}) {
  return (
    <>
      {groups.map((g) => (
        <TraceStoryDay key={g.key} label={g.label}>
          <TraceTimeline label={g.label}>
            {g.rows.map((r) =>
              r.kind === "intent" ? (
                <SessionMoment
                  key={r.key}
                  display={r.display}
                  sessions={sessions}
                  nowSecs={nowSecs}
                  currentBranch={currentBranch}
                  who={whoOf?.(r.display.row)}
                  touchesYourWork={touches?.(r.display.paths)}
                  active={activeKey === momentKey(r.display.row)}
                  onOpen={onOpen}
                />
              ) : (
                <ChatMoment
                  key={r.key}
                  summary={r.summary}
                  nowSecs={nowSecs}
                  active={activeKey === `chat:${r.summary.id}`}
                  onOpen={onOpen}
                />
              ),
            )}
          </TraceTimeline>
        </TraceStoryDay>
      ))}
      {after}
    </>
  );
}
