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
import { fetchSessions } from "../../lib/sessionsCache";
import { IntentStory, useIntentReport, formatRelative } from "./IntentStory";
import { Button } from "../ui/button";

type CommitListEntry = {
  commit_sha: string;
  commit_short: string;
  commit_message: string;
  commit_time: number;
  author: string;
  stated_count: number;
};

type Props = { repoRoot: string; onClose: () => void };

export function IntentInspector({ repoRoot, onClose }: Props) {
  const [commits, setCommits] = useState<CommitListEntry[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  // Real Claude sessions — used to surface the agent's actual prompt as the
  // "Asked" beat instead of the earliest logged intent (which is what the AI
  // *said*, not what the user *asked*). Best-effort; absence is fine.
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);

  // The selected commit's full alignment report (asked/said/did/verdict),
  // loaded by the shared hook so this page and the Alignment tab match.
  const { report, loading: reportLoading, error: reportError } = useIntentReport(
    repoRoot,
    selectedSha,
  );

  useEffect(() => {
    let alive = true;
    fetchSessions(repoRoot)
      .then((s) => {
        if (alive) setSessions(Array.isArray(s) ? s : []);
      })
      .catch(() => {
        if (alive) setSessions([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  const refreshList = useCallback(async () => {
    setListLoading(true);
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
      setCommits(parsed);
      if (parsed.length > 0 && selectedSha === null) {
        setSelectedSha(parsed[0].commit_sha);
      }
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <header className="h-9 flex items-center px-4 border-b border-line-soft flex-shrink-0 gap-3">
        <span className="section-label">
          Change story
        </span>
        <span className="text-text-4 text-xs">
          the story of a change. Asked, said, did
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={refreshList}
          title="Refresh commits"
          className="ml-auto text-text-4 hover:text-text-1"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
            />
            <path
              d="M9 5h3V2M7 11H4v3"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
            />
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={onClose}
          title="Close"
          className="text-text-4 hover:text-text-1"
        >
          ×
        </Button>
      </header>

      <div className="flex-1 min-h-0 flex">
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
    <div className="w-[280px] border-r border-line-soft flex flex-col flex-shrink-0">
      <div className="section-label h-7 flex items-center px-3 border-b border-line-soft flex-shrink-0">
        Timeline
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="text-text-4 text-sm px-4 py-4">loading…</div>
        ) : error ? (
          <div className="text-red-400 text-xs font-mono px-4 py-4">
            {error}
          </div>
        ) : commits.length === 0 ? (
          <div className="text-text-4 text-sm px-4 py-4">No commits yet.</div>
        ) : (
          commits.map((c) => {
            const active = selectedSha === c.commit_sha;
            return (
              <button
                key={c.commit_sha}
                type="button"
                onClick={() => onSelect(c.commit_sha)}
                className={`relative w-full text-left pl-6 pr-3 py-2 hover:bg-state-hover transition-colors border-t border-line-soft/40 ${
                  active ? "bg-state-selected" : ""
                }`}
              >
                <span
                  aria-hidden
                  className={`absolute left-3 top-3 w-1.5 h-1.5 rounded-full ${
                    active ? "bg-accent" : "bg-line"
                  }`}
                />
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-mono text-text-3 flex-shrink-0">
                    {c.commit_short}
                  </span>
                  <span className="text-2xs text-text-4 tabular-nums ml-auto flex-shrink-0">
                    {formatRelative(c.commit_time)}
                  </span>
                </div>
                <div
                  className="text-sm text-text-1 mt-0.5 truncate"
                  title={c.commit_message}
                >
                  {c.commit_message || (
                    <span className="text-text-4">(no message)</span>
                  )}
                </div>
                <div className="text-xs text-text-4 mt-0.5 flex items-center gap-1.5">
                  <span className="truncate">{c.author}</span>
                  {c.stated_count === 0 && (
                    <>
                      <span>·</span>
                      <span className="text-amber-300/70">no task log</span>
                    </>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
