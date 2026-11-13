import { useEffect, useState } from "react";
import { api, type FileChangeNote } from "../../../lib/api";
import { fetchChangeNoteReport, resolvePrRange } from "../../../lib/changeNoteCache";

// ── The pull request's change story ──────────────────────────────────

/** What a pull request did, per file, in words — the same account the Changes
 *  tab gives a commit, for the whole `base...head` range. */
export type PrChangeStory = {
  /** The resolved range spec, or null while probing / when unresolvable. It is
   *  what the per-piece explanations key on, so it has to be the real one. */
  range: string | null;
  /** Per-file change notes by path. Empty until the engine answers. */
  noteByPath: Map<string, FileChangeNote>;
  /** The head commit's time and author — whose change this is, and when. */
  when: number | null;
  author: string | null;
};

const EMPTY_STORY: PrChangeStory = {
  range: null,
  noteByPath: new Map(),
  when: null,
  author: null,
};

/** Read a pull request as one change: which pieces it adds, changes and
 *  removes in each file, so the Files tab can say what it MEANS rather than
 *  only what text moved.
 *
 *  The engine already does this for a commit. A pull request is the same
 *  question asked of a range, so it is the same call with a range spec — which
 *  this resolves first, because a PR carries branch names and only some of
 *  those exist on this machine. Everything degrades to null: an unresolvable
 *  range, a repo without the engine, a PR against an unfetched fork all leave
 *  the tab exactly as it was, showing the diff and claiming nothing. */
export function usePrChangeStory(
  repoRoot: string | null,
  baseRef: string | null,
  headRef: string | null,
): PrChangeStory {
  const [story, setStory] = useState<PrChangeStory>(EMPTY_STORY);
  useEffect(() => {
    setStory(EMPTY_STORY);
    if (!repoRoot || !baseRef || !headRef) return;
    let alive = true;
    void (async () => {
      const range = await resolvePrRange(repoRoot, baseRef, headRef);
      if (!alive || !range) return;
      // Start writing the words for EVERY file in this pull request now, while
      // the reader is still on the Overview tab — not one file at a time as
      // they click through the tree. Queues and returns; nothing awaits it.
      void api.prewarmChangeSummaries(repoRoot, range).catch(() => {});
      try {
        const report = await fetchChangeNoteReport(repoRoot, range);
        if (!alive) return;
        setStory({
          range,
          noteByPath: new Map(report.files.map((f) => [f.file, f])),
          when: report.commit_time ?? null,
          author: report.author?.trim() || null,
        });
      } catch {
        // No story for this PR — the diff below still stands on its own.
      }
    })();
    return () => {
      alive = false;
    };
  }, [repoRoot, baseRef, headRef]);
  return story;
}
