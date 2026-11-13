// What changed in this file, over the editor's diff — told for someone who
// doesn't read code. A short "used to → now" account leads; under it, one flat
// row per changed thing with a +/−/~ mark: a function added, a setting
// dropped, a person who moved to the top of a list. The name or key each row
// came from sits dim beside it, and the reason the change was made follows as
// one quiet line that opens to the other notes.
//
// One shared accordion row, open by default; the choice is remembered on this
// machine.

import { useState } from "react";
import { useFileInsight } from "../lib/useFileInsight";
import { codeRows, dataStoryRows, headline, storyTally, whyNotes } from "./fileInsight/story";
import { StoryRows } from "./fileInsight/StoryRows";
import { WhyLine } from "./fileInsight/WhyLine";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { DiffCount } from "./ui/sidebar";
import "./ui/file-insight.css";

const COLLAPSE_KEY = "aura.fileInsight.open";

type Props = {
  repoRoot: string;
  /** Absolute file path. The hook normalises to a repo-relative form. */
  absPath: string;
  /** Display name (basename or short relative path) — the caller already
   *  computes one for the breadcrumb. */
  fileLabel: string;
  /** Quick-action wires the callers still pass. Rewind / Log-intent /
   *  Snapshot are reachable from the command palette; this block is read-only,
   *  so they are accepted for callsite compatibility but unused here. */
  onOpenRewind?: () => void;
  onLogIntent?: () => void;
  onSnapshot?: () => void;
};

export function FileInsightStrip({ repoRoot, absPath }: Props) {
  const [open, setOpenState] = useState<boolean>(() => readOpen());
  const setOpen = (next: boolean) => {
    setOpenState(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      // Storage off: the row still opens and closes, it just isn't remembered.
    }
  };

  const insight = useFileInsight(repoRoot, absPath);
  const rows = insight.dataRows
    ? dataStoryRows(insight.dataRows)
    : codeRows(insight.pieces, insight.meanings);
  const head = headline(insight.explanation);
  const why = whyNotes(insight.explanation, insight.notes, insight.sessionNote);
  const tally = storyTally(rows);
  const changedLines = insight.additions + insight.deletions;

  return (
    <Accordion
      type="single"
      collapsible
      value={open ? "insight" : ""}
      onValueChange={(v) => setOpen(v === "insight")}
      className="ui-file-insight"
    >
      <AccordionItem value="insight">
        <AccordionTrigger>
          <span>What changed</span>
          <span className="ui-file-insight-counts">
            {insight.writing && (
              <span className="ui-story-writing" title="Aura is still writing the plain-language lines">
                <AsciiSpinner size={10} />
              </span>
            )}
            {tally && <span>{tally}</span>}
            <DiffCount added={insight.additions} removed={insight.deletions} />
          </span>
        </AccordionTrigger>
        <AccordionContent>
          <div className="ui-story">
            {head && (
              <dl className="ui-story-head" data-single={head.before ? undefined : ""}>
                {head.before && (
                  <div>
                    <dt>Used to</dt>
                    <dd>{head.before}</dd>
                  </div>
                )}
                <div>
                  <dt>{head.before ? "Now" : "What this does now"}</dt>
                  <dd data-now="">{head.now}</dd>
                </div>
              </dl>
            )}

            {rows.length > 0 ? (
              <StoryRows rows={rows} filePath={absPath} />
            ) : (
              !head && (
                <p className="ui-story-empty">
                  {insight.loading ? (
                    <>
                      <AsciiSpinner size={10} /> Reading the change…
                    </>
                  ) : insight.dataRows ? (
                    "Only the formatting changed — the data is the same."
                  ) : changedLines > 0 ? (
                    `${changedLines} line${changedLines === 1 ? "" : "s"} changed`
                  ) : (
                    "No changes since the last commit."
                  )}
                </p>
              )
            )}

            <WhyLine notes={why} />
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) !== "0";
  } catch {
    return true;
  }
}
