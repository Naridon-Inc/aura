// SplitDiffHeader — the "why this changed" header over a change's diff, in a
// session's Changes tab and a pull request's Files tab.
//
// It mirrors the diff below it:
//   1. a summary across the full width — one plain sentence Aura composes from
//      the real changed pieces, what the file used to do and does now, why it
//      changed (and whose account that is), then when, where and by whom.
//   2. two lists aligned to the split panes: "Previous was this" over the old
//      side, "New is this" over the new one. They stack when the diff folds to
//      one inline column.
//
// MEANING-FIRST: every piece leads with what it means (the Code Atlas summary,
// or a plain "what kind of thing changed, and how" line from the AST facts),
// with the raw identifier on a quiet mechanism line beneath it.
//
// HONESTY: every word is grounded in the `aura change-note <sha> --json`
// payload (AST diff + call graph) and the commit's own facts. A fact with no
// real source is left out, not guessed. The full old/new text is the diff
// below; this header is the index over it, height-capped so it never starves
// the diff of room.
//
// The pieces: `changeNote/changeWords` (the wording), `changeNote/ChangeSides`
// (the two lists) and `changeNote/useChangeStory` (what it reads).

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { FileChangeNote } from "../../lib/api";
import { explanationFailed, isInferredFromDiff, whyIsRecorded } from "../../lib/changeExplain";
import { relativeAgeAuto } from "../../lib/relativeTime";
import { Button } from "../ui/button";
import { ChangeSide } from "./changeNote/ChangeSides";
import { absTime, plainSummary, whereParts } from "./changeNote/changeWords";
import {
  useAtlasIndex,
  useChangeExplanation,
  usePiecePick,
  useSymbolMeanings,
  type FocusPick,
} from "./changeNote/useChangeStory";
import "../ui/change-note.css";

export type { FocusPick };

/** Below this body width the two side-by-side columns stop being readable and
 *  the diff folds its split into one inline column — so the header's
 *  Previous/New pair has to stack to keep saying the truth about what's beside
 *  what. Every surface that mounts the header measures against this number. */
export const SPLIT_INLINE_PX = 700;

/** Tracks whether a diff body is too narrow for side-by-side columns, so a
 *  caller can hand `stacked` to SplitDiffHeader. Returns the ref to put on the
 *  measured element. */
export function useStackedDiff(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setNarrow(e.contentRect.width < SPLIT_INLINE_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, narrow];
}

type SplitDiffHeaderProps = {
  note: FileChangeNote;
  /** When this change landed (commit time, unix seconds). Omitted → no "when". */
  when?: number | null;
  /** Who made it (commit author). Omitted → no "by …". */
  author?: string | null;
  repoRoot: string;
  /** The commit this diff belongs to. Scopes the generated used-to / now / why
   *  to that exact change; omitted → the live working-tree edit. */
  commit?: string | null;
  /** The diff has folded to one inline column: stack the two lists. */
  stacked: boolean;
  /** When set, each restorable piece offers "Bring this back" — surgical undo
   *  right where you see what changed. Omitted on read-only views. */
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
  /** Told which piece the reader picked, so the diff below can highlight it and
   *  caption those lines with the same words. Must be referentially stable — it
   *  is an effect dependency. Omit on a surface with no diff underneath. */
  onFocusPiece?: (pick: FocusPick | null) => void;
};

export function SplitDiffHeader({
  note,
  when,
  author,
  repoRoot,
  commit,
  stacked,
  onBringBack,
  busySymbol,
  onFocusPiece,
}: SplitDiffHeaderProps) {
  const index = useAtlasIndex(repoRoot);
  const [exp, retryExplanation] = useChangeExplanation(repoRoot, note.file, commit);
  const meanings = useSymbolMeanings(repoRoot, note, commit);
  const [pick, choose] = usePiecePick({ note, commit, index, meanings, exp, onFocusPiece });
  // Fold the pieces away so a reader can give the diff its full height.
  const [open, setOpen] = useState(true);

  // A modified piece is on BOTH sides: it was here before and is here after.
  const previous = note.symbols.filter((s) => s.change === "deleted" || s.change === "modified");
  const next = note.symbols.filter((s) => s.change === "added" || s.change === "modified");

  const pieceCount = note.symbols.length;
  const summary = plainSummary(note.symbols, note.note);
  const where = whereParts(note.file);

  const before = exp?.before?.trim() || "";
  const nowDoes = exp?.what?.trim() || "";
  // A brand-new file has no "before" to show.
  const hasBefore = before.length > 0 && note.symbols.some((s) => s.change !== "added");
  // A lone changed piece already shows the same words inline in its list when
  // the pieces are open, so the file-level pair only appears when it isn't a
  // repeat: several pieces changed, or the pieces are folded away.
  const showPair = (hasBefore || nowDoes.length > 0) && (pieceCount !== 1 || !open);

  // WHY, and whose account it is. `aura snapshot-file --why` records the
  // author's own words against a file, and those are quoted verbatim; anything
  // else is Aura's reading of the diff and is marked as such. With no words at
  // all there is no why line.
  const why = exp?.why?.trim() || "";
  const whyRecorded = whyIsRecorded(exp);
  const whyAuthor = (exp?.why_author ?? "").trim();
  const failed = explanationFailed(exp);

  return (
    <section className="ui-change-note" aria-label="What changed in this file">
      <div className="ui-change-note-summary">
        <div className="ui-change-note-head">
          <p>{summary}</p>
          {pieceCount > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              title={open ? "Hide the list of changed pieces" : "Show what changed, in plain words"}
            >
              {open ? "Hide pieces" : `Show ${pieceCount} ${pieceCount === 1 ? "piece" : "pieces"}`}
            </Button>
          ) : null}
        </div>

        {showPair ? (
          hasBefore ? (
            <dl className="ui-change-note-pair" data-stacked={stacked || undefined}>
              <div>
                <dt>Used to</dt>
                <dd>{before}</dd>
              </div>
              {nowDoes ? (
                <div>
                  <dt>Now</dt>
                  <dd data-now="">{nowDoes}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <dl className="ui-change-note-pair" data-stacked="">
              <div>
                <dt>What this adds</dt>
                <dd data-now="">{nowDoes}</dd>
              </div>
            </dl>
          )
        ) : null}

        {why ? (
          <p className="ui-change-note-why">
            <span className="ui-change-note-label">{whyRecorded ? "Why · " : "Why & how · "}</span>
            {why}
            <small
              title={
                whyRecorded
                  ? "The person or agent who made this change wrote this reason down against this file."
                  : isInferredFromDiff(exp)
                    ? "Nobody recorded a reason, and no model was reachable, so Aura worked this out from the change itself."
                    : "Nobody recorded a reason, so Aura worked this out by reading the change itself."
              }
            >
              {whyRecorded ? (whyAuthor ? `stated by ${whyAuthor}` : "stated") : "Aura's reading"}
            </small>
          </p>
        ) : null}

        {failed ? (
          <p className="ui-change-note-failed">
            <span>Aura couldn&apos;t write an account of this change.</span>
            <Button variant="link" size="xs" onClick={retryExplanation}>
              Try again
            </Button>
          </p>
        ) : null}

        <p className="ui-change-note-facts">
          {when != null ? <span title={absTime(when)}>{relativeAgeAuto(when)}</span> : null}
          <span className="ui-change-note-where" title={note.file}>
            {where.folder ? <span>{where.folder}</span> : null}
            {where.base}
          </span>
          {author ? <span title="Who made this change">by {author}</span> : null}
        </p>
      </div>

      {open ? (
        <div className="ui-change-note-sides" data-stacked={stacked || undefined}>
          <ChangeSide
            label="Previous was this"
            symbols={previous}
            showSignature={false}
            emptyNote="New file. Nothing was here before."
            index={index}
            filePath={note.file}
            side="previous"
            relFile={note.file}
            sideLine={before}
            symbolMeanings={meanings.before}
            onBringBack={onBringBack}
            busySymbol={busySymbol}
            selectedIdentifier={pick?.side === "previous" ? pick.identifier : null}
            onSelect={onFocusPiece ? choose("previous") : undefined}
          />
          <ChangeSide
            label="New is this"
            symbols={next}
            showSignature
            emptyNote="File removed. Nothing is here now."
            index={index}
            filePath={note.file}
            side="next"
            relFile={note.file}
            sideLine={nowDoes}
            symbolMeanings={meanings.now}
            onBringBack={onBringBack}
            busySymbol={busySymbol}
            selectedIdentifier={pick?.side === "next" ? pick.identifier : null}
            onSelect={onFocusPiece ? choose("next") : undefined}
          />
        </div>
      ) : null}
    </section>
  );
}
