// SessionDetailPane — one run, opened. The layout a workspace opens into: a
// page header naming the run (with Resume / Rewind), a strip of views, the
// view itself, and a details column on the right with the facts about the run
// and the files it touched.
//
// The views, in a fixed order so the strip never reshuffles between runs:
// Chat · Review changes · Summary, then three that fold in only when there is
// something to show — Match (the run was committed, so what was asked can be
// compared with what changed), Genuine record (it was signed), and Workers (it
// fanned work out to sub-agents). A blocked record is a single short report, so
// it has Summary alone. A run with a conversation to replay opens on Chat;
// anything else opens on Summary.
//
// Workers is a view rather than a block inside Summary because it is a tree of
// runs, each with a closing report of its own — hundreds under one session in
// this very repo — and Summary is a short report read top to bottom. It is also
// absent far more often than present, and a run that never fanned out should
// look exactly as it always did.
//
// Real data only: no fabricated verdicts. A signed record shows "Signed", never
// a pass/fail judgement it did not make.
//
// Two presentations. Inside Trace it is the deep view under a session's story
// (`inline`): the story links to it on the view it means, it takes the
// story's place, and Esc or the crumb goes back to the story with focus on
// the link that opened it. Everywhere else — the signed-records ledger, the
// console — it opens as a focus surface over what was there.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, PanelRight } from "lucide-react";
import type { IntentChangesetFile, IntentRow } from "../../lib/api";
import { captureFocus } from "../../lib/focusReturn";
import {
  provenanceLabel,
  provenanceNote,
  statedSessionId,
} from "../../lib/sessionMeta";
import { Button } from "../ui/button";
import { TraceHeader } from "../ui/trace-page";
import { TraceDetail, TraceDetailTabs, TraceNote, type TraceDetailTab } from "../ui/trace-detail";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { useSessionDetail } from "../trace/useSessionDetail";
import { SessionDetailAside } from "../trace/SessionDetailAside";
import { SessionSummary } from "./SessionSummary";
import { SessionActions } from "./SessionActions";
import { ChangesView } from "./ChangesView";
import { useBringBack, BringBackResult } from "./useBringBack";
import { SessionAttestation } from "./SessionAttestation";
import { SessionTranscript } from "./SessionTranscript";
import { SessionSubagents } from "./SessionSubagents";
import type { SubagentRuns } from "./subagentRuns";
import { useSessionIntentReport } from "./IntentStory";
import { SessionAlignment } from "./SessionAlignment";

/** The views of a run, by the id a caller opens one on. */
export type SessionDetailView =
  | "transcript"
  | "changes"
  | "summary"
  | "alignment"
  | "attestation"
  | "subagents";
type Tab = SessionDetailView;

/** Wide enough for the run and its details side by side; narrower, the
 *  details column starts folded so the conversation keeps a readable width. */
const ASIDE_OPEN_MIN_WIDTH = 1200;

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    !!el.closest?.(".monaco-editor")
  );
}

export function SessionDetailPane({
  repoRoot,
  row,
  onBack,
  renderReasons,
  subagentRuns,
  inline = false,
  initialTab,
  initialFile,
}: {
  repoRoot: string;
  row: IntentRow;
  onBack: () => void;
  /** What to lead a file's diff with when the recorded change-note cannot be
   *  computed here. Unset in the desktop, which has a checkout and derives the
   *  before/after itself; the console passes the intents written about that
   *  file — the sentences, which were never derived from the diff anyway. */
  renderReasons?: (file: IntentChangesetFile) => ReactNode;
  /** This session's sub-agent runs, when the surrounding app already read
   *  them. Unset in the desktop, which asks the cloud itself; the console
   *  passes them, because its data layer holds the bearer and the org header.
   *  Either way an unanswered read is `{ known: false }` and never an empty
   *  list — see subagentRuns.ts for why the difference matters. */
  subagentRuns?: SubagentRuns;
  /** Draw as the page itself rather than a surface over it. */
  inline?: boolean;
  /** The view to open on — what the session's story pointed at. Unset, a run
   *  with a conversation opens on Chat and anything else on Summary. */
  initialTab?: SessionDetailView;
  /** With Review changes, the file to open it on. */
  initialFile?: string | null;
}) {
  const detail = useSessionDetail({ repoRoot, row, subagentRuns });
  const { sess, files, isBlocked, managerSessionId, showAlignment, workers, title } = detail;
  const [picked, setTab] = useState<Tab | null>(initialTab ?? null);
  // A file picked from the Summary prose or the details column: Review
  // changes opens straight on it.
  const [pendingFile, setPendingFile] = useState<string | null>(initialFile ?? null);
  const [asideOpen, setAsideOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= ASIDE_OPEN_MIN_WIDTH,
  );
  const openFile = (path?: string) => {
    setPendingFile(path ?? null);
    setTab("changes");
  };

  const tabs = useMemo<TraceDetailTab<Tab>[]>(() => {
    if (isBlocked) return [{ id: "summary", label: "Summary" }];
    const t: TraceDetailTab<Tab>[] = [
      { id: "transcript", label: "Chat" },
      { id: "changes", label: "Review changes" },
      { id: "summary", label: "Summary" },
    ];
    // "Match", not "Alignment": a reader wants to know whether the code did
    // what was asked. "Genuine record", not "Attestation": plain words for the
    // seal, and the Summary's pointer at it names a view that exists.
    if (showAlignment) t.push({ id: "alignment", label: "Match" });
    if (detail.canAttest) t.push({ id: "attestation", label: "Genuine record" });
    // "Workers", not "Sub-agents": who else worked on this, in the reader's
    // words rather than in terms of how the agent is built.
    if (workers.length > 0) t.push({ id: "subagents", label: "Workers", count: workers.length });
    return t;
  }, [isBlocked, showAlignment, detail.canAttest, workers.length]);
  // The view in force: the one picked while it still exists, else Chat when
  // there is a conversation to replay, else Summary.
  const tab: Tab =
    picked && tabs.some((t) => t.id === picked)
      ? picked
      : detail.hasTranscript && !isBlocked
        ? "transcript"
        : "summary";

  // Only fetch the Match report while its view is open — it shells out to the
  // CLI and the common open is Chat or Summary first.
  const {
    report: alignReport,
    loading: alignLoading,
    error: alignError,
  } = useSessionIntentReport(repoRoot, files, showAlignment && tab === "alignment");

  // Surgical "Bring this back" — one piece at a time, offered where you see
  // the change.
  const {
    state: bringBack,
    run: runBringBack,
    confirm: confirmBringBack,
    undo: undoBringBack,
    reset: resetBringBack,
    busySymbol,
  } = useBringBack(repoRoot);

  // Where the Summary's words came from — a stated reason, the person's own
  // prompt, or Aura's reading of the diff — so its heading never claims one
  // when it is another.
  const bodyLabel = provenanceLabel(detail.provenance);
  const bodyNote = provenanceNote(detail.provenance);

  // As a page: Esc goes back (unless something inside used it first, or the
  // reader is typing), and focus returns to the row that opened the run.
  useEffect(() => {
    if (!inline) return;
    const restore = captureFocus(document.activeElement, document.body);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isEditable(e.target)) return;
      e.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restore();
    };
  }, [inline, onBack]);

  const actions = (
    // Resume the conversation, or rewind one function or file this run
    // changed — never a blanket restore.
    <SessionActions
      repoRoot={repoRoot}
      sess={sess}
      managerSessionId={managerSessionId}
      managerLabel={title}
      files={files}
      symbolsByFile={detail.symbolsByFile}
      agentId={row.agent_id}
      worktree={row.worktree ?? null}
      onDismiss={onBack}
    />
  );
  const asideToggle = (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-pressed={asideOpen}
      aria-label={asideOpen ? "Hide run details" : "Show run details"}
      title={asideOpen ? "Hide run details" : "Show run details"}
      onClick={() => setAsideOpen((open) => !open)}
    >
      <PanelRight />
    </Button>
  );
  const crumb = (
    <span className="ui-trace-detail-crumb">
      <button type="button" className="ui-trace-crumb" onClick={onBack}>
        Trace
      </button>
      <ChevronRight aria-hidden />
      <span title={title}>{detail.shownHeadline}</span>
    </span>
  );

  const body =
    tab === "summary" ? (
      <SessionSummary
        row={row}
        repoRoot={repoRoot}
        files={files}
        symbols={detail.changedSymbols}
        bodyText={detail.statement}
        bodyLabel={bodyLabel}
        bodyNote={bodyNote}
        provenance={detail.provenance}
        whenAbsolute={detail.whenAbsolute}
        rel={detail.rel}
        alignment={detail.alignmentAvailability}
        onOpenFile={openFile}
        // Offered only when the view is there to open — an item whose action
        // goes nowhere is worse than one that says it can't be settled here.
        onOpenMatch={showAlignment ? () => setTab("alignment") : undefined}
      />
    ) : tab === "alignment" ? (
      <SessionAlignment
        repoRoot={repoRoot}
        report={alignReport}
        sessions={detail.sessions}
        loading={alignLoading}
        error={alignError}
        onDismiss={onBack}
      />
    ) : tab === "attestation" ? (
      <SessionAttestation
        repoRoot={repoRoot}
        blockId={row.signed_block_id ?? ""}
        keyId={row.key_id ?? null}
        intentType={row.intent_type ?? null}
      />
    ) : tab === "subagents" ? (
      <SessionSubagents runs={workers} />
    ) : tab === "transcript" ? (
      // A chat replays from its saved conversation; a Claude Code run from
      // its transcript file. Anything else has no step-by-step record.
      managerSessionId ? (
        <SessionTranscript filePath={managerSessionId} agentId={row.agent_id} source="manager" />
      ) : sess?.file_path ? (
        <SessionTranscript filePath={sess.file_path} agentId={row.agent_id} />
      ) : statedSessionId(row) ? (
        // The row names its conversation and the file is gone: the coding
        // agent clears its own history after a few weeks.
        <TraceNote title="The conversation is no longer on this computer">
          This run was a live chat, but the coding agent clears its own chat history after a
          few weeks and this one is past that. What it changed is still here — see Summary and
          Review changes.
        </TraceNote>
      ) : (
        <TraceNote title="No live conversation recorded">
          This entry was rebuilt from a commit, so there&apos;s no step-by-step record. Summary
          and Review changes show what it did.
        </TraceNote>
      )
    ) : files.length === 0 ? (
      <TraceNote title="No file changes recorded for this run." />
    ) : (
      <div className="ui-trace-detail-changes">
        <div className="ui-trace-detail-changes-view">
          <ChangesView
            // A file picked elsewhere opens fresh on that file.
            key={pendingFile ?? ""}
            repoRoot={repoRoot}
            files={files}
            initialSelected={pendingFile}
            onBringBack={runBringBack}
            busySymbol={busySymbol}
            renderReasons={renderReasons}
          />
        </div>
        {bringBack.kind !== "idle" ? (
          <div className="ui-trace-detail-changes-result">
            <BringBackResult
              state={bringBack}
              onConfirm={confirmBringBack}
              onUndo={undoBringBack}
              onDismiss={resetBringBack}
            />
          </div>
        ) : null}
      </div>
    );

  const layout = (
    <TraceDetail
      main={
        <>
          {inline && (
            <TraceHeader
              leading={
                <Button size="icon-sm" variant="ghost" aria-label="Back" title="Back (Esc)" onClick={onBack}>
                  <ArrowLeft />
                </Button>
              }
              title={crumb}
              actions={
                <>
                  {actions}
                  {asideToggle}
                </>
              }
            />
          )}
          <TraceDetailTabs
            label="Run views"
            tabs={tabs}
            value={tab}
            onChange={setTab}
            trailing={inline ? undefined : asideToggle}
          />
          <div className="ui-trace-detail-body">{body}</div>
        </>
      }
      aside={
        asideOpen ? (
          <SessionDetailAside
            row={row}
            detail={detail}
            selectedFile={tab === "changes" ? pendingFile : null}
            onOpenFile={openFile}
          />
        ) : null
      }
    />
  );

  if (inline) {
    return (
      <div className="ui-trace-detail-page" data-presentation="page">
        {layout}
      </div>
    );
  }
  return (
    <FullscreenOverlay onClose={onBack} tabs={crumb} actions={actions}>
      {layout}
    </FullscreenOverlay>
  );
}
