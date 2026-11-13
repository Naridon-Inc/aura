// What a working diff has nothing to draw for, so the pane can say so instead
// of opening an empty editor: a binary file (git prints no lines for it), or a
// change that is only whitespace while whitespace changes are hidden.

export type DiffEmptyState = "binary" | "whitespace" | null;

export function diffEmptyState(diff: string, hidingWhitespace: boolean): DiffEmptyState {
  if (/^Binary files .+ differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)) return "binary";
  if (hidingWhitespace && onlyWhitespace(diff)) return "whitespace";
  return null;
}

/** True when every hunk removes and adds the same lines once each line's
 *  leading and trailing whitespace is set aside — what the split view hides
 *  with whitespace changes off. Compared per hunk, so a line moved from one
 *  hunk to another still counts as a change. */
function onlyWhitespace(diff: string): boolean {
  let removed: string[] = [];
  let added: string[] = [];
  let sawChange = false;
  const hunkMatches = () =>
    removed.length === added.length && removed.every((line, i) => line === added[i]);
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      if (!hunkMatches()) return false;
      removed = [];
      added = [];
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    } else if (line.startsWith("-")) {
      removed.push(line.slice(1).trim());
      sawChange = true;
    } else if (line.startsWith("+")) {
      added.push(line.slice(1).trim());
      sawChange = true;
    }
  }
  return sawChange && hunkMatches();
}
