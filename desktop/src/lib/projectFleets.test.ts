import { describe, expect, test } from "bun:test";

import {
  fleetHoldsRoot,
  fleetRootFor,
  foldFleets,
  type ProjectFleet,
} from "./projectFleets";
import type { WorktreeRef } from "./workspaceRef";

// The bug these pin: "Naridon Mono" appeared twice in the Projects list, each
// copy claiming the same 381 parallel copies. Both roots were checkouts of one
// repository — `/Users/me/Documents/Naridon Mono` and the Codex worktree
// `~/.codex/worktrees/v2-vision-atomic-admission/Naridon Mono` — so git
// answered both with the same fleet and the roster drew it twice.

const HOME = "/Users/me/Documents/Naridon Mono";
const COPY = "/Users/me/.codex/worktrees/v2-vision-atomic-admission/Naridon Mono";

function wt(path: string, isMain = false): WorktreeRef {
  return { path, branch: "", head: "", is_main: isMain, locked: false };
}

const FLEET = [wt(HOME, true), wt(COPY), wt("/Users/me/Documents/other-copy")];

describe("one project per repository", () => {
  test("two checkouts of one repo fold into a single project", () => {
    const fleets = foldFleets([HOME, COPY], { [HOME]: FLEET, [COPY]: FLEET });
    expect(fleets).toHaveLength(1);
    expect(fleets[0]!.root).toBe(HOME);
    expect(fleets[0]!.members).toEqual([HOME, COPY]);
  });

  test("the project is the repo's home checkout, not the copy you opened", () => {
    const fleets = foldFleets([COPY], { [COPY]: FLEET });
    expect(fleets[0]!.root).toBe(HOME);
    expect(fleets[0]!.worktrees).toHaveLength(3);
  });

  test("different repositories stay apart", () => {
    const otherHome = "/Users/me/Documents/aura";
    const otherFleet = [wt(otherHome, true)];
    const fleets = foldFleets([HOME, otherHome], {
      [HOME]: FLEET,
      [otherHome]: otherFleet,
    });
    expect(fleets.map((f) => f.root)).toEqual([HOME, otherHome]);
  });

  test("first-seen order is kept, so the rail doesn't reshuffle", () => {
    const a = "/Users/me/a";
    const b = "/Users/me/b";
    const fleets = foldFleets([b, a, b], {
      [a]: [wt(a, true)],
      [b]: [wt(b, true)],
    });
    expect(fleets.map((f) => f.root)).toEqual([b, a]);
  });

  test("a root git hasn't answered for yet stands on its own", () => {
    // `worktreesByRoot` fills lazily and a failed enumeration is never cached
    // as `[]`, so an unlisted root must not be guessed into another project —
    // a wrong merge hides a real project behind one it has nothing to do with.
    const fleets = foldFleets([HOME, COPY], { [HOME]: FLEET });
    expect(fleets).toHaveLength(2);
    expect(fleets.map((f) => f.root)).toEqual([HOME, COPY]);
  });

  test("the fleet is taken from whichever member was enumerated", () => {
    const fleets = foldFleets([COPY, HOME], { [HOME]: FLEET });
    expect(fleets).toHaveLength(2);
    const home = fleets.find((f) => f.root === HOME)!;
    expect(home.worktrees).toHaveLength(3);
  });

  test("a folder that is no repo at all is still a project", () => {
    const plain = "/Users/me/notes";
    const fleets = foldFleets([plain], { [plain]: [] });
    expect(fleets).toEqual([{ root: plain, worktrees: [], members: [plain] }]);
  });

  test("a trailing slash is the same place", () => {
    const fleets = foldFleets([`${HOME}/`, HOME], { [HOME]: FLEET });
    expect(fleets).toHaveLength(1);
    expect(fleets[0]!.root).toBe(HOME);
  });

  test("empty input yields no projects", () => {
    expect(foldFleets([], {})).toEqual([]);
  });
});

describe("pointing a raw root at the project that was drawn", () => {
  const fleets: ProjectFleet[] = foldFleets([HOME, COPY], {
    [HOME]: FLEET,
    [COPY]: FLEET,
  });

  test("an opened copy resolves to its project", () => {
    expect(fleetRootFor(fleets, COPY)).toBe(HOME);
  });

  test("a root nothing claims is left alone", () => {
    expect(fleetRootFor(fleets, "/Users/me/elsewhere")).toBe("/Users/me/elsewhere");
  });

  test("the project header lights for the copy you are in", () => {
    expect(fleetHoldsRoot(fleets[0]!, COPY)).toBe(true);
    expect(fleetHoldsRoot(fleets[0]!, HOME)).toBe(true);
    expect(fleetHoldsRoot(fleets[0]!, "/Users/me/elsewhere")).toBe(false);
  });
});
