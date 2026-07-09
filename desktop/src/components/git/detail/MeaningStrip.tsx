// MeaningStrip — the "in real-world terms, this version touched…" band in the
// History detail. It takes the functions this commit changed (from the
// deterministic change-note) and looks each one up in the Code Atlas — the
// plain-English directory of what every symbol MEANS to a person, not what it
// does in code. So a non-engineer reads "this changed Sign In and Send
// Message", not a wall of identifiers.
//
// HONEST SCOPE (V1): the Code Atlas carries ONE rolling meaning per symbol —
// its meaning as of the last `aura atlas` regen — not a snapshot taken at each
// commit. So this strip is "what these functions mean (today)", a single
// baseline, NOT a true per-commit meaning diff ("what they meant at the time of
// this commit vs. now"). We label it as such and never imply otherwise.
// Per-commit meaning snapshots are a later iteration; this V1 still gives the
// non-engineer the real-world read of which features a version moved.

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { type AtlasHoverEntry } from "../../../lib/api";
import { fetchChangeNoteReport } from "../../../lib/changeNoteCache";
import {
  loadAtlasIndex,
  lookupEntry,
  type AtlasIndex,
} from "../../../lib/atlasHover";

/** One resolved meaning: the atlas entry plus the file it changed in (so the
 *  same-name disambiguation in `lookupEntry` can prefer the right definition). */
export type Meaning = {
  entry: AtlasHoverEntry;
  file: string;
};

/** Walk the commit's changed symbols and resolve each to its atlas meaning,
 *  de-duped by atlas key so a symbol touched in two ways shows once. */
function resolveMeanings(
  index: AtlasIndex,
  files: { file: string; symbols: { identifier: string }[] }[],
): Meaning[] {
  if (!index.available) return [];
  const seen = new Set<string>();
  const out: Meaning[] = [];
  for (const f of files) {
    for (const s of f.symbols) {
      const entry = lookupEntry(index, s.identifier, f.file);
      if (!entry || seen.has(entry.key)) continue;
      seen.add(entry.key);
      out.push({ entry, file: f.file });
    }
  }
  // Lead with features (what people DO), then components, then atoms — the most
  // human-meaningful first.
  const rank: Record<string, number> = { feature: 0, component: 1, atom: 2 };
  out.sort((a, b) => (rank[a.entry.role] ?? 3) - (rank[b.entry.role] ?? 3));
  return out;
}

/** Resolve a commit's changed symbols to their atlas meanings. Returns an empty
 *  list (never throws) when the atlas is missing or nothing matched — the
 *  caller uses `meanings.length` to decide whether to show the strip at all, so
 *  it can hide an enclosing section header rather than render an empty band. */
export function useCommitMeanings(
  repoRoot: string,
  sha: string,
): { meanings: Meaning[]; ready: boolean } {
  const [meanings, setMeanings] = useState<Meaning[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    setReady(false);
    setMeanings([]);
    Promise.all([
      fetchChangeNoteReport(repoRoot, sha),
      loadAtlasIndex(repoRoot),
    ])
      .then(([report, index]) => {
        if (!alive) return;
        setMeanings(resolveMeanings(index, report.files));
        setReady(true);
      })
      .catch(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, sha]);

  return { meanings, ready };
}

export function MeaningStrip({ meanings }: { meanings: Meaning[] }) {
  if (meanings.length === 0) return null;

  const shown = meanings.slice(0, 8);
  const extra = meanings.length - shown.length;

  return (
    <div className="rounded-lg border border-line-soft bg-bg-1/40 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-text-4">
        <Sparkles size={12} className="text-accent" />
        What these functions mean
      </div>
      {/* The honest caveat, in the UI itself: this is today's meaning of the
          functions this version touched, a single baseline — not a snapshot of
          what they meant at the moment of this commit. */}
      <p className="mt-1 text-[11px] leading-relaxed text-text-4">
        In plain terms, this version touched the parts of the app below. This is
        what they mean today.
      </p>
      <div className="mt-2.5 space-y-2">
        {shown.map((m) => (
          <div key={m.entry.key} className="flex items-start gap-2.5">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: "var(--color-accent)" }}
              aria-hidden
            />
            <div className="min-w-0">
              <span className="text-[12.5px] font-medium text-text-1">
                {m.entry.title}
              </span>
              {m.entry.summary.trim() ? (
                <span className="text-[12px] text-text-3">
                  {" "}
                  — {m.entry.summary.trim()}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {extra > 0 ? (
        <div className="mt-2 text-[11px] text-text-4">
          + {extra} more part{extra === 1 ? "" : "s"} of the app.
        </div>
      ) : null}
    </div>
  );
}
