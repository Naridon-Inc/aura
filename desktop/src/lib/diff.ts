// Line diffs in the shape the shared file diff draws.
//
// `diffText` compares two versions of the same text — a piece of code as it
// stands and as it would stand — so a question like "bring this back?" can
// show what would move instead of two blocks to compare by eye.
// `parseUnifiedDiff` reads a diff git already wrote into the same rows.

import type { DiffLine } from "../components/ui/workspace-patterns";

/** How many cells the comparison may fill before it shows both versions whole.
 *  Two thousand-line versions are a million cells, a few milliseconds; past
 *  that a single piece of code is rare, and reading the two sides is quicker
 *  than waiting for a line-by-line match. */
const MAX_CELLS = 1_000_000;

function splitLines(text: string): string[] {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed === "" ? [] : trimmed.split("\n");
}

/** What changes, line by line, going from `before` to `after`. Line numbers
 *  count from the start of each text, not of any file it sits in. */
export function diffText(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    return [
      ...a.map((content, i): DiffLine => ({ type: "removed", content, oldLine: i + 1 })),
      ...b.map((content, j): DiffLine => ({ type: "added", content, newLine: j + 1 })),
    ];
  }
  // Longest common run of lines, filled from the end so the walk below can
  // read it forwards.
  const width = m + 1;
  const common = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      common[i * width + j] =
        a[i] === b[j]
          ? common[(i + 1) * width + j + 1] + 1
          : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", content: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (common[(i + 1) * width + j] >= common[i * width + j + 1]) {
      out.push({ type: "removed", content: a[i], oldLine: i + 1 });
      i++;
    } else {
      out.push({ type: "added", content: b[j], newLine: j + 1 });
      j++;
    }
  }
  for (; i < n; i++) out.push({ type: "removed", content: a[i], oldLine: i + 1 });
  for (; j < m; j++) out.push({ type: "added", content: b[j], newLine: j + 1 });
  return out;
}

/** Keep `keep` lines of context around each change and fold every longer
 *  unchanged run into one row that says how many lines it hides. Three lines
 *  is what a unified diff keeps, so a folded piece reads like any patch. */
export function foldContext(lines: DiffLine[], keep = 3): DiffLine[] {
  const out: DiffLine[] = [];
  let start = 0;
  while (start < lines.length) {
    if (lines[start].type !== "context") {
      out.push(lines[start++]);
      continue;
    }
    let end = start;
    while (end < lines.length && lines[end].type === "context") end++;
    const head = start === 0 ? 0 : keep;
    const tail = end === lines.length ? 0 : keep;
    const hidden = end - start - head - tail;
    if (hidden > 1) {
      out.push(...lines.slice(start, start + head));
      out.push({ type: "hunk", content: `${hidden} unchanged lines` });
      out.push(...lines.slice(end - tail, end));
    } else {
      out.push(...lines.slice(start, end));
    }
    start = end;
  }
  return out;
}

/** Turn a unified diff into numbered rows. Line numbers start from each
 *  hunk header; a diff without headers is shown unnumbered. */
const GIT_HEADER =
  /^(?:new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files .* differ$)/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("diff --git") || line.startsWith("index ")) continue;
    // git's own notes about the file, not lines of it: before the first hunk
    // (mode, rename, binary), and the no-final-newline marker anywhere.
    if (oldLine === undefined && GIT_HEADER.test(line)) continue;
    if (line.startsWith("\\ ")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ type: "hunk", content: line });
      continue;
    }
    if (line[0] === "+") {
      out.push({ type: "added", content: line.slice(1), newLine });
      if (newLine != null) newLine++;
    } else if (line[0] === "-") {
      out.push({ type: "removed", content: line.slice(1), oldLine });
      if (oldLine != null) oldLine++;
    } else {
      out.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
        oldLine,
        newLine,
      });
      if (oldLine != null) oldLine++;
      if (newLine != null) newLine++;
    }
  }
  return out;
}
