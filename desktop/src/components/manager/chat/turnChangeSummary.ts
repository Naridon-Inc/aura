//! Per-round file-change summary, derived from a settled turn's tool calls.
//!
//! Antigravity (and Conductor) close each agent round with a small block at the
//! bottom — "1 file changed · +30 −2" with a way to review what moved. We have
//! every datum for that already: a settled turn persists its tool calls
//! (`ChatTurn.tool_calls`), and the edit/write/multiedit/apply_patch ones carry
//! the file path plus the before/after content straight in their input. This
//! module folds those tool blocks into one deterministic per-file tally — no
//! backend round-trip, no git stat, no faked numbers. A turn that only read /
//! searched / ran commands produces `null` (nothing changed, no block).
//!
//! The counts are a cheap shared-prefix/suffix line delta (the same heuristic
//! `FileDiffTool` shows in its header chip), not a Myers diff — good enough for
//! a glance-level "+/−" and identical to what the inline diff card reports, so
//! the block and the expanded diff never disagree.

import type { StreamBlock } from "./types";

type ToolBlock = Extract<StreamBlock, { kind: "tool" }>;

/** One file touched during a turn, with its aggregated line delta. `block` is
 *  the representative edit/write tool call when one can render an inline
 *  before/after diff (so the expanded review reuses `FileDiffTool`); absent for
 *  multiedit / apply_patch tallies that have no single old/new pair to show. */
export type TurnFileChange = {
  path: string;
  added: number;
  removed: number;
  kind: "new" | "modified";
  block?: ToolBlock;
};

/** A turn's whole-round change tally — per-file rows plus the rolled-up totals
 *  the collapsed block shows. */
export type TurnChangeSummary = {
  files: TurnFileChange[];
  filesChanged: number;
  added: number;
  removed: number;
};

/** Lowercased, separator-stripped tool name — `edit_file` / `EditFile` /
 *  `edit` all collapse to one key (mirrors `FileDiffTool.normalizeName`). */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

function asRecord(input: unknown): Record<string, unknown> {
  return (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
}

/** Lines in a body, counting a final newline as a terminator not a new line —
 *  so a 3-line file with a trailing `\n` reports 3, not 4. */
function lineCount(body: string): number {
  if (body.length === 0) return 0;
  const n = body.split("\n").length;
  return body.endsWith("\n") ? n - 1 : n;
}

/** Cheap +/- line delta — shared-prefix/suffix walk, the same heuristic
 *  `FileDiffTool.quickLineDelta` uses for its header chip so the block's totals
 *  match the inline diff's exactly. */
function lineDelta(a: string, b: string): { added: number; removed: number } {
  if (a === b) return { added: 0, removed: 0 };
  const la = a.split("\n");
  const lb = b.split("\n");
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  let ja = la.length - 1;
  let jb = lb.length - 1;
  while (ja >= i && jb >= i && la[ja] === lb[jb]) {
    ja--;
    jb--;
  }
  return { removed: Math.max(0, ja - i + 1), added: Math.max(0, jb - i + 1) };
}

/** Count +/- lines in a unified or `*** Update File` patch body, ignoring the
 *  `+++`/`---` file markers, `@@` hunk heads, and `***` patch sentinels. */
function patchDelta(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/** Pull the changed file path out of a patch header when the tool input itself
 *  didn't carry one — handles both `+++ b/<path>` (unified) and
 *  `*** Update File: <path>` (apply_patch). Returns "" when none is found. */
function pathFromPatch(patch: string): string {
  for (const line of patch.split("\n")) {
    const upd = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (upd) return upd[1].trim();
    const plus = line.match(/^\+\+\+ b\/(.+)$/);
    if (plus) return plus[1].trim();
  }
  return "";
}

/** One tool call → the file edits it represents (usually one, but a multiedit
 *  spreads several edits over a single path). Non-mutating tools return []. */
function opsForTool(block: ToolBlock): TurnFileChange[] {
  const key = normalizeName(block.name);
  const obj = asRecord(block.input);
  const path = String(obj.file_path ?? obj.path ?? "");

  if (key === "write" || key === "writefile") {
    const raw = obj.content ?? obj.contents;
    if (raw === undefined) return [];
    const content = String(raw);
    return [{ path, added: lineCount(content), removed: 0, kind: "new", block }];
  }

  if (key === "edit" || key === "editfile") {
    const oldStr = obj.old_string ?? obj.oldText ?? obj.old;
    const newStr = obj.new_string ?? obj.newText ?? obj.new;
    if (oldStr === undefined && newStr === undefined) return [];
    const { added, removed } = lineDelta(
      oldStr === undefined ? "" : String(oldStr),
      newStr === undefined ? "" : String(newStr),
    );
    return [{ path, added, removed, kind: "modified", block }];
  }

  if (key === "multiedit" || key === "multieditfile") {
    const edits = Array.isArray(obj.edits) ? obj.edits : [];
    let added = 0;
    let removed = 0;
    for (const e of edits) {
      const er = asRecord(e);
      const d = lineDelta(
        String(er.old_string ?? er.oldText ?? er.old ?? ""),
        String(er.new_string ?? er.newText ?? er.new ?? ""),
      );
      added += d.added;
      removed += d.removed;
    }
    if (added === 0 && removed === 0) return [];
    return [{ path, added, removed, kind: "modified" }];
  }

  if (key === "applypatch" || key === "patch") {
    const raw = obj.patch ?? obj.input ?? obj.diff;
    if (typeof raw !== "string" || raw.length === 0) return [];
    const { added, removed } = patchDelta(raw);
    if (added === 0 && removed === 0) return [];
    return [
      { path: path || pathFromPatch(raw), added, removed, kind: "modified" },
    ];
  }

  return [];
}

/** Fold a settled turn's blocks into a per-round change summary, or `null` when
 *  nothing was written this turn (so the caller renders no block). The same
 *  path touched by several tool calls is merged: deltas sum, and the row stays
 *  "new" only while every op on it was a fresh write. */
export function extractTurnChanges(blocks: StreamBlock[]): TurnChangeSummary | null {
  const byPath = new Map<string, TurnFileChange & { everEdited: boolean }>();

  for (const b of blocks) {
    if (b.kind !== "tool") continue;
    for (const op of opsForTool(b)) {
      const pathKey = op.path || "(unknown file)";
      const existing = byPath.get(pathKey);
      if (!existing) {
        byPath.set(pathKey, {
          path: pathKey,
          added: op.added,
          removed: op.removed,
          kind: op.kind,
          block: op.block,
          everEdited: op.kind === "modified",
        });
        continue;
      }
      existing.added += op.added;
      existing.removed += op.removed;
      if (op.kind === "modified") existing.everEdited = true;
      // Prefer a renderable edit/write block for the inline-diff review.
      if (!existing.block && op.block) existing.block = op.block;
    }
  }

  if (byPath.size === 0) return null;

  const files: TurnFileChange[] = [...byPath.values()].map((f) => ({
    path: f.path,
    added: f.added,
    removed: f.removed,
    kind: f.everEdited ? "modified" : f.kind,
    block: f.block,
  }));

  // Nothing actually moved (e.g. a no-op edit) — no block.
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  if (added === 0 && removed === 0) return null;

  return { files, filesChanged: files.length, added, removed };
}
