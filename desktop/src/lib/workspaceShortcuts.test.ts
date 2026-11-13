import { describe, expect, test } from "bun:test";

import type { WorktreeRef } from "./workspaceRef";
import { ADD_PROJECT_EVENT, archiveTarget, requestAddProject, type AddProjectDetail } from "./workspaceShortcuts";

function wt(path: string, isMain = false): WorktreeRef {
  return { path, branch: isMain ? "main" : "feat", head: "abc", is_main: isMain, locked: false };
}

const lists: Record<string, WorktreeRef[]> = {
  "/repo": [wt("/repo", true), wt("/repo/.claude/worktrees/one")],
};

describe("what ⌘⇧A archives", () => {
  test("nothing open is nothing to archive", () => {
    expect(archiveTarget(null, lists)).toEqual({ kind: "none" });
    expect(archiveTarget("", lists)).toEqual({ kind: "none" });
  });

  test("a copy is archived by its own path", () => {
    expect(archiveTarget("/repo/.claude/worktrees/one", lists)).toEqual({
      kind: "copy",
      path: "/repo/.claude/worktrees/one",
    });
    expect(archiveTarget("/repo/.claude/worktrees/one/", lists).kind).toBe("copy");
  });

  test("the project's own folder is never archived from here", () => {
    expect(archiveTarget("/repo", lists)).toEqual({ kind: "main", path: "/repo" });
  });

  test("a copy is found through its own list too, where it is a key", () => {
    // `git worktree list` run in a copy lists every checkout, the copy among
    // them, so the copy's own key does not make it the main folder.
    const fromCopy = { "/repo/.claude/worktrees/one": lists["/repo"]! };
    expect(archiveTarget("/repo/.claude/worktrees/one", fromCopy).kind).toBe("copy");
  });

  test("a folder no list knows yet is taken for the project, not a copy", () => {
    expect(archiveTarget("/elsewhere", lists)).toEqual({ kind: "main", path: "/elsewhere" });
    expect(archiveTarget("/repo/.claude/worktrees/one", {}).kind).toBe("main");
  });
});

describe("asking for the add-project menu", () => {
  test("says no when nothing draws it", () => {
    expect(requestAddProject(new EventTarget())).toBe(false);
  });

  test("says yes once a listener takes it, and only the first one does", () => {
    const target = new EventTarget();
    let opened = 0;
    const take = (e: Event) => {
      const d = (e as CustomEvent<AddProjectDetail>).detail;
      if (d.handled) return;
      d.handled = true;
      opened++;
    };
    target.addEventListener(ADD_PROJECT_EVENT, take);
    target.addEventListener(ADD_PROJECT_EVENT, take.bind(null));
    expect(requestAddProject(target)).toBe(true);
    expect(opened).toBe(1);
  });
});
