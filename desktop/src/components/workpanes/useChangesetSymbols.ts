// useChangesetSymbols — collect the changed-symbol identifiers for a session's
// changeset, so the Summary prose can highlight function / type names (not just
// changed files). The engine already scopes `change-note` to top-level &
// exported symbols, so this is a tight, distinctive whitelist — body-locals
// (loop vars, temporaries) never leak in to light up English words.
//
// Best-effort by design: a commit whose change-note fails to resolve simply
// contributes no symbols. The reader never sees an error from this path — at
// worst a function name stays plain text.

import { useEffect, useMemo, useState } from "react";
import { fetchChangeNoteReport } from "../../lib/changeNoteCache";
import type { ChangedSymbol, IntentChangesetFile } from "../../lib/api";

export function useChangesetSymbols(
  repoRoot: string,
  files: IntentChangesetFile[],
): string[] {
  // Distinct commits in this changeset, as a stable string key so the effect
  // only refires when the actual set of commits changes (not on every render).
  const commitKey = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      if (f.commit) set.add(f.commit);
    }
    return [...set].sort().join(",");
  }, [files]);

  const [symbols, setSymbols] = useState<string[]>([]);

  useEffect(() => {
    const commits = commitKey ? commitKey.split(",") : [];
    if (!repoRoot || commits.length === 0) {
      setSymbols([]);
      return;
    }
    let alive = true;
    Promise.all(
      commits.map((c) => fetchChangeNoteReport(repoRoot, c).catch(() => null)),
    ).then((reports) => {
      if (!alive) return;
      const names = new Set<string>();
      for (const report of reports) {
        if (!report) continue;
        for (const file of report.files) {
          for (const s of file.symbols) {
            if (s.identifier) names.add(s.identifier);
          }
        }
      }
      setSymbols([...names]);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot, commitKey]);

  return symbols;
}

/** Changed symbols grouped by their (engine-reported, repo-relative) file —
 *  the shape the per-function Rewind menu needs, since a surgical rewind takes
 *  identifier AND file together and the flat `useChangesetSymbols` list drops
 *  the file context. Same best-effort change-note source: a file whose note
 *  fails to resolve simply maps to no symbols, and the caller offers it as a
 *  whole-file rewind instead. Keyed by the report's file path (repo-relative);
 *  callers match against the changeset's `path` by exact + basename fallback. */
export function useChangesetSymbolsByFile(
  repoRoot: string,
  files: IntentChangesetFile[],
): Record<string, ChangedSymbol[]> {
  const commitKey = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      if (f.commit) set.add(f.commit);
    }
    return [...set].sort().join(",");
  }, [files]);

  const [byFile, setByFile] = useState<Record<string, ChangedSymbol[]>>({});

  useEffect(() => {
    const commits = commitKey ? commitKey.split(",") : [];
    if (!repoRoot || commits.length === 0) {
      setByFile({});
      return;
    }
    let alive = true;
    Promise.all(
      commits.map((c) => fetchChangeNoteReport(repoRoot, c).catch(() => null)),
    ).then((reports) => {
      if (!alive) return;
      const map: Record<string, ChangedSymbol[]> = {};
      for (const report of reports) {
        if (!report) continue;
        for (const file of report.files) {
          const key = file.file;
          if (!key) continue;
          const bucket = map[key] ?? (map[key] = []);
          for (const s of file.symbols) {
            // A symbol can recur across commits in a multi-commit run; keep the
            // first sighting so the menu doesn't list `foo()` twice.
            if (s.identifier && !bucket.some((b) => b.identifier === s.identifier)) {
              bucket.push(s);
            }
          }
        }
      }
      setByFile(map);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot, commitKey]);

  return byFile;
}
