// What a result on this page is about, and what an action here would touch.
//
// Two different things wear the same words in a review. There is the work being
// read — a run that happened in some folder, on some branch, against some
// version of the code, possibly weeks ago and possibly on a branch that no
// longer exists. And there is the checkout you are standing in right now,
// which is where every button on the page actually lands.
//
// The page never distinguished them. "Run them now" ran the checks on whatever
// was checked out, under a heading about a run from last Tuesday, and reported
// the result beside that run's verdict as though it described it. A historical
// origin was being read as the active destination.
//
// So: one place that says what a record describes, and one that says what an
// action would touch — in words, with unknowns left unknown. Nothing here
// infers a scope it wasn't given; a missing branch stays missing rather than
// borrowing the branch you happen to be on.

export type ReviewScope = {
  /** The project's folder name — the word a person calls it by. */
  project: string;
  /** The branch the run was recorded on. Null when the row carries none: a
   *  record recovered from a branch blob has no authored branch, and guessing
   *  the one we read it from would name the wrong place. */
  branch: string | null;
  /** The checkout it happened in, by folder name. */
  worktree: string | null;
  /** The version of the code this record is about; null when its changes were
   *  never committed. */
  revision: string | null;
};

/** Where an action would land: the checkout in front of you, right now. */
export type WorkingTarget = {
  /** The branch currently checked out; null when it couldn't be read. */
  branch: string | null;
  /** Does the working tree have uncommitted changes? */
  dirty: boolean;
  /** False while the read is in flight or after it failed — the difference
   *  between "clean" and "we don't know" that a zeroed struct destroys. */
  known: boolean;
};

/** The project's own name from its root path. */
export function projectName(repoRoot: string): string {
  const trimmed = repoRoot.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || trimmed || "this project";
}

/** The version, in words a reader can act on. */
export function versionWords(revision: string | null): string {
  const rev = (revision ?? "").trim();
  if (!rev) return "Not saved to the project's history";
  return rev.length > 7 ? rev.slice(0, 7) : rev;
}

/** Where the run happened, as one sentence. Every clause is a fact the record
 *  actually carries; the ones it doesn't are simply absent. */
export function whereItHappened(scope: ReviewScope): string {
  const parts: string[] = [`In ${scope.project}`];
  if (scope.branch) parts.push(`on the ${scope.branch} branch`);
  if (scope.worktree) parts.push(`in the ${scope.worktree} folder`);
  return `${parts.join(", ")}.`;
}

/** Is the record being read from somewhere other than where it happened? Only
 *  true when both branches are known and differ — an unknown is never reported
 *  as a mismatch. */
export function readingFromElsewhere(scope: ReviewScope, working: WorkingTarget): boolean {
  if (!working.known || !working.branch || !scope.branch) return false;
  return working.branch !== scope.branch;
}

/** What an action on this page would actually run against. */
export type ActionKind =
  /** Commands that execute — they can only ever run on the working tree. */
  | "checks"
  /** Reading the code for the parts a goal needs — can be anchored to a commit. */
  | "goal"
  /** Comparing what was asked with what changed, at the run's own version. */
  | "match";

/** One line under an action saying what it will touch. It is not decoration:
 *  the checks button runs on the checkout, and beside a historical run that is
 *  a different thing from what the reader is looking at. */
export function actionTarget(
  kind: ActionKind,
  scope: ReviewScope,
  working: WorkingTarget,
): string {
  if (kind === "checks") {
    const where = working.known && working.branch ? `the ${working.branch} branch` : "what's checked out now";
    const dirt = working.known && working.dirty ? ", including changes you haven't saved yet" : "";
    const elsewhere = readingFromElsewhere(scope, working)
      ? ` This run was on ${scope.branch}, so the result won't be about it.`
      : "";
    return `Runs against ${where}${dirt}.${elsewhere}`;
  }
  if (kind === "goal") {
    return scope.revision
      ? `Reads the code as it was at ${versionWords(scope.revision)} — this run's own version.`
      : "Reads what's checked out now. This run's changes were never saved, so there's no version to read instead.";
  }
  return scope.revision
    ? `Compares what was asked with what changed at ${versionWords(scope.revision)}.`
    : "Needs this run's changes saved to the project's history first.";
}

/** True when a recorded fact is missing and must be shown as missing rather
 *  than filled in from the surroundings. */
export function unknownWord(): string {
  return "Not recorded";
}
