// diffSides — one unified diff, rebuilt into the two file sides a split view
// needs, plus the map back to where a single changed PIECE lives in them.
//
// Two jobs, and the second is why this left SplitDiff.tsx:
//
//  1. `materializeSides` rebuilds `original` / `modified` buffers so Monaco's
//     DiffEditor has real text to compare. It was always here; it just lived
//     inside the renderer.
//
//  2. `symbolSpan` answers "which lines is this piece?" — so clicking a piece
//     in the header can highlight it in the code below. That answer is NOT
//     obvious, and getting it wrong points the reader at unrelated code:
//
//     • The materialized buffers DROP hunk headers, so a materialized line
//       number is diff-relative and has nothing to do with the file's real line
//       numbers. `origAt` / `modAt` carry the real number for every line we
//       kept, so both coordinate systems stay reachable.
//     • A changed piece's recorded `start_line` / `end_line` belong to ONE
//       tree, not both: `aura change-note` records an added or modified piece
//       against the NEW tree and a deleted one against the OLD tree
//       (aura-cli/src/intent_vs_actual.rs). So a *modified* piece shown in the
//       "Previous was this" column carries line numbers that describe the
//       right-hand pane — using them there would highlight the wrong code.
//       That case falls back to finding the piece's declaration by name.
//
// A leaf module with no React: the mapping is the claim, so it is testable
// without mounting an editor.

import type { ChangedSymbol } from "./api";

// `DiffSideKind`, `SymbolSpan` and `DiffFocus` moved to `@shared/ui/diff/focus`
// on 2026-08-27 — the shared UnifiedDiff renderer owns its prop types now that
// the console draws diffs too. Re-exported here so every desktop import site
// keeps reading them from beside the mapping that resolves them.
import type { DiffSideKind, SymbolSpan } from "@shared/ui/diff/focus";

export type { DiffSideKind, SymbolSpan, DiffFocus } from "@shared/ui/diff/focus";

export type DiffSides = {
  original: string;
  modified: string;
  /** An add-only or delete-only diff (a new or removed file). The split has
   *  nothing to compare, so callers fall back to the unified view. */
  oneSided: boolean;
  /** Real old-file line number for each line of `original`, in order. */
  origAt: number[];
  /** Real new-file line number for each line of `modified`, in order. */
  modAt: number[];
};

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** File-level furniture git puts around the hunks — never content. */
function isFileHeader(raw: string): boolean {
  return (
    raw.startsWith("diff --git") ||
    raw.startsWith("index ") ||
    raw.startsWith("--- ") ||
    raw.startsWith("+++ ") ||
    raw.startsWith("new file mode") ||
    raw.startsWith("deleted file mode") ||
    raw.startsWith("similarity index") ||
    raw.startsWith("rename ") ||
    raw.startsWith("old mode") ||
    raw.startsWith("new mode") ||
    raw.startsWith("\\")
  );
}

/** Rebuild the two file sides from a unified diff so Monaco's split view has
 *  real `original` / `modified` buffers, and record the real file line number
 *  behind every line we keep. File/hunk headers are dropped; `+` lines land
 *  only on the right, `-` only on the left, context on both. */
export function materializeSides(diff: string): DiffSides {
  const left: string[] = [];
  const right: string[] = [];
  const origAt: number[] = [];
  const modAt: number[] = [];
  // The cursors walk from each hunk header. A diff with no header at all (a
  // synthesised whole-file body) reads as starting at line 1, which is what it
  // means anyway.
  let oldNo = 1;
  let newNo = 1;
  for (const raw of diff.split("\n")) {
    if (isFileHeader(raw)) continue;
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldNo = parseInt(hunk[1], 10);
      newNo = parseInt(hunk[2], 10);
      continue;
    }
    const lead = raw.charAt(0);
    if (lead === "+") {
      right.push(raw.slice(1));
      modAt.push(newNo++);
    } else if (lead === "-") {
      left.push(raw.slice(1));
      origAt.push(oldNo++);
    } else {
      const body = lead === " " ? raw.slice(1) : raw;
      left.push(body);
      origAt.push(oldNo++);
      right.push(body);
      modAt.push(newNo++);
    }
  }
  return {
    original: left.join("\n"),
    modified: right.join("\n"),
    oneSided: left.length === 0 || right.length === 0,
    origAt,
    modAt,
  };
}

/** Which tree a changed piece's recorded line numbers describe. A deleted
 *  piece only exists in the old tree; everything else was recorded against the
 *  new one. */
export function recordedTree(change: string): DiffSideKind {
  return change === "deleted" ? "original" : "modified";
}

/** Where one changed piece lives, in the REAL line numbers of that side's file
 *  — old-file lines for "original", new-file lines for "modified".
 *
 *  `source` says how we know: `lines` means the change-note's own recorded
 *  numbers, `search` means we found the declaration by name because the
 *  recorded numbers describe the other tree. */
/** Locate a changed piece on one side of the diff. Returns null when the piece
 *  simply isn't visible there — a diff shows changed lines plus a little
 *  context, so a piece whose body was trimmed away has nothing to point at, and
 *  saying so beats highlighting a neighbour. */
export function symbolSpan(
  sides: DiffSides,
  symbol: ChangedSymbol,
  side: DiffSideKind,
): SymbolSpan | null {
  const at = side === "original" ? sides.origAt : sides.modAt;
  if (recordedTree(symbol.change) === side) {
    const kept = clampToDiff(at, symbol.start_line, symbol.end_line);
    // Narrowed to what the diff actually shows: a piece whose body runs past
    // the last context line ends where the reader can still see it.
    if (kept) {
      return { side, startLine: at[kept.start], endLine: at[kept.end], source: "lines" };
    }
  }
  // Either the recorded numbers belong to the other tree (a modified piece
  // shown on the "previous" side) or the diff trimmed them away. Find the
  // declaration by name instead.
  const text = side === "original" ? sides.original : sides.modified;
  const found = declarationRange(text.split("\n"), symbol.identifier);
  if (!found) return null;
  return {
    side,
    startLine: at[found.start] ?? found.start + 1,
    endLine: at[found.end] ?? found.end + 1,
    source: "search",
  };
}

/** The same span, expressed in the materialized buffer's own line numbers —
 *  what Monaco needs, since its models are the buffers we built, not the files.
 *  Both bounds are 1-based and inclusive. */
export function materializedSpan(
  sides: DiffSides,
  span: SymbolSpan,
): { startLine: number; endLine: number } | null {
  const at = span.side === "original" ? sides.origAt : sides.modAt;
  const found = clampToDiff(at, span.startLine, span.endLine);
  return found ? { startLine: found.start + 1, endLine: found.end + 1 } : null;
}

/** Narrow a real-line range to the part of it the diff actually kept, as
 *  indices into `at`. `at` is ascending by construction, so the scan can stop
 *  as soon as it passes the end. */
function clampToDiff(
  at: number[],
  start?: number | null,
  end?: number | null,
): { start: number; end: number } | null {
  if (!start || start < 1) return null;
  const last = end && end >= start ? end : start;
  let first = -1;
  let final = -1;
  for (let i = 0; i < at.length; i++) {
    const n = at[i];
    if (n < start) continue;
    if (n > last) break;
    if (first < 0) first = i;
    final = i;
  }
  return first < 0 ? null : { start: first, end: final };
}

/** Words that mark a line as the place a thing is DECLARED rather than one of
 *  the places it is used. Deliberately cross-language — this runs over whatever
 *  file the reader opened, not a parsed tree. */
const DECLARES =
  /\b(fn|func|function|class|struct|enum|trait|impl|interface|type|const|let|var|def|export|pub|module|mod|record|object)\b/;

/** A line that is nothing but a block closer belongs to the block above it. */
const CLOSER = /^[)}\]]+[;,)]*$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Leading whitespace width, counting a tab as four columns so a mixed file
 *  still nests correctly. */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** Find where a named piece is declared, as 0-based indices into `lines`.
 *  Prefers a line that also carries a declaring keyword, so a call site earlier
 *  in the diff doesn't win over the definition below it. */
function declarationRange(
  lines: string[],
  identifier: string,
): { start: number; end: number } | null {
  const name = identifier.trim();
  if (!name) return null;
  const word = new RegExp(`(^|[^\\w$])${escapeRe(name)}([^\\w$]|$)`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!word.test(lines[i])) continue;
    if (start < 0) start = i;
    if (DECLARES.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  return { start, end: blockEnd(lines, start) };
}

/** How far the declared block runs, by indentation: everything indented deeper
 *  than the declaration belongs to it, and a closing brace back at the
 *  declaration's own indent is its last line. Blank lines never end a block. */
function blockEnd(lines: string[], start: number): number {
  const base = indentOf(lines[start]);
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    if (ind > base) {
      end = i;
      continue;
    }
    if (ind === base && CLOSER.test(line.trim())) end = i;
    break;
  }
  return end;
}
