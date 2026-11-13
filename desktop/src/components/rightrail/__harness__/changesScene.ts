// The Changes tab's stand-in working tree: the project's own edits, a staged
// file edited again, an untracked file, a deletion, machine churn, and a
// folder that is a git repository of its own (`cloud/`) with edits of its own.

import type { FileDiffStat, GitStatusEntry, NestedRepo } from "../../../lib/api";
import { ROOT } from "./fixtures";

const CLOUD = `${ROOT}/cloud`;

type Tree = { entries: GitStatusEntry[]; stats: FileDiffStat[] };

const file = (path: string, index: string, worktree: string, additions: number, deletions: number) => ({
  entry: { path, index, worktree },
  stat: { path, additions, deletions },
});

function tree(rows: ReturnType<typeof file>[]): Tree {
  return { entries: rows.map((r) => r.entry), stats: rows.map((r) => r.stat) };
}

const trees: Record<string, Tree> = {
  [ROOT]: tree([
    file(".aura/intent_log.jsonl", "", "M", 12, 0),
    file(".gitignore", "", "M", 2, 0),
    file("aura-shell/src/components/rightrail/ChangePath.tsx", "?", "?", 33, 0),
    file("aura-shell/src/components/rightrail/ChangesPanel.tsx", "", "M", 84, 151),
    file("aura-shell/src/components/rightrail/legacyCommitBox.tsx", "", "D", 0, 120),
    file("aura-shell/src/lib/nestedRepos.ts", "M", "M", 36, 2),
    // The nested repository's folder, as the project's git sees it.
    file("cloud/", "?", "?", 0, 0),
    file("docs/changes-tab.md", "A", "", 40, 0),
    file("README.md", "", "M", 5, 1),
  ]),
  [CLOUD]: tree([
    file("migrations/085_machine_access.sql", "?", "?", 24, 0),
    file("src/routes/machines.rs", "", "M", 58, 9),
  ]),
};

const NESTED: NestedRepo[] = [
  { rel_path: "cloud", root: CLOUD, kind: "nested", branch: "feat/machine-access", base: "main" },
];

const rootOf = (a: Record<string, unknown>) => String(a.repoRoot ?? a.root ?? ROOT);

const at = Math.floor(Date.parse("2026-11-10T09:00:00Z") / 1000);

export const CHANGES_ANSWERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  git_status_v2: (a) => trees[rootOf(a)]?.entries ?? [],
  git_diff_stats_per_file: (a) => trees[rootOf(a)]?.stats ?? [],
  nested_repos_list: (a) => (rootOf(a) === ROOT ? NESTED : []),
  git_branches: () => [
    { name: "feat/cloud-remote", is_current: true, is_remote: false, upstream: "origin/feat/cloud-remote", subject: "Cloud runs for remote workspaces" },
    { name: "main", is_current: false, is_remote: false, upstream: "origin/main", subject: "Faster conversation saves" },
  ],
  git_recent_commits: () => [
    { sha: "b246a27", author: "sam", timestamp: at, subject: "Cloud runs for remote workspaces", branch: "feat/cloud-remote" },
    { sha: "8dfb872", author: "sam", timestamp: at - 3600, subject: "Remote workspace picker", branch: "feat/cloud-remote" },
  ],
  aura_live_status: () => ({ running: false, pid: null, started_at: null, exit_code: null, last_error: null }),
};
