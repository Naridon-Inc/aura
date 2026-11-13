// Intent ↔ AST — the change story (standalone page).
//
// A per-commit alignment narrative: pick a commit from the left timeline and
// read its story on the right — what was asked, what the AI said, what it
// actually changed (per-symbol cards), whether it lines up, and how to
// recover. The story renderer + the per-commit report loader live in the
// shared `IntentStory` module so the Session Detail "Alignment" tab reads
// identically (one renderer, no drift).
//
// Data: `aura intent-vs-actual list -n 50 --json` (this file, the timeline)
// and `aura intent-vs-actual show <sha> --json` (via `useIntentReport`), both
// over the existing `api.auraCli` passthrough. No new Tauri commands.

import { useCallback, useEffect, useState } from "react";
import { api, type ClaudeSession } from "../../lib/api";
import { fetchSessions, peekSessions } from "../../lib/sessionsCache";
import { peekCache, writeCache } from "../../lib/resourceCache";
import { RefreshCw, X } from "lucide-react";
import { IntentStory, useIntentReport, formatRelative } from "./IntentStory";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { TraceMark } from "../ui/trace-list";
import { TraceToolbar } from "../ui/trace-page";
import { TraceLine } from "../ui/trace-report";
import { TraceTimeline, TraceTimelineEntry } from "../ui/trace-timeline";
import "../trace/change-story.css";

type CommitListEntry = {
  commit_sha: string;
  commit_short: string;
  commit_message: string;
  commit_time: number;
  author: string;
  stated_count: number;
};

type Props = { repoRoot: string; onClose: () => void };

/** Cache key for this page's commit timeline — `-n 50` is baked into it so a
 *  future depth change can't silently read the wrong bundle. */
function timelineKey(repoRoot: string): string {
  return `intentVsActual:list:${repoRoot}:50`;
}

export function IntentInspector({ repoRoot, onClose }: Props) {
  // Seeded from the process-lifetime cache: a tab switch unmounts this page,
  // so without it every visit re-shells `aura intent-vs-actual list` behind a
  // "loading…" rail. `refreshList` revalidates underneath.
  const [commits, setCommits] = useState<CommitListEntry[]>(
    () => peekCache<CommitListEntry[]>(timelineKey(repoRoot)) ?? [],
  );
  const [listLoading, setListLoading] = useState(
    () => peekCache<CommitListEntry[]>(timelineKey(repoRoot)) == null,
  );
  const [listError, setListError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(
    () => peekCache<CommitListEntry[]>(timelineKey(repoRoot))?.[0]?.commit_sha ?? null,
  );
  // Real Claude sessions — used to surface the agent's actual prompt as the
  // "Asked" beat instead of the earliest logged intent (which is what the AI
  // *said*, not what the user *asked*). Best-effort; absence is fine.
  const [sessions, setSessions] = useState<ClaudeSession[]>(
    () => peekSessions(repoRoot) ?? [],
  );

  // The selected commit's full alignment report (asked/said/did/verdict),
  // loaded by the shared hook so this page and the Alignment tab match.
  const { report, loading: reportLoading, error: reportError } = useIntentReport(
    repoRoot,
    selectedSha,
  );

  useEffect(() => {
    let alive = true;
    // The roster comes off the cache the other Trace panes fill, so whichever
    // loaded first warms this one. A failed refresh keeps what we already have.
    const cached = peekSessions(repoRoot);
    fetchSessions(repoRoot)
      .then((s) => {
        if (alive) setSessions(Array.isArray(s) ? s : []);
      })
      .catch(() => {
        if (alive && !cached) setSessions([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  const refreshList = useCallback(async () => {
    // Stale-while-revalidate: with a cached timeline already painted, the
    // refresh runs underneath — flipping to "loading…" would blank rows we
    // can still show truthfully (each carries its own commit time).
    const key = timelineKey(repoRoot);
    const cached = peekCache<CommitListEntry[]>(key);
    if (cached) setCommits(cached);
    setListLoading(cached == null);
    setListError(null);
    try {
      const r = await api.auraCli(repoRoot, [
        "intent-vs-actual",
        "list",
        "-n",
        "50",
        "--json",
      ]);
      if (r.status !== 0)
        throw new Error(r.stderr.trim() || `aura exit ${r.status}`);
      const text = r.stdout.trim();
      const parsed = text ? (JSON.parse(text) as CommitListEntry[]) : [];
      writeCache(key, parsed);
      setCommits(parsed);
      if (parsed.length > 0 && selectedSha === null) {
        setSelectedSha(parsed[0].commit_sha);
      }
    } catch (e) {
      // Only surface the failure when there's no cached timeline to keep —
      // the error state replaces the whole rail.
      if (!cached) setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  return (
    <div className="ui-story-page">
      <TraceToolbar
        search={
          <span className="ui-trace-toolbar-meta ui-story-lede">
            The story of each change: what was asked, what the AI said, and what it did.
          </span>
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={refreshList}
          disabled={listLoading}
          title="Refresh commits"
          aria-label="Refresh commits"
        >
          <RefreshCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close the change story"
        >
          <X />
        </Button>
      </TraceToolbar>

      <div className="ui-story-body">
        <Timeline
          commits={commits}
          loading={listLoading}
          error={listError}
          selectedSha={selectedSha}
          onSelect={setSelectedSha}
        />
        <IntentStory
          repoRoot={repoRoot}
          report={report}
          sessions={sessions}
          loading={reportLoading}
          error={reportError}
        />
      </div>
    </div>
  );
}

// ── Left rail: the timeline of changes ───────────────────────────────

function Timeline({
  commits,
  loading,
  error,
  selectedSha,
  onSelect,
}: {
  commits: CommitListEntry[];
  loading: boolean;
  error: string | null;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
}) {
  return (
    <div className="ui-story-rail">
      {loading ? (
        <div className="ui-story-rail-state" role="status">
          <AsciiSpinner />
          <span>Reading the commits…</span>
        </div>
      ) : error ? (
        <div className="ui-story-rail-state">
          <TraceLine tone="danger">Couldn’t read the commits.</TraceLine>
          <code className="ui-story-error">{error}</code>
        </div>
      ) : commits.length === 0 ? (
        <div className="ui-story-rail-state">
          <TraceLine tone="note">No commits yet.</TraceLine>
        </div>
      ) : (
        <TraceTimeline label="Commits, newest first">
          {commits.map((c) => (
            <TraceTimelineEntry
              key={c.commit_sha}
              active={selectedSha === c.commit_sha}
              onSelect={() => onSelect(c.commit_sha)}
              // The subject line only: a body folded into two clamped lines
              // reads as one run-on sentence. The whole message is the tooltip.
              title={
                <span title={c.commit_message || undefined}>
                  {c.commit_message.split("\n")[0] || "(no message)"}
                </span>
              }
              detail={
                <>
                  <code className="ui-story-sha">{c.commit_short}</code>
                  <span aria-hidden>·</span>
                  <span>{formatRelative(c.commit_time)}</span>
                  <span aria-hidden>·</span>
                  <span className="ui-story-author">{c.author}</span>
                  {c.stated_count === 0 && (
                    <TraceMark
                      tone="warn"
                      title="Nothing was logged about why this commit was made"
                    >
                      no task log
                    </TraceMark>
                  )}
                </>
              }
            />
          ))}
        </TraceTimeline>
      )}
    </div>
  );
}
