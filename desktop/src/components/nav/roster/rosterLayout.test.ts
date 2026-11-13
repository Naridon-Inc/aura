import { describe, expect, test } from "bun:test";

import type { Workspace, WorktreeRef } from "../../../lib/workspaceRef";
import type { WorktreeBadge } from "../../../lib/useWorktreeBadges";
import { PINNED_KEY, layoutRoster, sortRows, type RosterLayoutInput } from "./rosterLayout";

// A repository's main checkout is where the repository lives, not a workspace.
// The list under a repository shows its workspaces; the main checkout joins
// them only while work is on it, and the repository's own row opens it.

const ROOT = "/code/app";
const COPY = "/code/app-search";

function ref(path: string, over: Partial<WorktreeRef> = {}): WorktreeRef {
  return { path, branch: "feat/search", head: "abc", is_main: false, locked: false, ...over };
}

const main = ref(ROOT, { branch: "main", is_main: true });
const copy = ref(COPY);

function layout(over: Partial<RosterLayoutInput> = {}, worktrees = [main, copy]) {
  const ws = { id: ROOT, worktrees } as Workspace;
  return layoutRoster({
    workspaces: [ws],
    sort: "updated",
    custom: {},
    activePath: COPY,
    now: Date.now(),
    agentCount: () => 0,
    visited: {},
    collapsed: {},
    expanded: {},
    workingRoots: new Set(),
    ...over,
  }).rest[0];
}

const listed = (repo: ReturnType<typeof layout>) =>
  [...repo.shown, ...repo.inactive].map((w) => w.path);

const badge = (over: Partial<WorktreeBadge>): Record<string, WorktreeBadge> => ({
  [ROOT]: { added: 0, removed: 0, changedFiles: 0, ...over },
});

describe("a repository's main checkout in the workspace list", () => {
  test("clean and idle, it is not listed; its workspaces are", () => {
    const repo = layout();
    expect(listed(repo)).toEqual([COPY]);
    expect(repo.rows.map((w) => w.path)).toEqual([COPY]);
  });

  test("the repository's row opens it all the same", () => {
    expect(layout().homePath).toBe(ROOT);
  });

  test("with edits not yet committed, it is listed", () => {
    expect(listed(layout({ badgeByPath: badge({ added: 3, removed: 1 }) }))).toContain(ROOT);
  });

  test("a changed file with no line counts still counts", () => {
    expect(listed(layout({ badgeByPath: badge({ changedFiles: 1 }) }))).toContain(ROOT);
  });

  test("with a chat running on it, it is listed", () => {
    expect(listed(layout({ agentCount: (p) => (p === ROOT ? 1 : 0) }))).toContain(ROOT);
  });

  test("with an Aura chat mid-turn on it, it is listed", () => {
    expect(listed(layout({ workingRoots: new Set([ROOT]) }))).toContain(ROOT);
  });

  test("with a chat waiting for you, it is listed", () => {
    expect(listed(layout({ unreadAt: (p) => p === ROOT }))).toContain(ROOT);
  });

  test("while it is the workspace in front, it is listed", () => {
    expect(listed(layout({ activePath: ROOT }))).toContain(ROOT);
  });

  test("a repository with no other workspace lists nothing while it is idle", () => {
    const repo = layout({}, []);
    expect(listed(repo)).toEqual([]);
    expect(repo.homePath).toBe(ROOT);
  });

  test("a hidden main takes no quick-switch number", () => {
    const out = layoutRoster({
      workspaces: [{ id: ROOT, worktrees: [main, copy] } as Workspace],
      sort: "updated",
      custom: {},
      activePath: COPY,
      now: Date.now(),
      agentCount: () => 0,
      visited: {},
      collapsed: {},
      expanded: {},
      workingRoots: new Set(),
    });
    expect(out.switchPaths).toEqual([COPY]);
  });
});

describe("the heading's Sort by and Filter by project", () => {
  const day = 86_400;
  const old = ref("/code/app-old", { created_at: 100 * day, head_committed_at: 300 * day });
  const fresh = ref("/code/app-new", { created_at: 200 * day, head_committed_at: 200 * day });

  test("Updated puts the workspace that changed last first", () => {
    expect(sortRows([fresh, old], "updated").map((w) => w.path)).toEqual([old.path, fresh.path]);
  });

  test("Created puts the workspace made last first", () => {
    expect(sortRows([old, fresh], "created").map((w) => w.path)).toEqual([fresh.path, old.path]);
  });

  const two = (repoFilter: string | null) =>
    layoutRoster({
      workspaces: [
        { id: ROOT, worktrees: [main, copy] } as Workspace,
        { id: "/code/api", worktrees: [ref("/code/api", { is_main: true, branch: "main" })] } as Workspace,
      ],
      sort: "updated",
      repoFilter,
      custom: {},
      activePath: COPY,
      now: Date.now(),
      agentCount: () => 0,
      visited: {},
      collapsed: {},
      expanded: {},
      workingRoots: new Set(),
    }).rest.map((r) => r.ws.id);

  test("a project filter lists that repository alone", () => {
    expect(two("/code/api")).toEqual(["/code/api"]);
  });

  test("All projects lists every repository", () => {
    expect(two(null)).toEqual([ROOT, "/code/api"]);
  });

  test("a filter naming a repository that is gone lists every repository", () => {
    expect(two("/code/removed")).toEqual([ROOT, "/code/api"]);
  });
});

describe("workspaces pinned and archived on their own", () => {
  const OTHER = "/code/app-login";
  const other = ref(OTHER, { branch: "feat/login" });
  const full = (over: Partial<RosterLayoutInput> = {}) =>
    layoutRoster({
      workspaces: [{ id: ROOT, worktrees: [main, copy, other] } as Workspace],
      sort: "updated",
      custom: {},
      activePath: ROOT,
      now: Date.now(),
      agentCount: () => 0,
      visited: {},
      collapsed: {},
      expanded: {},
      workingRoots: new Set(),
      ...over,
    });

  test("a pinned workspace leaves its repository and is listed first", () => {
    const out = full({ custom: { [COPY]: { pinned: true } } });
    expect(out.pinnedRows.map((row) => row.w.path)).toEqual([COPY]);
    expect(out.pinnedRows[0].repo.ws.id).toBe(ROOT);
    const repo = out.rest[0];
    expect([...repo.shown, ...repo.inactive].map((w) => w.path)).not.toContain(COPY);
    expect(out.switchPaths[0]).toBe(COPY);
  });

  test("a folded Pinned section gives its workspaces no number", () => {
    const out = full({
      custom: { [COPY]: { pinned: true } },
      collapsed: { [PINNED_KEY]: true },
    });
    expect(out.switchPaths).not.toContain(COPY);
  });

  test("an archived workspace leaves the list and waits at its foot", () => {
    const out = full({ custom: { [COPY]: { archived: 2 }, [OTHER]: { archived: 5 } } });
    const repo = out.rest[0];
    expect([...repo.shown, ...repo.inactive].map((w) => w.path)).toEqual([ROOT]);
    expect(out.archivedRows.map((row) => row.w.path)).toEqual([OTHER, COPY]);
    expect(out.switchPaths).toEqual([ROOT]);
  });

  test("the repository's pin is not its main checkout's", () => {
    const out = full({ custom: { [ROOT]: { pinned: true } } });
    expect(out.pinnedRows).toEqual([]);
    expect(out.pinned.map((repo) => repo.ws.id)).toEqual([ROOT]);
  });
});
