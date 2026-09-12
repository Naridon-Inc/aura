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
    <section>
      <div className="mb-2.5">
        <h2 className="section-label">What this does and doesn&apos;t tell you</h2>
      </div>
      <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
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
      </div>
    </section>
  );
}

const TONE_COLOR: Record<EvidenceTone, string> = {
  good: "var(--color-accent-green)",
  bad: "var(--color-red)",
  warn: "var(--color-amber)",
  muted: "var(--color-text-4)",
};

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
    <div className="border-b border-line-soft px-3.5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-base font-medium text-text-1">{item.title}</span>
        <StatusChip status={item.status} tone={tone} />
        {item.revision ? (
          <span
            className="font-mono text-2xs text-text-4"
            title="The version of the code this result was measured against"
          >
            {shortRevision(item.revision)}
          </span>
        ) : null}
        {item.checkedAt != null ? (
          <span className="text-xs text-text-5">{relativeAge(item.checkedAt)}</span>
        ) : null}
        {onRecheck ? (
          <Button
            type="button"
            variant="subtle"
            size="xs"
            onClick={onRecheck}
            disabled={rechecking}
            className="ml-auto text-xs text-text-3"
          >
            {rechecking ? "Running…" : "Run them now"}
          </Button>
        ) : null}
      </div>

      <p className="mt-1 text-base leading-snug text-text-2">{item.detail}</p>

      {failure ? (
        <p className="mt-1 text-sm leading-snug" style={{ color: "var(--color-red)" }}>
          {failure}
        </p>
      ) : null}

      {target && onRecheck ? (
        <p className="mt-1 text-sm leading-snug text-text-4">{target}</p>
      ) : null}

      {item.staleReason ? (
        <p
          className="mt-1 text-sm leading-snug"
          style={{ color: "var(--color-amber)" }}
        >
          {item.staleReason}
        </p>
      ) : null}

      {/* Only a row with a result needs the caveat. An empty row's own line
          already says the whole thing, and repeating "missing is not passing"
          under every one of them is how a section stops being read. */}
      {claimed ? (
        <p className="mt-1 text-sm leading-snug text-text-4">
          Doesn&apos;t tell you: {meaning.doesNotEstablish}
        </p>
      ) : null}
    </div>
  );
}

function StatusChip({ status, tone }: { status: EvidenceStatus; tone: EvidenceTone }) {
  const color = TONE_COLOR[tone];
  return (
    <span
      title={statusHint(status)}
      className="shrink-0 rounded px-1.5 py-px text-2xs"
      style={{
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        border: `0.5px solid color-mix(in oklab, ${color} 32%, transparent)`,
      }}
    >
      {statusWord(status)}
    </span>
  );
}
