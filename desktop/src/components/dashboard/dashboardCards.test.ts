import { describe, expect, test } from "bun:test";

import type { WorkspaceOverview } from "../ui/workspace-preview-card";
import type { WorkspaceRowSource } from "../workspaces/useWorkspaceRows";
import type { WorkspaceCopy } from "../workspaces/workspacesModel";
import { dashboardCards, mainInUse } from "./dashboardCards";

// The Dashboard is a board of work. A repository's main checkout sitting
// clean and idle is not work, and two of them would be two cards reading
// "main / main". Busy, it is a card under its repository's name.

function copy(over: Partial<WorkspaceCopy> = {}): WorkspaceCopy {
  return {
    path: "/code/app-search",
    root: "/code/app",
    projectName: "app",
    projectLetter: "A",
    branch: "feat/search",
    title: "search",
    isMain: false,
    isActive: false,
    committedAt: 1_699_999_000,
    createdAt: null,
    added: 0,
    removed: 0,
    changedFiles: 0,
    agents: [],
    ...over,
  };
}

function main(root: string, over: Partial<WorkspaceCopy> = {}): WorkspaceCopy {
  const name = root.split("/").pop()!;
  return copy({
    path: root,
    root,
    projectName: name,
    branch: "main",
    title: "main",
    isMain: true,
    ...over,
  });
}

function row(c: WorkspaceCopy): WorkspaceOverview {
  return {
    id: c.path,
    title: c.title,
    branch: c.branch,
    project: c.projectName,
    projectId: c.root,
    stage: "in-progress",
    updatedAt: 0,
    timeLabel: "1h ago",
    unread: c.agents.some((a) => a.attention),
    workflow: { state: "no-pr" },
  };
}

function board(copies: WorkspaceCopy[], unread: string[] = [], extra: WorkspaceOverview[] = []) {
  const sources = new Map<string, WorkspaceRowSource>(
    copies.map((c) => [c.path, { kind: "copy", copy: c, pr: null }]),
  );
  return dashboardCards(
    [...copies.map(row), ...extra],
    (id) => sources.get(id),
    (path) => unread.includes(path),
  );
}

const chat = { agentId: "claude", label: "Claude", attention: false };

describe("a main checkout on the Dashboard", () => {
  test("clean and idle, it is left off; its copies stay", () => {
    const cards = board([main("/code/app"), copy()]);
    expect(cards.map((c) => c.id)).toEqual(["/code/app-search"]);
  });

  test("with uncommitted edits, it is a card under its repository's name", () => {
    const [card] = board([main("/code/app", { added: 3, removed: 1, changedFiles: 2 })]);
    expect(card.title).toBe("app");
    expect(card.branch).toBe("main");
  });

  test("a changed file with no line counts (a rename, a binary) still counts", () => {
    expect(board([main("/code/app", { changedFiles: 1 })])).toHaveLength(1);
  });

  test("with a chat running on it, it is a card", () => {
    expect(board([main("/code/app", { agents: [chat] })]).map((c) => c.title)).toEqual(["app"]);
  });

  test("with a chat waiting for you in the background, it is a card marked unread", () => {
    const [card] = board([main("/code/app")], ["/code/app"]);
    expect(card.title).toBe("app");
    expect(card.unread).toBe(true);
  });

  test("two busy mains read as their two repositories, never as main and main", () => {
    const cards = board([
      main("/code/interface-system", { added: 1 }),
      main("/code/design-system", { agents: [chat] }),
    ]);
    expect(cards.map((c) => c.title)).toEqual(["interface-system", "design-system"]);
  });

  test("copies and cloud threads pass through untouched", () => {
    const cloud = { ...row(copy({ path: "cloud:job-1" })), title: "Cloud run" };
    const c = copy();
    const cards = board([c], [], [cloud]);
    expect(cards).toEqual([row(c), cloud]);
  });

  test("mainInUse is false only when nothing is happening", () => {
    expect(mainInUse(main("/code/app"), false)).toBe(false);
    expect(mainInUse(main("/code/app"), true)).toBe(true);
  });
});
