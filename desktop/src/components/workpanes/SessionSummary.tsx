// SessionSummary — the Summary tab body of a session detail. It reads
// top-to-bottom like a short report rather than a data dump:
//
//   1. What happened — the intent / prompt body in plain language, with code
//      entities highlighted and any changed-file name clickable (jumps to
//      Changes). The one-line headline already lives in the header, so this is
//      the elaboration, not a repeat.
//   2. Files changed — the files this run touched, each a shortcut into the
//      Changes tab with its own +/− churn.
//   3. What this does and doesn't tell you — the seal, the goal verdict and the
//      commit are all drawn as a word and a tick, and read down the page they
//      compound into a claim none of them makes. This says, per kind of result,
//      what it establishes and what it doesn't, and marks anything measured
//      against a different version of the code as out of date.
//   4. Details — the facts a reader only wants on demand (exact time, signature
//      provenance). Agent / type / file-count already sit as header chips, so we
//      don't restate them here.
//
// Built for an audience that increasingly includes non-developers: clear
// hierarchy, generous spacing, no jargon walls.

import type { ReactNode } from "react";
import { ArrowRight, Lock, LockOpen, ShieldX } from "lucide-react";
import type { IntentRow, IntentChangesetFile } from "../../lib/api";
import type { IntentProvenance } from "../../lib/sessionMeta";
import { IntentProse, splitIntent } from "./IntentProse";
import { SessionGoals, runKeyForIntent } from "../goals/SessionGoals";
import { SessionEvidence } from "./SessionEvidence";
import { SessionOutstanding } from "./SessionOutstanding";
import {
  projectName,
  versionWords,
  whereItHappened,
  type ReviewScope,
} from "../../lib/reviewScope";
import { shortBlockId } from "./SessionAttestation";
import { Button } from "../ui/button";
import { TraceFact } from "../ui/trace-detail";
import {
  TraceFileRow,
  TraceReport,
  TraceSection,
  TraceVerdict,
} from "../ui/trace-report";

/** One label/value line in a Details section. */
function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return <TraceFact label={label}>{children}</TraceFact>;
}

/** The trust floor for the whole report, woven in at the top rather than
 *  hidden behind a separate tab. When a run is sealed, Aura recorded exactly
 *  what the AI changed and why and locked that record — so the story below
 *  can't have been quietly edited afterward. Deliberately plain: no
 *  "signature", "ed25519", or "block" here; the full proof lives one tab over. */
function GenuineRecordSeal({
  row,
  provenance,
}: {
  row: IntentRow;
  provenance: IntentProvenance;
}) {
  const signed = !!row.signed_block_id;
  if (!signed) {
    return (
      <TraceVerdict tone="muted" icon={<LockOpen />} title="Not sealed">
        This change wasn't locked with a tamper-proof seal, so Aura can't
        promise the record below is exactly as it happened.
      </TraceVerdict>
    );
  }
  return (
    <TraceVerdict tone="good" icon={<Lock />} title="Genuine record">
      {/* "locked exactly what the AI changed and why" was true of the change
          and only sometimes true of the why. The seal is tamper-evidence: it
          proves nothing here moved after the fact. It cannot make a sentence
          Aura's own model wrote from the diff into a reason somebody gave,
          and stating it in one breath is what turned the weakest row in the
          log into the most reassuring thing on the page. */}
      {provenance === "stated"
        ? "Aura locked exactly what the AI changed and why. Nothing in this record has been altered since."
        : "Aura locked exactly what the AI changed. Nothing in this record has been altered since, but the “why” below wasn’t stated by whoever made the change."}
    </TraceVerdict>
  );
}

/** The detail body for a blocked/halted guard record — an attempt Aura refused
 *  to let land. It is deliberately NOT the asked→built→prove report: nothing was
 *  built and there is nothing to prove or resume. It answers three things a
 *  reader actually wants: it was stopped, what was risked, and that no code
 *  changed. The one-line "what was attempted" already sits in the header. */
function BlockedReport({
  bodyText,
  whenAbsolute,
  rel,
}: {
  bodyText: string;
  whenAbsolute: string;
  rel: string;
}) {
  return (
    <TraceReport>
      {/* The verdict — the whole point, up top and in the danger colour. */}
      <TraceVerdict tone="bad" icon={<ShieldX />} title="Blocked. This change never landed">
        Aura stopped the commit before it reached your history. Your code was
        left exactly as it was.
      </TraceVerdict>

      {/* Why it was stopped — the plain-language reason. */}
      {bodyText ? (
        <TraceSection title="Why Aura stopped it">
          <p className="ui-trace-report-prose">{bodyText}</p>
        </TraceSection>
      ) : null}

      <TraceSection title="Details">
        <MetaRow label="When">
          {whenAbsolute} <span className="ui-trace-fact-aside">({rel})</span>
        </MetaRow>
        <MetaRow label="Outcome">Commit halted. No code was changed.</MetaRow>
      </TraceSection>
    </TraceReport>
  );
}

export function SessionSummary({
  row,
  repoRoot,
  files,
  symbols,
  bodyText,
  bodyLabel,
  bodyNote,
  provenance,
  whenAbsolute,
  rel,
  alignment,
  onOpenFile,
  onOpenMatch,
}: {
  row: IntentRow;
  /** Repo root — threaded so the Goals section can prove against this repo. */
  repoRoot: string;
  files: IntentChangesetFile[];
  /** Changed-symbol names (from this run's change-note) to chip in the prose. */
  symbols: string[];
  /** The intent/prompt body (elaboration after the header headline). */
  bodyText: string;
  /** Heading over the body — what this text actually is. See
   *  `provenanceLabel`: "Reason" only when somebody stated one. */
  bodyLabel: string;
  /** One line under the body naming who wrote it; empty for a stated reason. */
  bodyNote: string;
  /** Where the body came from, so the seal doesn't claim more than it holds. */
  provenance: IntentProvenance;
  whenAbsolute: string;
  rel: string;
  /** Whether the asked-versus-changed comparison can be computed for this run,
   *  and the plain reason when it can't. Decided by the pane, which owns the
   *  rule (a committed change, derivable on this machine) — duplicating it here
   *  is how one condition ends up with two answers. */
  alignment: { available: boolean; unsupportedReason: string };
  /** Jump to Changes; with a path, open that file directly. */
  onOpenFile: (path?: string) => void;
  /** Open the tab that compares what was asked with what changed — offered as
   *  the action on the "these haven't been compared" item. Absent when the pane
   *  has no such tab for this run. */
  onOpenMatch?: () => void;
}) {
  // A blocked/halted guard record reads as its own short "here's what was
  // stopped" report — not the asked→built→prove story (there is no build, no
  // changeset, nothing to prove or seal).
  if (row.intent_type === "blocked") {
    return <BlockedReport bodyText={bodyText} whenAbsolute={whenAbsolute} rel={rel} />;
  }

  const signed = !!row.signed_block_id;
  // The session's own commit (first changeset file that carries one). Threaded
  // into the Goals section so it proves against the code THIS run produced, not
  // the checked-out branch — the merged `files` also covers native-chat rows
  // that borrow a fetched changeset. Undefined for uncommitted/working-tree runs.
  const atCommit = files.find((f) => (f.commit ?? "").trim())?.commit?.trim() || undefined;
  // What everything on this page is about — as distinct from the checkout the
  // reader is standing in, which is where the buttons land. Every field comes
  // from the record itself; the ones it doesn't carry stay missing.
  const scope: ReviewScope = {
    project: projectName(repoRoot),
    branch: row.branch ?? null,
    worktree: row.worktree ?? null,
    revision: atCommit ?? null,
  };
  return (
    <TraceReport>
      {/* 0 · Trust floor — is this record genuine? Woven in at the top so it
          frames the whole story, not buried in a separate verification tab. */}
      <GenuineRecordSeal row={row} provenance={provenance} />

      {/* 1 · What happened — plain-language body with live entities. */}
      {bodyText ? (
        <TraceSection title={bodyLabel}>
          <IntentProse
            source={bodyText}
            files={files}
            symbols={symbols}
            onOpenFile={onOpenFile}
            className="ui-trace-report-prose"
          />
          {/* Who wrote the sentence above. Absent for a stated reason —
              that's the ordinary case. Present when the words came from
              somewhere the heading alone doesn't make obvious, which until
              now was every case: a prompt, a model's read of the diff and a
              genuine logged reason all appeared here as "Reason". */}
          {bodyNote ? <p className="ui-trace-report-note">{bodyNote}</p> : null}
        </TraceSection>
      ) : null}

      {/* 2 · Files changed — each a shortcut into Changes. */}
      {files.length ? (
        <TraceSection
          title="Files changed"
          count={files.length}
          trailing={
            <Button variant="ghost" size="sm" type="button" onClick={() => onOpenFile()}>
              Review changes
              <ArrowRight />
            </Button>
          }
        >
          {files.map((f) => (
            <TraceFileRow
              key={f.path}
              path={f.path}
              added={f.additions ?? 0}
              removed={f.deletions ?? 0}
              onOpen={onOpenFile}
            />
          ))}
        </TraceSection>
      ) : null}

      {/* 3 · Goals — what this run was meant to achieve, proven against the
          code. Bound to the run's key, so the same verdict shows on any task
          this goal is linked to. */}
      <SessionGoals
        repoRoot={repoRoot}
        row={row}
        hasChanges={files.length > 0}
        atCommit={atCommit}
      />

      {/* 4 · What the run left owing. The agent stopping is a fact about a
          process, and it was reading as a fact about the work: a failed
          check, a check nobody ran and a test only a person can do all
          disappeared the moment the session went grey. Each item here names
          what it needs and carries the one action that settles it. */}
      <SessionOutstanding
        repoRoot={repoRoot}
        runKey={runKeyForIntent(row)}
        runLabel={splitIntent(row.intent).headline || row.intent}
        agentId={row.agent_id}
        signed={signed}
        scope={scope}
        codeChangedAt={row.timestamp * 1000}
        fileCount={files.length}
        alignment={alignment}
        onOpenMatch={onOpenMatch}
      />

      {/* 5 · What each of the results above is actually worth. The seal, the
          goal verdict and the commit are drawn alike and read as one claim
          getting stronger; this says once, per kind, what each establishes
          and what it doesn't — and marks any result measured against a
          different version of the code as out of date. */}
      <SessionEvidence
        repoRoot={repoRoot}
        runKey={runKeyForIntent(row)}
        signed={signed}
        scope={scope}
        codeChangedAt={row.timestamp * 1000}
        fileCount={files.length}
        alignment={alignment}
      />

      {/* 6 · Details — facts on demand. */}
      <TraceSection title="Details">
        <MetaRow label="When">
          {whenAbsolute} <span className="ui-trace-fact-aside">({rel})</span>
        </MetaRow>
        {/* Which work this page is about. Read weeks later, from another
            branch or another machine, "where" and "which version" are the
            difference between a fact about this run and a fact about
            whatever happens to be checked out. A record that carries
            neither says so — it is never filled in from the surroundings. */}
        <MetaRow label="Where">
          {whereItHappened(scope)}
          {!scope.branch && !scope.worktree ? (
            <span className="ui-trace-fact-aside">
              The branch and folder weren&apos;t recorded.
            </span>
          ) : null}
        </MetaRow>
        <MetaRow label="Version">
          {scope.revision ? (
            <>
              <span className="ui-trace-fact-code">{versionWords(scope.revision)}</span>
              <span className="ui-trace-fact-aside">
                Everything above is about the code at this version.
              </span>
            </>
          ) : (
            <span className="ui-trace-fact-aside">
              {versionWords(null)}, so there&apos;s no fixed version to check against.
            </span>
          )}
        </MetaRow>
        <MetaRow label="Record">
          {signed ? (
            <>
              Sealed. The full proof is on the Genuine record tab.
              <span className="ui-trace-fact-code">
                {shortBlockId(row.signed_block_id ?? "")}
              </span>
            </>
          ) : (
            <span className="ui-trace-fact-aside">Not sealed.</span>
          )}
        </MetaRow>
      </TraceSection>
    </TraceReport>
  );
}
