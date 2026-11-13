// The code half of the Changes tab's diff pane: the reveal that demotes it
// below the meaning, its load and empty states, a teammate's file we hold no
// lines for, and the unified body drawn with the shared file diff.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { IntentChangesetFile } from "../../../lib/api";
import { parseUnifiedDiff } from "../../../lib/diff";
import type { DiffFocus } from "../../../lib/diffSides";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { DiffCount } from "../../ui/sidebar";
import { TraceLine } from "../../ui/trace-report";
import { FileDiff, type DiffLine } from "../../ui/workspace-patterns";
import { changeStatus } from "./changeTree";

// ── demoted raw code ─────────────────────────────────────────────────
// The diff is the ENGINEER's view. It sits BELOW the plain-language meaning,
// so a non-engineer meets "what changed and why" first — not a wall of source.
// The reveal is deliberately quiet: the meaning is the headline; the exact
// lines are one calm click away. `adds`/`dels` give a sense of scale on the
// closed toggle without showing a single line of code.
export function CodeReveal({
  show,
  onToggle,
  adds,
  dels,
  keepMounted = false,
  children,
}: {
  show: boolean;
  onToggle: () => void;
  adds: number;
  dels: number;
  /** Hide rather than unmount when closed — an editable diff with unsaved
   *  edits must not lose them to a "Hide the code" click. */
  keepMounted?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <div className="ui-changes-reveal">
        <Button
          variant="ghost"
          size="xs"
          onClick={onToggle}
          aria-expanded={show}
          title={
            show
              ? "Hide the exact code lines"
              : "Show the exact code lines that changed. The engineer's view"
          }
        >
          {show ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {show ? "Hide the code" : "See the actual code"}
        </Button>
        {!show && (adds > 0 || dels > 0) ? <DiffCount added={adds} removed={dels} /> : null}
      </div>
      {show ? (
        <div className="ui-changes-reveal-body">{children}</div>
      ) : keepMounted ? (
        <div hidden className="ui-changes-reveal-body">
          {children}
        </div>
      ) : null}
    </>
  );
}

/** The code's own load / empty states, so the meaning above never waits on
 *  them. */
export function CodeState({
  kind,
  error,
  committed,
}: {
  kind: "loading" | "error" | "empty";
  error?: string | null;
  committed?: boolean;
}) {
  if (kind === "loading") {
    return (
      <div className="ui-changes-state">
        <AsciiSpinner />
        <span>Loading the code…</span>
      </div>
    );
  }
  if (kind === "error") {
    return (
      <div className="ui-changes-state" data-stack>
        <TraceLine tone="danger">Couldn&rsquo;t load the code.</TraceLine>
        {error ? <code className="ui-changes-error">{error}</code> : null}
      </div>
    );
  }
  return (
    <div className="ui-changes-state">
      <TraceLine tone="note">
        {committed
          ? "This change didn't alter any text in this file. It was a rename, or a settings-only change."
          : "Nothing to show here. This file already matches the last saved version."}
      </TraceLine>
    </div>
  );
}

/** What a teammate's file changed, when the patch isn't in this clone.
 *
 *  The team plane records which file a person touched and which pieces of it
 *  they moved, but not the lines — their commit may be on a branch nobody here
 *  has fetched. That's a real and useful amount to know, and it is the
 *  difference between "Sam reworked the retry policy — `backoff`, `send`" and
 *  a Changes tab that has been empty for every one of Sam's sessions.
 *
 *  It deliberately does NOT offer to fetch. We know the file and the person;
 *  we don't know the branch, and guessing one would send someone chasing the
 *  wrong ref. */
export function RemoteChangeSummary({ file }: { file: IntentChangesetFile }) {
  const symbols = file.symbols ?? [];
  const word = changeStatus(file.status).word;
  return (
    <div className="ui-changes-state" data-stack>
      <TraceLine tone="note">
        A teammate {word} this file. Their code isn&rsquo;t on this machine, so there are no
        lines to show — pull their branch to read the change itself.
      </TraceLine>
      {symbols.length > 0 ? (
        <section className="ui-changes-symbols" aria-label="What they changed in it">
          <h4>What they changed in it</h4>
          <ul>
            {symbols.map((s) => (
              <li
                key={`${s.identifier}:${s.change}`}
                title={s.kind ? `${s.kind} — ${s.change || "changed"}` : s.change}
              >
                <code>{s.identifier}</code>
                {s.change ? <small>{s.change}</small> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Soft cap so a single huge file can't blow up the DOM; the rest is one
 *  press away rather than silently dropped. */
const MAX_LINES = 600;
/** Unchanged lines kept either side of a picked piece, so it reads in place. */
const CONTEXT = 3;

/** Does this row belong to the picked piece? A focus is expressed in one
 *  side's real file line numbers, so only that side's gutter can answer — an
 *  addition has no old-file line and a removal has no new-file one. */
function inFocus(ln: DiffLine, focus: DiffFocus | null): boolean {
  const span = focus?.span;
  if (!span) return false;
  const no = span.side === "original" ? ln.oldLine : ln.newLine;
  return no != null && no >= span.startLine && no <= span.endLine;
}

/** The plain-language line for the picked piece, directly above its code. */
function FocusCaption({
  focus,
  located,
  onClear,
}: {
  focus: DiffFocus;
  located: boolean;
  onClear?: () => void;
}) {
  return (
    <div className="ui-changes-focus">
      <div>
        <p>
          <strong>{focus.title}</strong>
          <code>{focus.identifier}</code>
        </p>
        <p data-quiet={focus.meaning ? undefined : true}>
          {focus.meaning || "The plain-language line for this piece is still being written."}
        </p>
        {!located ? (
          <p data-quiet>
            These lines aren&rsquo;t in the part of the file this diff shows, so there&rsquo;s
            nothing to highlight.
          </p>
        ) : null}
      </div>
      {onClear ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClear}
          aria-label="Show the whole change"
          title="Show the whole change"
        >
          <X size={14} aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/** The unified diff, in the shared file diff. A picked piece narrows it to
 *  that piece's lines (with a little context) under its caption; clearing the
 *  pick brings the whole change back. */
export function PieceDiff({
  diff,
  path,
  focus,
  onClearFocus,
}: {
  diff: string;
  path: string;
  focus: DiffFocus | null;
  onClearFocus?: () => void;
}) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [diff]);

  let first = -1;
  let last = -1;
  if (focus?.span) {
    lines.forEach((ln, i) => {
      if (!inFocus(ln, focus)) return;
      if (first < 0) first = i;
      last = i;
    });
  }
  const located = first >= 0;
  const shown = located
    ? lines.slice(Math.max(0, first - CONTEXT), Math.min(lines.length, last + CONTEXT + 1))
    : all
      ? lines
      : lines.slice(0, MAX_LINES);
  const hidden = lines.length - shown.length;

  return (
    <div className="ui-changes-code">
      {focus ? <FocusCaption focus={focus} located={located} onClear={onClearFocus} /> : null}
      <FileDiff name={path} lines={shown} />
      {hidden > 0 ? (
        <div className="ui-changes-more">
          {located ? (
            <>
              <span>
                The rest of this file&rsquo;s change is folded away ({hidden} line
                {hidden === 1 ? "" : "s"}).
              </span>
              {onClearFocus ? (
                <Button variant="ghost" size="xs" onClick={onClearFocus}>
                  Show the whole change
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <span>
                Showing the first {MAX_LINES} of {lines.length} lines.
              </span>
              <Button variant="ghost" size="xs" onClick={() => setAll(true)}>
                Show all {lines.length}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
