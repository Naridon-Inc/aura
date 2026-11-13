// One board lane: the shell every board surface in the app renders through,
// drawn as the task board's column (header with the stage's glyph, name, any
// lane buttons and its count; a stack of cards; an optional footer).
//
// Three behaviours live here rather than in each board:
//
//   • Drag-over. Only boards that pass `onDropCard` get a drop target; the
//     column shows where the card will go while you hold it over the lane. A
//     board whose lanes are derived from real state (you can't drag a working
//     agent into "Done") stays inert.
//   • Collapse. A lane folds to a narrow strip instead of hiding, so the
//     pipeline's shape survives while you focus on one stage. The strip's
//     name uses real vertical writing-mode, not a rotate transform, so text
//     metrics and truncation stay correct. Folded lanes unmount their cards.
//     `collapseWhenEmpty` applies the same fold automatically to a lane
//     holding nothing, for boards whose lanes are derived from state and must
//     all render.
//   • Empty + loading. An empty lane keeps its place and says, in plain words,
//     what would land there. Loading shows the library's loading line, and
//     the header holds back its count until there is one to show.

import { useState, type JSX, type ReactNode } from "react";
import { ChevronsLeftRight, ChevronsRightLeft } from "lucide-react";

import { Button } from "../ui/button";
import { LoadingState } from "../ui/state";
import { TaskBoardColumn } from "../ui/tasks-board";
import "../ui/board-lane.css";

export function BoardColumn({
  title,
  titleHint,
  count,
  glyph,
  actions,
  footer,
  emptyHint,
  loading = false,
  collapsible = false,
  collapseWhenEmpty = false,
  onDropCard,
  children,
}: {
  title: string;
  /** Plain-language gloss of what this lane means, surfaced as the header's
   *  tooltip. Cheaper than a "?" affordance and it never takes up a slot. */
  titleHint?: string;
  /** Shown in the header and preserved when the lane is collapsed. */
  count: number;
  /** The status glyph fronting the name — pass `StateGlyph` (the app's one
   *  shape vocabulary for state) so a lane and a card agree about what a given
   *  status looks like. */
  glyph?: ReactNode;
  /** Per-lane affordances pinned to the right of the header (e.g. "Retry all"
   *  on a failed lane). */
  actions?: ReactNode;
  /** Pinned below the card stack — the quick-add row on boards that have one. */
  footer?: ReactNode;
  /** Plain-language sentence shown when the lane holds nothing. */
  emptyHint?: ReactNode;
  loading?: boolean;
  collapsible?: boolean;
  /** Fold a lane holding nothing down to the narrow strip instead of leaving a
   *  full-width column of empty. For boards whose lanes are derived from real
   *  state and therefore always all render (a pipeline that hides its empty
   *  stages stops being a pipeline) — the shape survives, but three empty
   *  stages no longer push the live ones off the right edge. Opening one by
   *  hand keeps it open, and a lane that gains a card unfolds itself. */
  collapseWhenEmpty?: boolean;
  /** Makes the lane a drop target. Omit on boards whose lanes are derived from
   *  real state and therefore can't be dragged into. */
  onDropCard?: () => void;
  children?: ReactNode;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  // Set when the reader opens an auto-folded empty lane, so it stays open while
  // they read its hint.
  const [emptyOpened, setEmptyOpened] = useState(false);
  // A count of nothing is a claim, and mid-fetch we haven't got one. The body
  // already says it is loading here, so the header printing "Backlog 0" over
  // it would contradict the only other thing in the lane.
  const countPending = loading && count === 0;
  const folded =
    collapsed ||
    (collapseWhenEmpty && count === 0 && !loading && !emptyOpened);

  if (folded) {
    return (
      <section className="ui-board-lane-folded" aria-label={`${title} lane`} title={titleHint}>
        {glyph}
        {!countPending && <span className="ui-board-lane-count">{count}</span>}
        {/* Real vertical text flow rather than a rotate transform, so
            truncation and text metrics stay correct. */}
        <h2>{title}</h2>
        <Button
          variant="ghost"
          size="iconXs"
          onClick={() => {
            setCollapsed(false);
            setEmptyOpened(true);
          }}
          title={`Expand ${title}`}
          aria-label={`Expand ${title}`}
        >
          <ChevronsLeftRight />
        </Button>
      </section>
    );
  }

  const laneActions =
    actions || collapsible ? (
      <>
        {actions}
        {collapsible && (
          <Button
            variant="ghost"
            size="iconXs"
            onClick={() => {
              setCollapsed(true);
              setEmptyOpened(false);
            }}
            title={`Collapse ${title}`}
            aria-label={`Collapse ${title}`}
          >
            <ChevronsRightLeft />
          </Button>
        )}
      </>
    ) : undefined;

  return (
    <TaskBoardColumn
      label={title}
      hint={titleHint}
      count={countPending ? null : count}
      icon={glyph}
      actions={laneActions}
      onDrop={onDropCard}
      footer={footer}
    >
      {countPending ? <LoadingState label="Loading…" className="ui-board-lane-loading" /> : children}
      {!loading && count === 0 && emptyHint}
    </TaskBoardColumn>
  );
}
