// The proof trail's commit rail: one pin per commit, newest first, each with
// its evidence glyph, short sha, date and a stripe that groups commits sharing
// a change id. Pins tell the page when they scroll into view, which is when a
// commit's evidence is read off disk.

import { useEffect, useRef } from "react";
import { type CommitEntry } from "../../../lib/api";
import { shortDateFromSecs } from "../../../lib/calendarDate";
import { IntentMatchChip } from "../../IntentMatchChip";
import { TraceStatusGlyph } from "../../ui/trace-report";
import { EMPTY, statusHint, statusTone, type ManifestRecord } from "./proofManifest";

// Stable colour per change_id so the stripe under each pin reads as "this
// group of commits is one logical change". Hash → hue so adjacent groups stay
// distinct. The colour is an identity, not a status, which is why it is the
// one place on the page that isn't a token.
function colorFor(cid: string | undefined): string {
  if (!cid) return "transparent";
  let h = 0;
  for (let i = 0; i < cid.length; i++) {
    h = (h * 31 + cid.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 60% 55%)`;
}

export function ProofRail({
  commits,
  manifests,
  changeIds,
  selected,
  onSelect,
  onPinVisible,
  repoRoot,
}: {
  commits: CommitEntry[];
  manifests: Record<string, ManifestRecord>;
  changeIds: Record<string, string>;
  selected: string | null;
  onSelect: (sha: string) => void;
  /** Called the first time a pin scrolls into the rail — the cue to read
   *  that commit's manifest off disk instead of probing all of them up front. */
  onPinVisible: (sha: string) => void;
  repoRoot: string;
}) {
  const listRef = useRef<HTMLOListElement | null>(null);
  // Held in a ref so re-renders (which happen on every arriving manifest)
  // don't tear down and rebuild the observer.
  const notifyRef = useRef(onPinVisible);
  notifyRef.current = onPinVisible;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const sha = (e.target as HTMLElement).dataset.sha;
          if (sha) notifyRef.current(sha);
        }
      },
      {
        // The rail is the horizontally scrolling parent. A generous margin
        // warms the pins just off either edge so scrubbing never waits.
        root: list.parentElement,
        rootMargin: "0px 400px",
      },
    );
    for (const li of Array.from(list.children)) io.observe(li);
    return () => io.disconnect();
  }, [commits]);

  return (
    <ol ref={listRef} className="ui-proof-pins" aria-label="Commits, newest first">
      {commits.map((c) => {
        const m = manifests[c.sha] ?? EMPTY;
        const cid = changeIds[c.sha];
        return (
          <li key={c.sha} data-sha={c.sha}>
            <button
              type="button"
              className="ui-proof-pin"
              data-active={selected === c.sha || undefined}
              aria-pressed={selected === c.sha}
              onClick={() => onSelect(c.sha)}
              title={`${c.sha.slice(0, 8)} · ${c.subject} · ${statusHint(m.status)}${
                cid ? ` · change ${cid}` : ""
              }`}
            >
              <TraceStatusGlyph tone={statusTone(m.status)} />
              <span className="ui-proof-pin-sha">
                <IntentMatchChip repoRoot={repoRoot} sha={c.sha} />
                {c.sha.slice(0, 7)}
              </span>
              <span className="ui-proof-pin-date">
                {shortDateFromSecs(c.timestamp, { empty: "—" })}
              </span>
              <span
                className="ui-proof-pin-stripe"
                style={{ background: colorFor(cid) }}
                title={cid ? `change ${cid}` : "no change id"}
              />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
