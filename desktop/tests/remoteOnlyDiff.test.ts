// A teammate's file has no patch on this machine — and the honest answer to
// "show me their diff" is nothing, not something.
//
// A changeset file that arrived over the team plane carries a path and the
// symbols that moved, but no commit this clone has fetched and no baseline.
// Every other branch of `loadFileDiff` keys off one of those two, so such a
// file falls through to the last line — `git diff HEAD -- <path>` — which
// renders the *viewer's own* uncommitted edits to that path and prints them
// under the teammate's name. That is not an empty view or a broken one; it is
// a diff that looks entirely real and is attributed to the wrong person.
//
// So the guard is at the top of the function rather than at each call site:
// the door, not the doormat. These tests pin that no git call escapes for a
// remote-only file, and — just as important — that adding the guard did not
// quietly change where a normal file routes.

import { describe, expect, it, beforeEach, mock } from "bun:test";

import type { IntentChangesetFile } from "../src/lib/api";

let atCommit: Array<[string, string, string]> = [];
let base: Array<[string, string, string]> = [];
let workingTree: Array<[string, string, boolean]> = [];

mock.module("../src/lib/api", () => ({
  api: {
    gitDiffAtCommit: async (repoRoot: string, commit: string, path: string) => {
      atCommit.push([repoRoot, commit, path]);
      return "diff --git a/x b/x\n@@ committed @@";
    },
    gitDiffBase: async (repoRoot: string, baseSha: string, path: string) => {
      base.push([repoRoot, baseSha, path]);
      return "diff --git a/x b/x\n@@ since base @@";
    },
    gitDiff: async (repoRoot: string, path: string, sinceBase: boolean) => {
      workingTree.push([repoRoot, path, sinceBase]);
      return "diff --git a/x b/x\n@@ working tree @@";
    },
  },
}));

const { loadFileDiff } = await import("../src/lib/sessionDataCache");

const REPO = "/repo";

/** The shape the intent feed hands the diff view. Only the fields that steer
 *  the routing are set per test; the rest are what a real row carries. */
function file(over: Partial<IntentChangesetFile>): IntentChangesetFile {
  return {
    path: "src/lib/auth.ts",
    status: "M",
    symbols: [],
    ...over,
  } as IntentChangesetFile;
}

const gitCalls = () => atCommit.length + base.length + workingTree.length;

describe("a file we only know about from the team plane", () => {
  beforeEach(() => {
    atCommit = [];
    base = [];
    workingTree = [];
  });

  it("never reaches git, so nobody else's edits get someone's name on them", async () => {
    const out = await loadFileDiff(REPO, file({ remote_only: true }));

    expect(out).toBe("");
    expect(gitCalls()).toBe(0);
  });

  it("stays silent even when the viewer asked to widen the range", async () => {
    // `sinceBase` only ever widened the working-tree read — the exact branch a
    // remote file would otherwise land in.
    const out = await loadFileDiff(REPO, file({ remote_only: true }), true);

    expect(out).toBe("");
    expect(workingTree).toEqual([]);
  });

  it("is decided before the commit branch, not after it", async () => {
    // A cloud row can still carry a sha the server saw. This clone may never
    // have fetched it, and `git show` on a missing object fails — loudly for
    // the user, in a view that should have said "not on this machine".
    const out = await loadFileDiff(
      REPO,
      file({ remote_only: true, commit: "0f1e2d3", base: "aaaabbb" }),
    );

    expect(out).toBe("");
    expect(gitCalls()).toBe(0);
  });
});

describe("the ordinary files still route exactly where they did", () => {
  beforeEach(() => {
    atCommit = [];
    base = [];
    workingTree = [];
  });

  it("reads a landed run out of its commit", async () => {
    await loadFileDiff(REPO, file({ path: "src/a.ts", commit: "c0ffee1" }));

    expect(atCommit).toEqual([[REPO, "c0ffee1", "src/a.ts"]]);
    expect(base).toEqual([]);
    expect(workingTree).toEqual([]);
  });

  it("reads a native chat session against the baseline it started from", async () => {
    await loadFileDiff(REPO, file({ path: "src/b.ts", base: "9a8b7c6" }));

    expect(base).toEqual([[REPO, "9a8b7c6", "src/b.ts"]]);
    expect(atCommit).toEqual([]);
    expect(workingTree).toEqual([]);
  });

  it("reads a live claim off the working tree, and carries the range through", async () => {
    await loadFileDiff(REPO, file({ path: "src/c.ts" }), true);

    expect(workingTree).toEqual([[REPO, "src/c.ts", true]]);
    expect(atCommit).toEqual([]);
    expect(base).toEqual([]);
  });

  it("treats an explicit `remote_only: false` as the local file it is", async () => {
    // The Rust side skips the field when false, so it arrives absent far more
    // often than it arrives as `false` — but a `false` must not read as truthy
    // through any future refactor of the guard.
    await loadFileDiff(REPO, file({ path: "src/d.ts", remote_only: false }));

    expect(workingTree).toEqual([[REPO, "src/d.ts", false]]);
  });
});
