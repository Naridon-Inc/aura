// workingPieces — which pieces of a code file an uncommitted edit added,
// removed or reworked, read from the file's diff and its current outline.
//
// A commit's pieces come from the engine's syntax-tree delta (`aura
// change-note`), which needs two trees to compare. An edit still sitting in the
// working tree has only one tree and a diff, so this reads the same facts off
// those: a piece whose definition line is new is added, a piece whose span the
// diff touches is reworked, and a definition that only appears on removed lines
// and no longer exists in the outline was removed. The result has the same
// shape as the engine's, so the per-piece plain-language lines are asked for
// and cached exactly as they are for a commit.

import type { ChangedSymbol, OutlineNode } from "./api";

type DiffLines = {
  /** New-side line numbers of `+` lines. */
  added: Set<number>;
  /** Text of `+` lines. */
  addedText: string[];
  /** Each `-` line, with the new-side line it was removed in front of. */
  removed: { text: string; at: number }[];
};

function readDiff(diff: string): DiffLines {
  const out: DiffLines = { added: new Set(), addedText: [], removed: [] };
  let next = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      next = parseInt(h[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      out.added.add(next);
      out.addedText.push(line.slice(1));
      next++;
    } else if (line.startsWith("-")) {
      out.removed.push({ text: line.slice(1), at: next });
    } else if (line.startsWith(" ") || line === "") {
      next++;
    } else {
      inHunk = false; // the next file's header
    }
  }
  return out;
}

const DEF =
  /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|function\*?|def|class|struct|enum|trait|interface|type|impl)\s+([A-Za-z_$][\w$]*)/;
const ARROW =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;

/** The name and kind a line defines, if it opens a definition. */
function definedOn(text: string): { name: string; kind: string } | null {
  const d = text.match(DEF);
  if (d) {
    const kw = d[1].replace("*", "");
    return { name: d[2], kind: kw === "function" || kw === "def" ? "fn" : kw };
  }
  const a = text.match(ARROW);
  return a ? { name: a[1], kind: "fn" } : null;
}

/** The pieces this edit touched, in file order, with removed pieces last. */
export function workingPieces(diff: string, outline: OutlineNode[]): ChangedSymbol[] {
  if (!diff.trim()) return [];
  const lines = readDiff(diff);
  const nodes = [...outline].sort((a, b) => a.line - b.line);
  const spanEnd = (i: number) => (i + 1 < nodes.length ? nodes[i + 1].line - 1 : Infinity);
  const nodeAt = (line: number): number => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].line <= line) return line <= spanEnd(i) ? i : -1;
    }
    return -1;
  };

  const touched = new Set<number>();
  for (const n of lines.added) {
    const i = nodeAt(n);
    if (i >= 0) touched.add(i);
  }
  for (const r of lines.removed) {
    const i = nodeAt(Math.max(r.at - 1, 1));
    if (i >= 0) touched.add(i);
  }

  const removedDefs = lines.removed.map((r) => definedOn(r.text)).filter((d) => d !== null);
  const removedNames = new Set(removedDefs.map((d) => d.name));
  const present = new Set(nodes.map((n) => n.name));

  const out: ChangedSymbol[] = [...touched]
    .sort((a, b) => a - b)
    .map((i) => {
      const n = nodes[i];
      const isNew = lines.added.has(n.line) && !removedNames.has(n.name);
      const end = spanEnd(i);
      return {
        identifier: n.name,
        kind: n.kind,
        change: isNew ? "added" : "modified",
        start_line: n.line,
        end_line: Number.isFinite(end) ? end : null,
      };
    });

  const gone = new Set<string>();
  for (const d of removedDefs) {
    if (present.has(d.name) || gone.has(d.name)) continue;
    gone.add(d.name);
    out.push({ identifier: d.name, kind: d.kind, change: "deleted", start_line: null, end_line: null });
  }
  return out;
}
