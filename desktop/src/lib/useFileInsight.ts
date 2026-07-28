// Aura-aware metadata for the currently open file. Aggregates four
// streams the user otherwise has to chase across separate panels:
//   1. unified diff hunks (which lines moved)
//   2. semantic outline (which symbols exist) → cross-reference with
//      hunks to flag which functions/classes were touched
//   3. recent intent-log entries whose bound changeset touched this file
//      (or, for legacy rows without a changeset, whose text names it) → the
//      "why" behind the changes, in the user's own words
//   4. snapshot count for this file → how many times Aura has saved
//      a recoverable copy
//
// Polled lightly (8s) so the strip stays in sync with terminal-driven
// `aura snapshot` / `aura log-intent` invocations without flooding the
// CLI bridge.

import { useEffect, useMemo, useState } from "react";
import { api, type ChangeSummary, type IntentEntry, type OutlineNode } from "./api";
import { useDocumentVisibility } from "./useDocumentVisibility";

const POLL_MS = 8000;

export type TouchedSymbol = OutlineNode & { touched: boolean };

export type FileInsight = {
  loading: boolean;
  /** +/- line counts vs HEAD for the whole file. */
  additions: number;
  deletions: number;
  /** Plain-language, one-sentence "what changed" — AI-written when a model
   *  is reachable, deterministic otherwise. This is what leads the panel;
   *  `symbols` is demoted to a technical-detail toggle. null until loaded or
   *  when the file has no diff. */
  whatSummary: ChangeSummary | null;
  /** Outline nodes; ones whose start line falls inside a diff hunk
   *  (or are the closest enclosing symbol above one) are flagged. */
  symbols: TouchedSymbol[];
  /** Up to 5 recent intent entries attributed to this file — by their bound
   *  changeset's touched paths, or (legacy rows only) by name in the intent
   *  text. Most recent first. */
  relatedIntents: IntentEntry[];
  /** The single most-recent intent-log entry across the whole repo — the
   *  current session's stated reason, regardless of which file it touched.
   *  Used as the session-context fallback for "why it changed" when no note
   *  is bound to this specific file, so the panel is never a dead-end. */
  sessionIntent: IntentEntry | null;
  /** Total snapshot count for this file (file column equality on
   *  the current snapshot list). */
  snapshotCount: number;
  refresh: () => void;
};

const EMPTY: FileInsight = {
  loading: false,
  additions: 0,
  deletions: 0,
  whatSummary: null,
  symbols: [],
  relatedIntents: [],
  sessionIntent: null,
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
  const [sessionIntent, setSessionIntent] = useState<IntentEntry | null>(null);
  const [snapshotCount, setSnapshotCount] = useState<number>(0);
  const [whatSummary, setWhatSummary] = useState<ChangeSummary | null>(null);
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
          // Attribute a note to this file by its BOUND CHANGESET first: every
          // note records the exact paths it touched in `changeset.files[].path`,
          // so "why did this file change" no longer hinges on the free-text
          // intent happening to spell the filename (which was the norm, leaving
          // most files with "no notes mention this file"). When a changeset is
          // present it is authoritative — a note that touched this file shows
          // even if its prose never names it, and one that merely mentions the
          // name without touching it does not. Legacy rows written before
          // changeset binding shipped have no `changeset`; fall back to the old
          // text-substring match for those alone.
          const matches = page.entries.filter((e) => {
            const files = e.changeset?.files;
            if (files && files.length > 0) {
              return files.some(
                (f) => f.path === relPath || f.path.endsWith("/" + relPath!),
              );
            }
            return e.intent.includes(basename!) || e.intent.includes(relPath!);
          });
          setIntents(matches.slice(0, 5));
          // Session context: the newest entry overall (entries are
          // most-recent-first), used when nothing binds to this file so the
          // "why" panel can still show the session's stated reason.
          setSessionIntent(page.entries[0] ?? null);
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

  // Plain-language "what changed", computed from the diff by whichever model
  // the user has (deterministic fallback otherwise). Keyed on `diffText`, so
  // it only refires when the diff actually changes — an unchanged poll leaves
  // `diffText` string-equal and React skips the effect. The backend also
  // caches by diff content-hash, so repeats never hit a model twice.
  useEffect(() => {
    if (!repoRoot || !absPath || !diffText.trim()) {
      setWhatSummary(null);
      return;
    }
    let cancelled = false;
    api
      .summarizeFileChange(repoRoot, absPath)
      .then((s) => {
        if (!cancelled) setWhatSummary(s);
      })
      .catch(() => {
        // Never let a summary failure blank the panel — the deterministic
        // line-count copy in the strip covers this case.
        if (!cancelled) setWhatSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, absPath, diffText]);

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
    whatSummary,
    symbols,
    relatedIntents: intents,
    sessionIntent,
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
