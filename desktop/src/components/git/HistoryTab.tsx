// HistoryTab — the "story so far" surface, planned as master / detail: the
// saved-version list on the left, the picked version's Aura intent story on the
// right. Loads the commit graph (same data the lane view uses) and the
// workspace's recorded sessions once, so the detail pane can tie each commit
// back to the prompt that started it. Auto-selects the newest version (HEAD) so
// the pane is never empty on open.

import { useEffect, useState } from "react";
import { History } from "lucide-react";

import { api, type ClaudeSession, type GraphCommit } from "../../lib/api";
import { CommitList } from "./CommitList";
import { CommitDetailPane } from "./CommitDetailPane";

export function HistoryTab({ repoRoot }: { repoRoot: string }) {
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const loadCommits = (initial: boolean) => {
      if (initial) setLoading(true);
      api
        .gitCommitGraph(repoRoot, 200)
        .then((c) => {
          if (!alive) return;
          setCommits(c);
          // Land on HEAD ("you are here"), else the newest row.
          const head = c.find((x) => x.refs.some((r) => r.kind === "head"));
          setSelected((cur) => cur ?? head?.sha ?? c[0]?.sha ?? null);
          setLoading(false);
        })
        .catch(() => {
          if (alive) setLoading(false);
        });
    };
    loadCommits(true);
    // A commit (or checkout) landed elsewhere in the git UI — re-load the list
    // so the new saved version shows up without reopening the tab.
    const onGitChanged = () => loadCommits(false);
    window.addEventListener("aura:git-changed", onGitChanged);
    // Sessions are best-effort — they only enrich the "Asked" beat; a failure
    // just falls back to the earliest logged intent.
    api
      .claudeListSessions(repoRoot)
      .then((s) => alive && setSessions(s))
      .catch(() => {});
    return () => {
      alive = false;
      window.removeEventListener("aura:git-changed", onGitChanged);
    };
  }, [repoRoot]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[360px] min-h-0 shrink-0 flex-col border-r border-line-soft">
        <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2 text-[11px] uppercase tracking-wider text-text-4">
          <History size={13} />
          Saved versions
          {commits.length > 0 && (
            <span className="ml-auto tabular-nums text-text-4/80">
              {commits.length}
            </span>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <CommitList
            commits={commits}
            selected={selected}
            loading={loading}
            onSelect={setSelected}
          />
        </div>
      </div>

      <div className="min-w-0 min-h-0 flex-1">
        {selected ? (
          <CommitDetailPane repoRoot={repoRoot} sha={selected} sessions={sessions} />
        ) : (
          <div className="px-6 py-8 text-[12px] text-text-4">
            Pick a saved version on the left to read its story.
          </div>
        )}
      </div>
    </div>
  );
}
