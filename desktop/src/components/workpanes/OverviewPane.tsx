// Trace's Overview answers "what happened lately?". Who is working this
// minute, then this week's sessions day by day, newest first, each one a
// plain sentence with one line of facts. Opening a moment tells its story;
// everything older is one link away on My sessions.

import { useEffect, useMemo, useState } from "react";
import { History, Radio } from "lucide-react";
import type { IntentRow, TeamMember } from "../../lib/api";
import { fetchTeam } from "../../lib/teamCache";
import { Button } from "../ui/button";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { TraceStory, TraceStoryHead, TraceStoryIntro } from "../ui/trace-story";
import { ALL_BRANCHES, useSessionGroups, useSessionsFeed, type DayGroup } from "../trace/sessionsFeed";
import { RightNowDay, useRightNow } from "../trace/story/RightNow";
import { StoryDays, useMomentKeys } from "../trace/story/StoryDays";
import { formatCount } from "../trace/story/storyFormat";
import { useRefreshOnReturn } from "../trace/story/useRefreshOnReturn";

const WEEK_S = 7 * 24 * 60 * 60;
/** Enough to cover a busy afternoon without turning Overview into the archive. */
const MAX_MOMENTS = 12;

/** This week's days, cut at `max` moments in all. */
function thisWeek(groups: DayGroup[], nowSecs: number, max: number): { days: DayGroup[]; count: number } {
  const days: DayGroup[] = [];
  let count = 0;
  let shown = 0;
  for (const g of groups) {
    const recent = g.rows.filter((r) => nowSecs - r.timestamp <= WEEK_S);
    if (recent.length === 0) continue;
    count += recent.length;
    if (shown >= max) continue;
    const take = recent.slice(0, max - shown);
    shown += take.length;
    days.push({ ...g, rows: take });
  }
  return { days, count };
}

export function OverviewPane({
  repoRoot,
  activeKey,
  onOpenSessions,
  onOpenSession,
  onOpenWrapped,
  onOpenCostUsage,
}: {
  repoRoot: string;
  /** The moment last opened, kept marked when the reader comes back. */
  activeKey?: string | null;
  onOpenSessions: () => void;
  onOpenSession?: (row: IntentRow) => void;
  onOpenWrapped: () => void;
  onOpenCostUsage: () => void;
}) {
  const feed = useSessionsFeed(repoRoot);
  const groups = useSessionGroups({
    rows: feed.rows,
    claudeSessions: feed.claudeSessions,
    managerSessions: feed.managerSessions,
    currentBranch: feed.currentBranch,
    branchFilter: ALL_BRANCHES,
    query: "",
  });
  const week = useMemo(() => thisWeek(groups, feed.nowSecs, MAX_MOMENTS), [groups, feed.nowSecs]);

  const [roster, setRoster] = useState<TeamMember[]>([]);
  useEffect(() => {
    let alive = true;
    fetchTeam(repoRoot)
      .then((t) => alive && setRoster(t?.members ?? []))
      .catch(() => alive && setRoster([]));
    return () => {
      alive = false;
    };
  }, [repoRoot]);
  const now = useRightNow(repoRoot, roster);
  const working = now.filter((l) => !l.status).length;

  useRefreshOnReturn(feed.load);

  const onKeyDown = useMomentKeys();
  const open = (row: IntentRow) => onOpenSession?.(row);
  const hasAny = feed.rows.length > 0 || feed.managerSessions.length > 0;

  return (
    <TraceStory label="Overview">
      <TraceStoryHead
        icon={<Radio data-tone={working > 0 ? "good" : undefined} aria-hidden />}
        control={
          <Button variant="ghost" size="xs" onClick={onOpenCostUsage}>
            Cost &amp; usage
          </Button>
        }
      >
        {working > 0 ? (
          <>
            <strong>{formatCount(working)}</strong> {working === 1 ? "agent" : "agents"} working now
          </>
        ) : (
          "Nothing running now"
        )}
        {" · "}
        <strong>{formatCount(week.count)}</strong> {week.count === 1 ? "session" : "sessions"} this week
      </TraceStoryHead>
      <TraceStoryIntro>
        What your agents did in this repository, newest first. Open any moment to read what was asked,
        what changed and whether it was sealed.
      </TraceStoryIntro>
      {feed.error && !hasAny ? (
        <ErrorState title="Couldn’t read this repository’s history" message={feed.error} onRetry={() => void feed.load()} size="sm" />
      ) : feed.loading && !hasAny ? (
        <LoadingState label="Reading what happened…" />
      ) : !hasAny ? (
        <EmptyState
          icon={History}
          title="Nothing has happened here yet"
          body="When an agent changes this repository, the session shows up here: what was asked, what changed, and whether it was sealed."
          size="sm"
        />
      ) : (
        <div className="ui-trace-story-days" onKeyDown={onKeyDown}>
          <RightNowDay lines={now} />
          {week.days.length === 0 ? (
            <p className="ui-trace-story-intro">Nothing changed this week.</p>
          ) : (
            <StoryDays
              groups={week.days}
              sessions={feed.claudeSessions}
              nowSecs={feed.nowSecs}
              currentBranch={feed.currentBranch}
              activeKey={activeKey}
              onOpen={open}
            />
          )}
          <div className="ui-trace-story-links">
            <Button variant="link" size="xs" onClick={onOpenSessions}>
              See every session
            </Button>
            <Button variant="link" size="xs" onClick={onOpenWrapped}>
              Year in review
            </Button>
          </div>
        </div>
      )}
    </TraceStory>
  );
}
