// Whether a token an answer puts in backticks names a git branch rather than
// a folder. Both are slash-separated words, so the shape alone can't tell
// `feat/cloud-parity` from `src/components`; what can is how branches are
// conventionally named — a work-type prefix (`feat/`, `fix/`, `release/`…),
// a remote in front (`origin/main`), or a full ref (`refs/heads/main`).
// A folder that happens to share one of those prefixes reads as a branch;
// common folder names (`docs/`, `test/`, `build/`) are kept off the list so
// real paths keep their folder icon.

const WORK_PREFIXES = new Set([
  "feat", "feature", "fix", "bugfix", "hotfix", "release", "chore",
  "refactor", "perf", "wip", "exp", "experiment", "spike", "revert",
  "dependabot", "renovate",
]);

const REMOTES = new Set(["origin", "upstream"]);

// One slash-separated part of a branch name, within what git accepts and
// what people actually write: no leading dot, no `.lock` ending.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function segmentsOk(segs: string[]): boolean {
  return segs.length > 0 && segs.every((s) => SEGMENT.test(s) && !s.endsWith(".lock"));
}

export function looksLikeBranchName(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 200 || /\s/.test(t) || t.includes("..")) return false;
  for (const ref of ["refs/heads/", "refs/remotes/"]) {
    if (t.startsWith(ref)) return segmentsOk(t.slice(ref.length).split("/"));
  }
  const segs = t.split("/");
  if (segs.length < 2 || !segmentsOk(segs)) return false;
  const head = segs[0]!.toLowerCase();
  if (REMOTES.has(head)) return true;
  return WORK_PREFIXES.has(head);
}
