// The Checks tab and the Dashboard, rendered on their own.
//
// Dev-server only — reached at /checks-harness.html?scene=<name>, never
// bundled. The panels are the real ones; only the desktop's git and GitHub
// commands are stood in for, answering from ./fixtures. Nothing runs and
// nothing is saved anywhere.
//
// Scenes: no-pr, open-pr, stacked, failing, dashboard, dashboard-prs, and
// changes (the rail's Changes tab on ./changesScene's working tree). Add
// `&theme=light` for the light palette and `&w=<px>` for the pane's width;
// the Checks scenes draw the pane's header above the tab.

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import "../../../styles.css";
import type { PrStackNode, PrSummary } from "../../../lib/api";
import { SCENES, ROOT } from "./fixtures";
import { CHANGES_ANSWERS } from "./changesScene";

const params = new URLSearchParams(location.search);
const changesScene = params.get("scene") === "changes";
const scene = changesScene ? SCENES["no-pr"] : (SCENES[params.get("scene") ?? "open-pr"] ?? SCENES["open-pr"]);
if (params.get("theme") === "light") document.documentElement.classList.add("light");
try {
  localStorage.setItem("aura.dashboard.view", scene.view ?? "workspaces");
} catch {
  /* no storage — the Dashboard opens on its board */
}

// The chain a pull request sits in: down its base branches to the bottom,
// then every pull request built on it.
function stackOf(prs: PrSummary[], number: number): PrStackNode[] {
  const byHead = new Map(prs.map((p) => [p.head_ref, p]));
  let bottom = prs.find((p) => p.number === number);
  if (!bottom) return [];
  while (byHead.has(bottom.base_ref)) bottom = byHead.get(bottom.base_ref)!;
  const out: PrStackNode[] = [];
  const walk = (p: PrSummary, parent: number | null) => {
    const kids = prs.filter((k) => k.base_ref === p.head_ref);
    out.push({
      number: p.number,
      title: p.title,
      head_ref: p.head_ref,
      base_ref: p.base_ref,
      author: p.author,
      state: p.state,
      is_draft: p.is_draft,
      aura_risk_score: p.aura_risk_score,
      url: p.url,
      children: kids.map((k) => k.number),
      parent,
      gt_managed: false,
      stack_tool: "github",
    });
    for (const k of kids) walk(k, p.number);
  };
  walk(bottom, null);
  return out;
}

const missed = new Set<string>();
(window as unknown as { __missed: Set<string> }).__missed = missed;

const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
  git_ahead_behind: () => scene.ab,
  git_diff_stats: () => ({ changed_files: scene.changed, added: scene.changed * 12, removed: scene.changed * 3 }),
  git_branch: () => scene.branch,
  pr_list: () => scene.prs,
  pr_detail: (a) => scene.details[Number(a.prNumber)] ?? null,
  pr_checks: (a) => scene.checks[Number(a.number)] ?? [],
  pr_comments_list: (a) => scene.comments[Number(a.prNumber)] ?? [],
  pr_vercel_status: () => scene.deploy ?? null,
  git_remote_origin: () => "git@github.com:acme/aura.git",
  pr_stack: (a) => stackOf(scene.prs, Number(a.prNumber)),
  git_worktree_list: () => scene.worktrees,
  pr_whoami: () => "sam",
  pr_merge_state: (a) => ({
    merge_state_status: scene.details[Number(a.prNumber)]?.review_decision === "REVIEW_REQUIRED" ? "BLOCKED" : "CLEAN",
    mergeable: "MERGEABLE",
    base_ref: scene.details[Number(a.prNumber)]?.base_ref ?? "main",
    merge_queue_state: null,
    merge_method: "squash",
    can_approve: false,
  }),
  pty_list_alive: () => [],
  git_target_sync: () => ({ remote: "origin", target: "main", target_ref: "refs/remotes/origin/main", ahead: scene.ab.ahead, behind: scene.targetBehind ?? 0 }),
  ...(changesScene ? CHANGES_ANSWERS : {}),
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const answer = answers[cmd];
    if (!answer) {
      missed.add(cmd);
      throw new Error(`command ${cmd} not found`);
    }
    return answer(args);
  },
  transformCallback: () => 0,
};

async function mount() {
  const root = ReactDOM.createRoot(document.getElementById("checks-harness")!);
  if (scene.dashboard) {
    const { WorkspacesDashboard } = await import("../../dashboard/WorkspacesDashboard");
    root.render(
      <StrictMode>
        <div style={{ height: "100vh", display: "flex", flexDirection: "column" }} className="bg-bg-content">
          <WorkspacesDashboard
            projects={[{ id: ROOT, name: "aura", letter: "A" }]}
            worktreesByRoot={{ [ROOT]: scene.worktrees }}
            badgeByPath={{}}
            activePath={ROOT}
            onOpen={() => undefined}
            onClose={() => undefined}
          />
        </div>
      </StrictMode>,
    );
  } else {
    const [{ ChecksPanel }, { ReviewStateHeader }, { ChangesPanel }, { RightRail }] = await Promise.all([
      import("../ChecksPanel"),
      import("../ReviewStateHeader"),
      import("../ChangesPanel"),
      import("../RightRail"),
    ]);
    // The Changes scene's working tree is the project's own checkout.
    const repoRoot = changesScene ? ROOT : (scene.worktrees.find((w) => w.branch === scene.branch)?.path ?? ROOT);
    const width = Number(params.get("w")) || 474;
    root.render(
      <StrictMode>
        <div style={{ height: "100vh", display: "flex", justifyContent: "flex-end" }} className="bg-bg-content">
          <div style={{ width, height: "100%", display: "flex", flexDirection: "column" }}>
            <div
              className="flex-shrink-0 flex items-center bg-bg-1 border-b border-line"
              style={{ height: "var(--topbar-h)" }}
            >
              <ReviewStateHeader repoRoot={repoRoot} conflictsCount={0} />
            </div>
            {changesScene ? (
              <div style={{ flex: 1, minHeight: 0 }}>
                <RightRail
                  activeTab="changes"
                  onChangeTab={() => undefined}
                  changesView={<ChangesPanel repoRoot={repoRoot} />}
                  checksView={<ChecksPanel repoRoot={repoRoot} conflictsCount={0} />}
                  changesRoot={repoRoot}
                />
              </div>
            ) : (
              <div className="ui-details-rail" style={{ flex: 1, minHeight: 0 }}>
                <div className="ui-details-panel ui-details-panel--fill" style={{ height: "100%" }}>
                  <ChecksPanel repoRoot={repoRoot} conflictsCount={0} />
                </div>
              </div>
            )}
          </div>
        </div>
      </StrictMode>,
    );
  }
  document.body.dataset.ready = "yes";
}
void mount();
