import { describe, expect, test } from "bun:test";

import type { TaskCopyRemoval } from "./api";
import { canRemoveTaskCopy, keptCopyBody, removeTaskCopyWith } from "./taskCopyRemoval";

const KEPT: TaskCopyRemoval = { outcome: "kept", unsaved: ["cloud/ has 2 files with uncommitted changes"] };

function deps(first: TaskCopyRemoval, agree: boolean) {
  const calls: boolean[] = [];
  const asked: string[] = [];
  return {
    calls,
    asked,
    remove: async (force: boolean): Promise<TaskCopyRemoval> => {
      calls.push(force);
      return force ? { outcome: "removed" } : first;
    },
    confirm: async (body: string) => {
      asked.push(body);
      return agree;
    },
  };
}

describe("canRemoveTaskCopy", () => {
  test("only a task that has stopped and still has a copy", () => {
    expect(canRemoveTaskCopy({ status: "done", worktree_path: "/r/x" })).toBe(true);
    expect(canRemoveTaskCopy({ status: "failed", worktree_path: "/r/x" })).toBe(true);
    expect(canRemoveTaskCopy({ status: "running", worktree_path: "/r/x" })).toBe(false);
    expect(canRemoveTaskCopy({ status: "done", worktree_path: null })).toBe(false);
  });
});

describe("removeTaskCopyWith", () => {
  test("a copy with nothing to lose goes without a question", async () => {
    const d = deps({ outcome: "removed" }, false);
    expect(await removeTaskCopyWith("/r/x", d)).toBe(true);
    expect(d.calls).toEqual([false]);
    expect(d.asked).toEqual([]);
  });

  test("unsaved work is listed, and the copy goes only on yes", async () => {
    const yes = deps(KEPT, true);
    expect(await removeTaskCopyWith("/r/x", yes)).toBe(true);
    expect(yes.calls).toEqual([false, true]);
    expect(yes.asked[0]).toContain("• cloud/ has 2 files with uncommitted changes");

    const no = deps(KEPT, false);
    expect(await removeTaskCopyWith("/r/x", no)).toBe(false);
    expect(no.calls).toEqual([false]);
  });
});

describe("keptCopyBody", () => {
  test("names the folder, the work lost, and the branches kept", () => {
    const body = keptCopyBody("/r/x", ["1 file with uncommitted changes"]);
    expect(body.startsWith("/r/x\n")).toBe(true);
    expect(body).toContain("• 1 file with uncommitted changes");
    expect(body).toContain("Its branch is kept");
  });
});
