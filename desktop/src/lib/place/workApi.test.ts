// The claim under test: every file, change and git question goes to the
// place the project is standing in, under the same name and with the same
// arguments the local command took — and nowhere near a machine when the
// window is standing on this laptop.
//
// `api` and `placeWork` are replaced by recorders, so what is checked is the
// ROUTING: which twin was called, with what. The commands themselves are
// covered on the Rust side.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearMachines, syncMachines } from "../activeMachine";

type Call = { name: string; args: unknown[] };
const calls: Call[] = [];

/** A module whose every member records itself and answers with `answer` —
 *  or refuses, for the names in `failing`. */
let answer: unknown = "ok";
const failing = new Set<string>();
const recorder = new Proxy(
  {},
  {
    get: (_target, name: string) => {
      return (...args: unknown[]) => {
        calls.push({ name, args });
        if (failing.has(name)) return Promise.reject(new Error("CONFLICT"));
        return Promise.resolve(answer);
      };
    },
  },
);

mock.module("../api", () => ({ api: recorder }));
// A namespace import (`import * as place`) is built from the module's
// export NAMES, which a bare Proxy does not have — so the recorder is laid
// over the real module's names, one recording member each.
const placeNames = Object.keys(await import("./placeWork"));
mock.module("./placeWork", () =>
  Object.fromEntries(
    placeNames.map((name) => [name, (recorder as Record<string, unknown>)[name]]),
  ),
);

const work = await import("./workApi");

const BOX = "ubuntu@18.196.118.42";
const HERE = "/Users/me/app";
const ELSEWHERE = "/Users/me/other";
/** The worktree a launched workspace lives in, on the box. */
const THERE = "/home/ubuntu/app-feat-x";

/** What every place twin is handed first: the box, the local root, and the
 *  worktree over there when the place has one. */
const AT = { machineId: BOX, repoRoot: HERE, remoteRoot: undefined };
const AT_WORKTREE = { machineId: BOX, repoRoot: HERE, remoteRoot: THERE };

beforeEach(() => {
  calls.length = 0;
  failing.clear();
  answer = "ok";
});
afterEach(() => clearMachines());

function last(): Call {
  const c = calls[calls.length - 1];
  if (!c) throw new Error("nothing was called");
  return c;
}

function standInBox(repoRoot: string | null = HERE, remoteRoot?: string) {
  syncMachines([{ key: "a", machineId: BOX, repoRoot, remoteRoot }], "a");
}

describe("on this laptop", () => {
  test("every question goes to the local twin, unchanged", async () => {
    await work.gitStatusV2(HERE);
    expect(last()).toEqual({ name: "gitStatusV2", args: [HERE] });

    await work.gitDiff(HERE, "src/a.rs", true);
    expect(last()).toEqual({ name: "gitDiff", args: [HERE, "src/a.rs", true] });

    await work.gitPush(HERE, true);
    expect(last()).toEqual({ name: "gitPush", args: [HERE, true] });

    await work.readFile(`${HERE}/src/a.rs`);
    expect(last()).toEqual({ name: "readFile", args: [`${HERE}/src/a.rs`] });

    await work.fsRename(`${HERE}/a`, `${HERE}/b`);
    expect(last()).toEqual({ name: "fsRename", args: [`${HERE}/a`, `${HERE}/b`] });

    await work.gitResetFiles(HERE);
    expect(last()).toEqual({ name: "gitResetFiles", args: [HERE] });

    await work.gitSync(HERE);
    expect(last()).toEqual({ name: "gitSync", args: [HERE] });

    await work.gitCommitGraph(HERE, 200);
    expect(last()).toEqual({ name: "gitCommitGraph", args: [HERE, 200] });
  });

  test("a scope is just the root, and polling is not needed", () => {
    expect(work.placeScope(HERE)).toBe(HERE);
    expect(work.pathScope(`${HERE}/x`)).toBe(`${HERE}/x`);
    expect(work.needsPolling(HERE)).toBe(false);
  });

  test("the work surfaces are always ready here, and nothing is asked", async () => {
    expect(await work.workReady(HERE)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("standing in a machine", () => {
  test("git on the project goes to the place twin, the place first", async () => {
    standInBox();
    await work.gitStatusV2(HERE);
    expect(last()).toEqual({ name: "placeGitStatusV2", args: [AT] });

    await work.gitDiff(HERE, "src/a.rs", true);
    expect(last()).toEqual({
      name: "placeGitDiff",
      args: [AT, "src/a.rs", true],
    });

    await work.gitDiffAtCommit(HERE, "abc123", "src/a.rs");
    expect(last()).toEqual({
      name: "placeGitDiffAtCommit",
      args: [AT, "abc123", "src/a.rs"],
    });

    await work.gitStage(HERE, ["a", "b"]);
    expect(last()).toEqual({ name: "placeGitStage", args: [AT, ["a", "b"]] });

    await work.gitCommit(HERE, "fix: it");
    expect(last()).toEqual({ name: "placeGitCommit", args: [AT, "fix: it"] });

    await work.gitPush(HERE, false);
    expect(last()).toEqual({ name: "placeGitPush", args: [AT, false] });

    await work.gitCheckout(HERE, "origin/feat");
    expect(last()).toEqual({
      name: "placeGitCheckout",
      args: [AT, "origin/feat"],
    });

    await work.gitResetFiles(HERE);
    expect(last()).toEqual({ name: "placeGitResetFiles", args: [AT] });

    await work.fsFindFiles(HERE);
    expect(last()).toEqual({ name: "placeFsFindFiles", args: [AT] });

    await work.gitCommitGraph(HERE, 200);
    expect(last()).toEqual({ name: "placeGitCommitGraph", args: [AT, 200] });
  });

  test("a file under the project is read and written on the box", async () => {
    standInBox();
    const file = `${HERE}/src/a.rs`;
    await work.readFile(file);
    expect(last()).toEqual({ name: "placeFsRead", args: [AT, file] });

    await work.writeFile(file, "fn main() {}");
    expect(last()).toEqual({
      name: "placeFsWrite",
      args: [AT, file, "fn main() {}"],
    });

    await work.listDir(`${HERE}/src`);
    expect(last()).toEqual({ name: "placeFsList", args: [AT, `${HERE}/src`] });

    await work.fsRename(file, `${HERE}/src/b.rs`);
    expect(last()).toEqual({
      name: "placeFsRename",
      args: [AT, file, `${HERE}/src/b.rs`],
    });

    await work.fsDelete(file);
    expect(last()).toEqual({ name: "placeFsDelete", args: [AT, file] });
  });

  test("a launched workspace carries its worktree on the box into every call", async () => {
    // The place is still keyed and spelled by the LOCAL root — that is what
    // every store and cache use, and what `paths::rel_of` cuts against over
    // there — but the box runs each command in the sibling worktree
    // `box_start` made, not in the machine's main checkout.
    standInBox(HERE, THERE);
    await work.gitStatusV2(HERE);
    expect(last()).toEqual({ name: "placeGitStatusV2", args: [AT_WORKTREE] });

    await work.readFile(`${HERE}/src/a.rs`);
    expect(last()).toEqual({
      name: "placeFsRead",
      args: [AT_WORKTREE, `${HERE}/src/a.rs`],
    });

    await work.gitCommit(HERE, "fix: it");
    expect(last()).toEqual({ name: "placeGitCommit", args: [AT_WORKTREE, "fix: it"] });

    await work.gitCommitGraph(HERE, 50);
    expect(last()).toEqual({ name: "placeGitCommitGraph", args: [AT_WORKTREE, 50] });

    // Another project in the same window is still not on that box.
    await work.gitStatusV2(ELSEWHERE);
    expect(last()).toEqual({ name: "gitStatusV2", args: [ELSEWHERE] });
  });

  test("another project, and a path outside this one, stay on the laptop", async () => {
    standInBox();
    await work.gitStatusV2(ELSEWHERE);
    expect(last()).toEqual({ name: "gitStatusV2", args: [ELSEWHERE] });

    await work.readFile(`${ELSEWHERE}/a.rs`);
    expect(last()).toEqual({ name: "readFile", args: [`${ELSEWHERE}/a.rs`] });
  });

  test("a place with no project owns roots but not bare paths", async () => {
    standInBox(null);
    await work.gitBranch(HERE);
    expect(last()).toEqual({ name: "placeGitBranch", args: [AT] });

    // No root to cut the path against on the far side — it stays here rather
    // than being guessed onto the box.
    await work.readFile(`${HERE}/a.rs`);
    expect(last()).toEqual({ name: "readFile", args: [`${HERE}/a.rs`] });
  });

  test("sync is pull then push, and a failed pull pushes nothing", async () => {
    standInBox();
    answer = "";
    await work.gitSync(HERE);
    expect(calls.map((c) => c.name)).toEqual(["placeGitPull", "placeGitPush"]);
    expect(calls[1]!.args).toEqual([AT, false]);

    calls.length = 0;
    failing.add("placeGitPull");
    await expect(work.gitSync(HERE)).rejects.toThrow("CONFLICT");
    expect(calls.map((c) => c.name)).toEqual(["placeGitPull"]);
  });

  test("the footer's totals are summed from the per-file numbers", async () => {
    standInBox();
    answer = [
      { path: "a", additions: 3, deletions: 1 },
      { path: "b", additions: 0, deletions: 7 },
    ];
    const totals = await work.gitDiffStats(HERE);
    expect(last().name).toBe("placeGitDiffStatsPerFile");
    expect(totals).toEqual({ changed_files: 2, added: 3, removed: 8 });
  });

  test("readiness is the box's own sentence, or nothing", async () => {
    standInBox(HERE, THERE);
    expect(await work.workReady(HERE)).toBeNull();
    expect(last()).toEqual({ name: "placeWorkReady", args: [AT_WORKTREE] });

    failing.add("placeWorkReady");
    // What the machine said — a `cd` that failed, a `git` that refused — is
    // the empty state's whole text; nothing here rewrites it.
    expect(await work.workReady(HERE)).toBe("CONFLICT");
  });

  test("a scope tells the box's copy apart from the laptop's", () => {
    standInBox();
    expect(work.placeScope(HERE)).toBe(`${BOX}\0${HERE}`);
    expect(work.placeScope(ELSEWHERE)).toBe(ELSEWHERE);
    expect(work.pathScope(`${HERE}/x`)).toBe(`${BOX}\0${HERE}/x`);
    expect(work.rootOfScope(work.placeScope(HERE))).toBe(HERE);
    expect(work.rootOfScope(ELSEWHERE)).toBe(ELSEWHERE);
  });

  test("a worktree on the box is a scope of its own, and still yields its root", () => {
    standInBox(HERE, THERE);
    const scope = work.placeScope(HERE);
    expect(scope).toBe(`${BOX}\0${THERE}\0${HERE}`);
    expect(work.rootOfScope(scope)).toBe(HERE);
    // The same box on its main checkout is another scope.
    clearMachines();
    standInBox(HERE);
    expect(work.placeScope(HERE)).toBe(`${BOX}\0${HERE}`);
    expect(work.needsPolling(HERE)).toBe(true);
    expect(work.needsPolling(ELSEWHERE)).toBe(false);
  });
});
