// A whole-file unified diff of two texts, one hunk with full context — enough
// for the block to count lines and place pieces by their new line numbers.
// Harness-only: the real diff comes from git.

export function lineDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  // Longest common subsequence over lines; the files here are a few dozen
  // lines, so the table is small.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+${b[j]}`);
      j++;
    } else {
      out.push(`-${a[i]}`);
      i++;
    }
  }
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`, ...out].join("\n");
}
