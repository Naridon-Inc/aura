// reverseApplyDiff — recover the "before" text of a file from its "after" text
// and the unified diff between them.
//
// Why this exists: an editable diff needs the WHOLE current file in the right
// pane (so a save writes a complete file back), and the whole original in the
// left pane to compare against. The current file is one read from disk. The
// original is whatever the diff was taken against — HEAD, a session's start
// commit, a worktree's fork base — and git already told us exactly how the two
// differ. Walking that patch backwards over the current text gives the original
// for any base without a second git command, and stays in step with the diff
// that is on screen by construction.
//
// A leaf module with no React: the reconstruction is the claim, so it is
// testable without an editor.

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

type Hunk = {
  /** 1-based first line of this hunk in the NEW file. 0 for an empty side. */
  newStart: number;
  /** The new-side lines the hunk claims are there (context + additions). */
  newLines: string[];
  /** The old-side lines to put back in their place (context + removals). */
  oldLines: string[];
  /** Whether the old side's last line lacked a trailing newline. */
  oldNoNewline: boolean;
  /** Whether the new side's last line lacked a trailing newline. */
  newNoNewline: boolean;
};

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  // Which side the previous content line belonged to, so a "\ No newline"
  // marker can be attributed to it.
  let lastSide: "old" | "new" | "both" | null = null;
  for (const raw of diff.split("\n")) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      cur = {
        newStart: parseInt(m[3], 10),
        newLines: [],
        oldLines: [],
        oldNoNewline: false,
        newNoNewline: false,
      };
      hunks.push(cur);
      lastSide = null;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("\\")) {
      if (lastSide === "old" || lastSide === "both") cur.oldNoNewline = true;
      if (lastSide === "new" || lastSide === "both") cur.newNoNewline = true;
      continue;
    }
    if (raw.startsWith("diff --git")) {
      // A second file's patch — nothing past here belongs to this file.
      break;
    }
    const lead = raw.charAt(0);
    if (lead === "+") {
      cur.newLines.push(raw.slice(1));
      lastSide = "new";
    } else if (lead === "-") {
      cur.oldLines.push(raw.slice(1));
      lastSide = "old";
    } else if (lead === " ") {
      const body = raw.slice(1);
      cur.newLines.push(body);
      cur.oldLines.push(body);
      lastSide = "both";
    } else if (raw === "") {
      // git prints an empty context line as a single space; a bare empty
      // string only appears as the diff's own trailing newline. Skip it.
      continue;
    } else {
      // Anything else inside a hunk is not a line of the file.
      continue;
    }
  }
  return hunks;
}

/** Split file text into lines, remembering whether it ended with a newline so
 *  the reconstruction can put one back honestly. */
function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

/** Rebuild the original text from the current text and the unified diff that
 *  turned the original into it.
 *
 *  Returns null when the diff does not describe this text — the file moved on
 *  disk between the two reads, or the patch belongs to another version — so the
 *  caller can fall back rather than show a made-up "before". A diff with no
 *  hunks means nothing changed: the original IS the current text. */
export function reverseApplyDiff(diff: string, current: string): string | null {
  const hunks = parseHunks(diff);
  const { lines, trailingNewline } = splitLines(current);
  if (hunks.length === 0) return current;

  const out: string[] = [];
  let cursor = 0; // 0-based index into `lines`
  let origTrailing = trailingNewline;
  for (const h of hunks) {
    // A hunk on an empty new side (`+0,0`) starts "before line 1".
    const at = Math.max(0, h.newStart - 1);
    if (at < cursor) return null;
    if (at > lines.length) return null;
    // Unchanged lines between hunks belong to both versions.
    for (; cursor < at; cursor++) out.push(lines[cursor]);
    // The hunk's own account of the new side must match what is on disk.
    for (let i = 0; i < h.newLines.length; i++) {
      if (lines[cursor + i] !== h.newLines[i]) return null;
    }
    cursor += h.newLines.length;
    out.push(...h.oldLines);
    // A hunk that touches the end of the file also tells us about its final
    // newline; one that doesn't leaves the current file's answer standing.
    if (cursor >= lines.length) {
      if (h.oldNoNewline) origTrailing = false;
      else if (h.newNoNewline) origTrailing = true;
    }
  }
  for (; cursor < lines.length; cursor++) out.push(lines[cursor]);
  if (out.length === 0) return "";
  return out.join("\n") + (origTrailing ? "\n" : "");
}
