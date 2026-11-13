import { describe, expect, test } from "bun:test";

import type { Workspace, WorktreeRef } from "../../../lib/workspaceRef";
import type { WorktreeBadge } from "../../../lib/useWorktreeBadges";
import type { StagePins } from "../../../lib/workspaceStage";
import { layoutRoster } from "./rosterLayout";
import { STATUS_ORDER, layoutStatusGroups, rowStage, statusKey } from "./rosterStatusLayout";

// Grouped by status, the list sorts its workspaces into the stages the
// Dashboard shows them in, finished work first.

const ROOT = "/code/app";
const A = "/code/app-a";
const B = "/code/app-b";
const C = "/code/app-c";

function ref(path: string, over: Partial<WorktreeRef> = {}): WorktreeRef {
  return { path, branch: `feat/${path.slice(-1)}`, head: "abc", is_main: false, locked: false, ...over };
}

const main = ref(ROOT, { branch: "main", is_main: true });

function groups(
  over: {
    badgeByPath?: Record<string, WorktreeBadge>;
    stagePins?: StagePins;
    collapsed?: Record<string, boolean>;
    activePath?: string;
    pinned?: string[];
  } = {},
) {
  const ws = { id: ROOT, worktrees: [main, ref(A, { created_at: 3 }), ref(B, { created_at: 2 }), ref(C, { created_at: 1 })] } as Workspace;
  const custom = Object.fromEntries((over.pinned ?? []).map((p) => [p, { pinned: true }]));
  const input = {
    workspaces: [ws],
    sort: "created" as const,
    custom,
    activePath: over.activePath ?? A,
    now: Date.now(),
    agentCount: () => 0,
    badgeByPath: over.badgeByPath,
    visited: {},
    collapsed: over.collapsed ?? {},
    expanded: {},
    workingRoots: new Set<string>(),
  };
  return layoutStatusGroups({
    layout: layoutRoster(input),
    sort: "created",
    activePath: input.activePath,
    badgeByPath: over.badgeByPath,
    stagePins: over.stagePins ?? {},
    collapsed: input.collapsed,
  });
}

const paths = (g: ReturnType<typeof groups>, stage: string) =>
  g.groups.find((x) => x.stage === stage)!.rows.map((r) => r.w.path);

const pr = (state: string): WorktreeBadge => ({
  added: 0,
  removed: 0,
  changedFiles: 0,
  pr: { number: 7, state },
});

describe("the workspace list grouped by status", () => {
  test("every stage is listed, finished work first", () => {
    expect(groups().groups.map((g) => g.stage)).toEqual([...STATUS_ORDER]);
    expect(STATUS_ORDER).toEqual(["done", "in-review", "in-progress", "backlog", "canceled"]);
  });

  test("a workspace goes where its pull request puts it", () => {
    const g = groups({ badgeByPath: { [A]: pr("OPEN"), [B]: pr("MERGED"), [C]: pr("CLOSED") } });
    expect(paths(g, "in-review")).toEqual([A]);
    expect(paths(g, "done")).toEqual([B]);
    expect(paths(g, "canceled")).toEqual([C]);
  });

  test("with no pull request it is in progress, in Sort by order", () => {
    expect(paths(groups(), "in-progress")).toEqual([A, B, C]);
  });

  test("a stage moved by hand wins while the pull request still says the same", () => {
    const pins: StagePins = { [B]: { stage: "backlog", derived: "in-progress" } };
    expect(paths(groups({ stagePins: pins }), "backlog")).toEqual([B]);
    // Opening a PR is news: the pin no longer holds.
    expect(rowStage(B, { [B]: pr("OPEN") }, pins)).toBe("in-review");
  });

  test("the clean, idle main checkout is not listed; pinned workspaces stay under Pinned", () => {
    const g = groups({ pinned: [C] });
    expect(g.groups.flatMap((x) => x.rows.map((r) => r.w.path))).toEqual([A, B]);
  });

  test("a stage starts folded unless the workspace you are in is under it", () => {
    const g = groups({ activePath: B, badgeByPath: { [A]: pr("OPEN") } });
    expect(g.groups.find((x) => x.stage === "in-progress")!.collapsed).toBe(false);
    expect(g.groups.find((x) => x.stage === "in-review")!.collapsed).toBe(true);
  });

  test("a fold set by hand is kept either way", () => {
    const g = groups({
      collapsed: { [statusKey("in-progress")]: true, [statusKey("done")]: false },
    });
    expect(g.groups.find((x) => x.stage === "in-progress")!.collapsed).toBe(true);
    expect(g.groups.find((x) => x.stage === "done")!.collapsed).toBe(false);
  });

  test("⌘1–⌘9 count the rows painted, skipping folded stages", () => {
    const g = groups({ badgeByPath: { [C]: pr("OPEN") }, collapsed: { [statusKey("in-review")]: true } });
    expect(g.switchPaths).toEqual([A, B]);
  });
});
