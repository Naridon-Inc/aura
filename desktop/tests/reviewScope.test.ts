// Which work a page is about, and where its buttons land.
//
//   bun test ./tests/reviewScope.test.ts
//
// AURA-1363. A review is read from somewhere other than where the work
// happened: another branch, another folder, weeks later, with the checkout long
// since moved on. The page carried one set of words for both, so "Run them now"
// ran the checks on whatever was checked out and reported the result beside a
// run from last Tuesday. A historical origin was being read as the active
// destination.
//
// These tests hold two lines: what a record describes is only ever what the
// record carries, and an action says what it will touch before it is pressed.

import { describe, expect, it } from "bun:test";

import {
  actionTarget,
  projectName,
  readingFromElsewhere,
  versionWords,
  whereItHappened,
  type ReviewScope,
  type WorkingTarget,
} from "../src/lib/reviewScope";

const SCOPE: ReviewScope = {
  project: "antigua",
  branch: "session-transcript-link",
  worktree: "antigua",
  revision: "a1b2c3d4e5f6",
};

const HERE: WorkingTarget = { branch: "session-transcript-link", dirty: false, known: true };
const ELSEWHERE: WorkingTarget = { branch: "main", dirty: false, known: true };
const UNKNOWN: WorkingTarget = { branch: null, dirty: false, known: false };

describe("what this page is about", () => {
  it("names the project by the word a person calls it", () => {
    expect(projectName("/Users/me/.aura/worktrees/antigua")).toBe("antigua");
    expect(projectName("/Users/me/.aura/worktrees/antigua/")).toBe("antigua");
  });

  it("says where the work happened, using only what the record carries", () => {
    expect(whereItHappened(SCOPE)).toBe(
      "In antigua, on the session-transcript-link branch, in the antigua folder.",
    );
  });

  it("leaves out a branch the record never recorded, rather than borrowing one", () => {
    const recovered: ReviewScope = { ...SCOPE, branch: null, worktree: null };

    expect(whereItHappened(recovered)).toBe("In antigua.");
    expect(whereItHappened(recovered)).not.toContain("branch");
  });

  it("says plainly when a run's changes were never saved", () => {
    expect(versionWords(null)).toContain("Not saved");
    expect(versionWords("  ")).toContain("Not saved");
  });

  it("shortens a version to something a person can read and match", () => {
    expect(versionWords("a1b2c3d4e5f6")).toBe("a1b2c3d");
  });
});

describe("reading a run from somewhere else", () => {
  it("notices when the checkout has moved to another branch", () => {
    expect(readingFromElsewhere(SCOPE, ELSEWHERE)).toBe(true);
    expect(readingFromElsewhere(SCOPE, HERE)).toBe(false);
  });

  it("never reports a mismatch it cannot actually see", () => {
    // Git couldn't be read, or the record carries no branch. Either way this is
    // an unknown, and an unknown is not a difference.
    expect(readingFromElsewhere(SCOPE, UNKNOWN)).toBe(false);
    expect(readingFromElsewhere({ ...SCOPE, branch: null }, ELSEWHERE)).toBe(false);
  });
});

describe("what an action would touch", () => {
  it("says the checks run on the checkout, not on the run being read", () => {
    const line = actionTarget("checks", SCOPE, HERE);

    expect(line).toContain("session-transcript-link");
    expect(line).toContain("Runs against");
  });

  it("warns outright when the checkout is a different branch from the run", () => {
    const line = actionTarget("checks", SCOPE, ELSEWHERE);

    expect(line).toContain("the main branch");
    expect(line).toContain("This run was on session-transcript-link");
    expect(line).toContain("won't be about it");
  });

  it("mentions unsaved work, because that is what would actually be checked", () => {
    const line = actionTarget("checks", SCOPE, { branch: "main", dirty: true, known: true });

    expect(line).toContain("changes you haven't saved yet");
  });

  it("describes the checkout vaguely rather than wrongly when git can't be read", () => {
    const line = actionTarget("checks", SCOPE, UNKNOWN);

    expect(line).toContain("what's checked out now");
    expect(line).not.toContain("branch,");
  });

  it("says the goal check reads this run's own version", () => {
    const line = actionTarget("goal", SCOPE, ELSEWHERE);

    expect(line).toContain("a1b2c3d");
    expect(line).toContain("this run's own version");
  });

  it("admits the goal check falls back to the checkout when nothing was saved", () => {
    const line = actionTarget("goal", { ...SCOPE, revision: null }, HERE);

    expect(line).toContain("Reads what's checked out now");
    expect(line).toContain("never saved");
  });

  it("says the comparison needs a saved version before it can happen", () => {
    expect(actionTarget("match", { ...SCOPE, revision: null }, HERE)).toContain(
      "saved to the project's history first",
    );
    expect(actionTarget("match", SCOPE, HERE)).toContain("a1b2c3d");
  });
});
