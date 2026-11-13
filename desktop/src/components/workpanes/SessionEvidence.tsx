// "What this does and doesn't tell you" — the evidence ledger on a run.
//
// The Summary already shows a seal, a goal verdict and a list of files, each
// drawn as a word and a tick. Read top to bottom they compound into a claim
// none of them makes: that the change works. This section says, once, what
// each kind of result actually establishes and what it explicitly does not —
// and where a result exists, which version of the code it was measured against.
//
// It is a ledger, not a scoreboard. Rows with nothing in them are still rows:
// a reviewer must be able to see that nothing on the page said this was
// released, rather than infer release from an absence of red. The rules live in
// lib/evidence (what a kind may claim) and lib/sessionEvidence (what this run
// has); this file only draws them.

import {
  meaningOf,
  statusHint,
  statusWord,
  toneOf,
  type EvidenceStatus,
  type EvidenceTone,
} from "../../lib/evidence";
// `statusHint` rides on the status chip's tooltip: the row's own line carries
// the plain fact, and the reader who wants "why isn't this green" gets it on
// hover rather than as a fourth line under every empty row.
import { runChecksNow } from "../../lib/checksEvidence";
import { actionTarget, type ReviewScope } from "../../lib/reviewScope";
import { useWorkingTarget } from "../../lib/useWorkingTarget";
import { shortRevision, type EvidenceItem } from "../../lib/sessionEvidence";
import { useRunEvidence } from "../../lib/useRunEvidence";
import { relativeAge } from "../../lib/relativeTime";
import { Button } from "../ui/button";
import { TraceMark } from "../ui/trace-list";
import { TraceItem, TraceItems, TraceLine, TraceSection } from "../ui/trace-report";

export function SessionEvidence({
  repoRoot,
  runKey,
  signed,
  /** What this page is about: project, branch, folder and the version this run
   *  produced. The rows are about that; the button is about the checkout. */
  scope,
  /** Unix millis the reviewed code was produced — this run's own timestamp. */
  codeChangedAt,
  fileCount,
  /** Whether the asked-versus-changed comparison can be computed here, and the
   *  plain reason when it can't. */
  alignment,
}: {
  repoRoot: string;
  runKey: string;
  /** Does this run carry a signed record block? */
  signed: boolean;
  scope: ReviewScope;
  codeChangedAt: number | null;
  fileCount: number;
  alignment: { available: boolean; unsupportedReason: string };
}) {
  const working = useWorkingTarget(repoRoot);
  // One assembly of this run's evidence, shared with the list of what's still
  // open above it. Running the checks from here is the fast compiler-free set,
  // so it answers in about a second; the full build stays a deliberate trip to
  // the Checks surface. A run that produces nothing reports the failure and
  // leaves the previous result standing.
  const {
    items,
    checks: { running, error },
  } = useRunEvidence({
    repoRoot,
    runKey,
    signed,
    revision: scope.revision,
    codeChangedAt,
    fileCount,
    alignment,
  });

  return (
    <TraceSection title="What this does and doesn&apos;t tell you">
      <TraceItems>
        {items.map((item) => (
          <EvidenceRow
            key={item.kind}
            item={item}
            onRecheck={
              item.kind === "executed_check" ? () => void runChecksNow(repoRoot) : undefined
            }
            rechecking={running}
            failure={item.kind === "executed_check" ? error : ""}
            // The one row with a button that executes something says where it
            // would execute — the checkout, which may be a different branch
            // from the one this record is about.
            target={item.kind === "executed_check" ? actionTarget("checks", scope, working) : ""}
          />
        ))}
      </TraceItems>
    </TraceSection>
  );
}

function EvidenceRow({
  item,
  onRecheck,
  rechecking,
  failure,
  target,
}: {
  item: EvidenceItem;
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Why the last attempt to produce this result didn't. Shown as its own line:
   *  an action that failed has to say so, or the row silently keeps reading as
   *  though nobody had tried. */
  failure?: string;
  /** What this row's button would run against, when it has one. */
  target?: string;
}) {
  const meaning = meaningOf(item.kind);
  const tone = toneOf(item.status);
  // The "people read this as more than it is" line is worth saying only where
  // there is a result to over-read. A row that says "not run" is already the
  // whole story, and repeating the caveat under every empty row turns the
  // section into noise nobody finishes.
  const claimed = item.status === "pass" || item.status === "fail";

  return (
    <TraceItem
      tone={tone}
      title={item.title}
      marks={
        <>
          <StatusMark status={item.status} tone={tone} />
          {item.revision ? (
            <TraceMark title="The version of the code this result was measured against">
              {shortRevision(item.revision)}
            </TraceMark>
          ) : null}
          {item.checkedAt != null ? <TraceMark>{relativeAge(item.checkedAt)}</TraceMark> : null}
        </>
      }
      actions={
        onRecheck ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRecheck}
            disabled={rechecking}
          >
            {rechecking ? "Running…" : "Run them now"}
          </Button>
        ) : null
      }
    >
      <TraceLine>{item.detail}</TraceLine>
      {failure ? <TraceLine tone="danger">{failure}</TraceLine> : null}
      {target && onRecheck ? <TraceLine tone="note">{target}</TraceLine> : null}
      {item.staleReason ? <TraceLine tone="warn">{item.staleReason}</TraceLine> : null}
      {/* Only a row with a result needs the caveat. An empty row's own line
          already says the whole thing, and repeating "missing is not passing"
          under every one of them is how a section stops being read. */}
      {claimed ? (
        <TraceLine tone="note">Doesn&apos;t tell you: {meaning.doesNotEstablish}</TraceLine>
      ) : null}
    </TraceItem>
  );
}

const MARK_TONE = { good: "good", bad: "danger", warn: "warn", muted: undefined } as const;

function StatusMark({ status, tone }: { status: EvidenceStatus; tone: EvidenceTone }) {
  return (
    <TraceMark tone={MARK_TONE[tone]} title={statusHint(status)}>
      {statusWord(status)}
    </TraceMark>
  );
}
