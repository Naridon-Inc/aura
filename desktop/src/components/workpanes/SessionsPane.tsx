// My sessions — "how was that done?". Every session you and your agents ran,
// told day by day on the same story column as Overview: one plain sentence
// each, one line of facts under it, newest first. Search finds a session by
// what was asked, a file, an agent or a branch; the one switch narrows it to
// the branch this checkout is on.
//
// A session carries no made-up verdict. Only a change Aura actually stopped
// says so; a sealed record adds a lock and nothing more.

import { useMemo, useState } from "react";
import { History, Lock, Search } from "lucide-react";

import type { IntentRow } from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Segment } from "../ui/segment";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { TraceStory, TraceStoryHead, TraceStoryIntro } from "../ui/trace-story";
import { ALL_BRANCHES, useSessionGroups, useSessionsFeed } from "../trace/sessionsFeed";
import { StoryDays, useMomentKeys } from "../trace/story/StoryDays";
import { formatCount } from "../trace/story/storyFormat";
import { useRefreshOnReturn } from "../trace/story/useRefreshOnReturn";

type Scope = "here" | "all";

export function SessionsPane({
  repoRoot,
  activeKey,
  onOpenSession,
  onOpenCostUsage,
}: {
  repoRoot: string;
  /** The session last opened, kept marked when the reader comes Back. */
  activeKey?: string | null;
  onOpenSession: (row: IntentRow) => void;
  /** Open the spend reading of these sessions. */
  onOpenCostUsage?: () => void;
}) {
  const feed = useSessionsFeed(repoRoot);
  const { claudeSessions, managerSessions, currentBranch, nowSecs, loading, error, load } = feed;
  // Every branch by default: work from the other checkouts is the point of
  // the list; narrowing is the escape hatch.
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  useRefreshOnReturn(load);

  const groups = useSessionGroups({
    rows: feed.rows,
    claudeSessions,
    managerSessions,
    currentBranch,
    branchFilter: scope === "here" && currentBranch ? currentBranch : ALL_BRANCHES,
    query,
  });
  const { total, sealed } = useMemo(() => {
    let total = 0;
    let sealed = 0;
    for (const g of groups) {
      for (const r of g.rows) {
        total += 1;
        if (r.kind === "intent" && r.display.row.signed_block_id) sealed += 1;
      }
    }
    return { total, sealed };
  }, [groups]);
  const onKeyDown = useMomentKeys();
  const read = !(loading && total === 0);

  return (
    <TraceStory label="My sessions">
      <TraceStoryHead
        icon={<Lock aria-hidden />}
        control={
          currentBranch ? (
            <Segment
              size="xs"
              value={scope}
              onChange={setScope}
              ariaLabel="Which sessions"
              options={[
                { value: "here", label: "This branch", title: `Only sessions on ${currentBranch}` },
                { value: "all", label: "Every branch", title: "Sessions from every branch" },
              ]}
            />
          ) : undefined
        }
      >
        {read ? (
          <>
            <strong>{formatCount(total)}</strong> {total === 1 ? "session" : "sessions"} ·{" "}
            <strong>{formatCount(sealed)}</strong> sealed
          </>
        ) : (
          "Reading your sessions"
        )}
      </TraceStoryHead>
      <TraceStoryIntro>
        Every session you and your agents ran, newest first. Search by what was asked, a file, an
        agent or a branch, and open one to read how it was done.
      </TraceStoryIntro>
      <Input
        type="search"
        size="small"
        prefix={<Search size={14} aria-hidden />}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search sessions"
        aria-label="Search sessions"
      />
      {error && total === 0 ? (
        <ErrorState title="Couldn’t load your sessions" message={error} onRetry={() => void load()} size="sm" />
      ) : !read ? (
        <LoadingState label="Reading your sessions…" />
      ) : total === 0 ? (
        query.trim() ? (
          <EmptyState
            icon={History}
            title="No sessions match"
            body="Nothing here mentions that in what was asked, its agent, branch or files."
            action={{ label: "Clear search", onClick: () => setQuery("") }}
            size="sm"
          />
        ) : scope === "here" ? (
          <EmptyState
            icon={History}
            title={`Nothing on ${currentBranch}`}
            body="No work has been recorded on this branch yet."
            action={{ label: "Show every branch", onClick: () => setScope("all") }}
            size="sm"
          />
        ) : (
          <EmptyState
            icon={History}
            title="No sessions yet"
            body="Every session you or an agent runs is kept here: what was asked, what changed, and why."
            size="sm"
          />
        )
      ) : (
        <div className="ui-trace-story-days" onKeyDown={onKeyDown}>
          <StoryDays
            groups={groups}
            sessions={claudeSessions}
            nowSecs={nowSecs}
            currentBranch={currentBranch}
            activeKey={activeKey}
            onOpen={onOpenSession}
          />
          {onOpenCostUsage && (
            <div className="ui-trace-story-links">
              <Button variant="link" size="xs" onClick={onOpenCostUsage}>
                Cost &amp; usage
              </Button>
            </div>
          )}
        </div>
      )}
    </TraceStory>
  );
}
