// Aura-aware metadata for the currently open file. Aggregates four
// streams the user otherwise has to chase across separate panels:
//   1. unified diff hunks (which lines moved)
//   2. semantic outline (which symbols exist) → cross-reference with
//      hunks to flag which functions/classes were touched
//   3. recent intent-log entries that mention this file by name → the
//      "why" behind the changes, in the user's own words
//   4. snapshot count for this file → how many times Aura has saved
//      a recoverable copy
//
// Polled lightly (8s) so the strip stays in sync with terminal-driven
// `aura snapshot` / `aura log-intent` invocations without flooding the
// CLI bridge.

import { useEffect, useMemo, useState } from "react";
import { api, type IntentEntry, type OutlineNode } from "./api";
import { useDocumentVisibility } from "./useDocumentVisibility";

const POLL_MS = 8000;

export type TouchedSymbol = OutlineNode & { touched: boolean };

export type FileInsight = {
  loading: boolean;
  /** +/- line counts vs HEAD for the whole file. */
  additions: number;
  deletions: number;
  /** Outline nodes; ones whose start line falls inside a diff hunk
   *  (or are the closest enclosing symbol above one) are flagged. */
  symbols: TouchedSymbol[];
  /** Up to 5 recent intent entries that mention the file by basename
   *  or relative path. Most recent first. */
  relatedIntents: IntentEntry[];
  /** Total snapshot count for this file (file column equality on
   *  the current snapshot list). */
  snapshotCount: number;
  refresh: () => void;
};

const EMPTY: FileInsight = {
  loading: false,
  additions: 0,
  deletions: 0,
  symbols: [],
  relatedIntents: [],
  snapshotCount: 0,
  refresh: () => {},
};

export function useFileInsight(
  repoRoot: string | null | undefined,
  absPath: string | null | undefined,
): FileInsight {
  const [loading, setLoading] = useState<boolean>(!!absPath);
  const [diffText, setDiffText] = useState<string>("");
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [intents, setIntents] = useState<IntentEntry[]>([]);
  const [snapshotCount, setSnapshotCount] = useState<number>(0);
  const visible = useDocumentVisibility();

  const relPath = useMemo(() => {
    if (!repoRoot || !absPath) return null;
    if (absPath.startsWith(repoRoot + "/")) return absPath.slice(repoRoot.length + 1);
    return absPath;
  }, [repoRoot, absPath]);

  const basename = useMemo(() => {
    if (!relPath) return null;
    return relPath.split("/").pop() ?? relPath;
  }, [relPath]);

  useEffect(() => {
    if (!repoRoot || !absPath || !relPath) return;
    let cancelled = false;
    async function tick() {
      setLoading(true);
      try {
        const [diff, out, page, snaps] = await Promise.all([
          api.gitDiff(repoRoot!, relPath!).catch(() => ""),
          api.auraSemanticOutline(repoRoot!, absPath!).catch(() => [] as OutlineNode[]),
          api.auraReadIntentLogV2(repoRoot!, 50).catch(() => null),
          api.auraListSnapshots(repoRoot!).catch(() => []),
        ]);
        if (cancelled) return;
        setDiffText(diff);
        setOutline(out);
        if (page) {
          const matches = page.entries.filter((e) =>
            e.intent.includes(basename!) || e.intent.includes(relPath!),
          );
          setIntents(matches.slice(0, 5));
        }
        // Snapshots don't always store an absolute path — match by
        // suffix so both `~/.aura/snapshots/<sha>/<rel>` and bare
        // relative-path forms count.
        const count = snaps.filter(
          (s) => s.file === absPath || s.file.endsWith("/" + relPath!),
        ).length;
        setSnapshotCount(count);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void tick();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, absPath, relPath, basename, visible]);

  // Parse diff into per-hunk new-side ranges. Header looks like:
  //   @@ -<oldStart>,<oldLen> +<newStart>,<newLen> @@ <ctx>
  const hunks = useMemo(() => parseHunks(diffText), [diffText]);

  // Aggregate per-file +/-: count "+"/"-" lines (skip header lines
  // that begin with "+++" / "---").
  const { additions, deletions } = useMemo(() => {
    let a = 0;
    let d = 0;
    for (const line of diffText.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) a++;
      else if (line.startsWith("-")) d++;
    }
    return { additions: a, deletions: d };
  }, [diffText]);

  // Tag each outline node as touched if any hunk range overlaps its
  // declared start line OR if it's the closest symbol above a hunk
  // start (so a small inline edit inside a function still flags the
  // function as the touched symbol).
  const symbols: TouchedSymbol[] = useMemo(() => {
    if (outline.length === 0) return [];
    const sorted = [...outline].sort((a, b) => a.line - b.line);
    const touched = new Set<number>();
    for (const h of hunks) {
      const hStart = h.newStart;
      const hEnd = h.newStart + Math.max(h.newLen - 1, 0);
      // Direct containment: the hunk range straddles a symbol's start.
      let last = -1;
      for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        if (s.line >= hStart && s.line <= hEnd) {
          touched.add(i);
        }
        if (s.line <= hStart) last = i;
      }
      // Enclosing symbol: nearest symbol above the hunk start.
      if (last >= 0) touched.add(last);
    }
    return sorted.map((n, i) => ({ ...n, touched: touched.has(i) }));
  }, [outline, hunks]);

  return {
    loading,
    additions,
    deletions,
    symbols,
    relatedIntents: intents,
    snapshotCount,
    refresh: () => {
      // Toggling absPath via a state key is overkill — consumers
      // re-mount on path change, and the 8s poll covers everything else.
    },
  };
}

type Hunk = { oldStart: number; oldLen: number; newStart: number; newLen: number };

function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("@@")) continue;
    const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    out.push({
      oldStart: parseInt(m[1], 10),
      oldLen: m[2] ? parseInt(m[2], 10) : 1,
      newStart: parseInt(m[3], 10),
      newLen: m[4] ? parseInt(m[4], 10) : 1,
    });
  }
  return out;
}

// Re-export for the compat helper that EMPTY uses.
export const EMPTY_FILE_INSIGHT = EMPTY;
