// HistoryTab — the "story so far" surface, planned as master / detail: the
// saved-version list on the left, the picked version's Aura intent story on the
// right. Loads the commit graph (same data the lane view uses) and the
// workspace's recorded sessions once, so the detail pane can tie each commit
// back to the prompt that started it. Auto-selects the newest version (HEAD) so
// the pane is never empty on open.

import { useEffect, useState } from "react";
import { History } from "lucide-react";

import type { ClaudeSession, GraphCommit } from "../../lib/api";
import * as work from "../../lib/place/workApi";
import { fetchSessions } from "../../lib/sessionsCache";
import { DetailsCaption } from "../ui/details-panel";
import { EmptyState } from "../ui/state";
import { CommitList } from "./CommitList";
import { CommitDetailPane } from "./CommitDetailPane";
import "../ui/commit-list.css";

export function HistoryTab({ repoRoot }: { repoRoot: string }) {
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const loadCommits = (initial: boolean) => {
      if (initial) setLoading(true);
      // Through the place door: a project standing in a machine draws the
      // graph of the checkout over there, not of this laptop's copy.
      work
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
    fetchSessions(repoRoot)
      .then((s) => alive && setSessions(s))
      .catch(() => {});
    return () => {
      alive = false;
      window.removeEventListener("aura:git-changed", onGitChanged);
    };
  }, [repoRoot]);

  return (
    <div className="ui-history">
      <div className="ui-history-rail">
        <div className="ui-details-group-caption ui-history-head">
          <DetailsCaption>
            {commits.length > 0 ? `Saved versions ${commits.length}` : "Saved versions"}
          </DetailsCaption>
        </div>
        <div className="ui-history-list">
          <CommitList
            commits={commits}
            selected={selected}
            loading={loading}
            onSelect={setSelected}
          />
        </div>
      </div>

      <div className="ui-history-detail">
        {selected ? (
          <CommitDetailPane repoRoot={repoRoot} sha={selected} sessions={sessions} />
        ) : (
          <div className="ui-history-pick">
            <EmptyState
              icon={History}
              title="Pick a saved version"
              body="Pick a saved version on the left to read its story."
              size="sm"
            />
          </div>
        )}
      </div>
    </div>
  );
}
