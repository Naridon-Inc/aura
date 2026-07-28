// SessionDetailPane — the calm "session detail" view for the redesigned
// Trace section, modeled on entire.io's unit-of-work detail page.
//
// Opened by clicking a row in SessionsPane. The spine is the `IntentRow`
// passed in as a prop. We additionally best-effort fetch the real Claude
// Code sessions so a guard `[auto]` placeholder row can show the agent's
// actual prompt + turn count instead of a junk title (see sessionMeta), and
// we lazily load a real working-tree diff per file in the Changes tab. No
// mock data, no fabricated verdicts: a signed_block_id surfaces an
// understated "Signed" lock chip, never a pass/fail judgement.
//
// Tabs run through the shared WizardStepTabs (variant="tabs"), so the session
// header reads identically to TaskDetailPane / PRDetailPane. The tab set is
// STABLE — Summary · Transcript · Changes in a fixed order every time, so the
// header never reshuffles between rows. Transcript shows the live conversation
// when one was recorded, otherwise an honest empty state (e.g. an entry
// reconstructed from a commit). Changes carries the live file count. Real data
// only: no mock tabs, no fabricated verdicts.

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  api,
  type ClaudeSession,
  type IntentRow,
  type IntentChangeset,
  type IntentChangesetFile,
} from "../../lib/api";
import { AgentBadge } from "../agent/AgentBadge";
import { InlineEntities, splitIntent } from "./IntentProse";
import { SessionSummary } from "./SessionSummary";
import { SessionActions } from "./SessionActions";
import {
  useChangesetSymbols,
  useChangesetSymbolsByFile,
} from "./useChangesetSymbols";
import { ChangesView } from "./ChangesView";
import { useBringBack, BringBackResult } from "./useBringBack";
import { SessionAttestation } from "./SessionAttestation";
import { SessionTranscript } from "./SessionTranscript";
import { WizardStepTabs, type WizardStepMeta } from "../ui/wizard";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { useSessionIntentReport } from "./IntentStory";
import { SessionAlignment } from "./SessionAlignment";
import { TRACE_IA_V3 } from "../../lib/featureFlags";
import { peekCache, writeCache } from "../../lib/resourceCache";
import {
  correlateClaudeSession,
  isAutoStub,
  sessionDisplayTitle,
} from "../../lib/sessionMeta";

/** Relative time from a "seconds ago" delta — "just now", "2h", "3d". */
function relTime(secsAgo: number): string {
  if (!Number.isFinite(secsAgo) || secsAgo < 0) return "just now";
  if (secsAgo < 45) return "just now";
  const mins = Math.floor(secsAgo / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(secsAgo / 3600);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(secsAgo / 86400);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Sum additions/deletions across a set of changeset files (null → 0). */
function churnOf(files: IntentChangesetFile[]): {
  files: number;
  adds: number;
  dels: number;
  hasChurn: boolean;
} {
  let adds = 0;
  let dels = 0;
  let sawAny = false;
  for (const f of files) {
    if (typeof f.additions === "number") {
      adds += f.additions;
      sawAny = true;
    }
    if (typeof f.deletions === "number") {
      dels += f.deletions;
      sawAny = true;
    }
  }
  return { files: files.length, adds, dels, hasChurn: sawAny };
}

function LockIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

type Tab = "summary" | "alignment" | "attestation" | "transcript" | "changes";

// Tab-strip glyphs — small currentColor icons so WizardStepTabs can tint them
// accent-when-active / text-4-when-idle like every other detail header.
function SummaryGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path
        d="M3.5 3.5h8M3.5 6h8M3.5 8.5h5.5M3.5 11h8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
function TranscriptGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path
        d="M2.5 4.2a1.5 1.5 0 011.5-1.5h7a1.5 1.5 0 011.5 1.5v4a1.5 1.5 0 01-1.5 1.5H6.2L3.5 12V9.7H4a1.5 1.5 0 01-1.5-1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ChangesGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M4 2.5v6M4 8.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 12.5v-6M11 6.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 6.5c0 2-2 2.5-4.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
// Two arrows meeting at a check — "did the code match the ask?".
function AlignmentGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M2.5 4.5h6l-1.6-1.6M12.5 10.5h-6l1.6 1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 7.6l1.4 1.4 2.4-2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
// A shield with a check — the run's cryptographic proof.
function AttestationGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M7.5 2l4 1.5v3.2c0 2.6-1.7 4.6-4 5.8-2.3-1.2-4-3.2-4-5.8V3.5L7.5 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5.6 7.4l1.4 1.4 2.6-2.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Static tab metas; the visible set + the Changes count are assembled per
// render from real session data (see the `tabs` memo).
const SUMMARY_TAB: WizardStepMeta = {
  id: "summary",
  label: "Summary",
  icon: <SummaryGlyph />,
};
const TRANSCRIPT_TAB: WizardStepMeta = {
  id: "transcript",
  label: "Transcript",
  icon: <TranscriptGlyph />,
};
const CHANGES_TAB: WizardStepMeta = {
  id: "changes",
  label: "Changes",
  icon: <ChangesGlyph />,
};
const ALIGNMENT_TAB: WizardStepMeta = {
  id: "alignment",
  // "Match" not "Alignment": a non-engineer wants to know "did the code do what
  // I asked?", not parse an abstract noun. The tab id stays `alignment`.
  label: "Match",
  icon: <AlignmentGlyph />,
};
const ATTESTATION_TAB: WizardStepMeta = {
  id: "attestation",
  // "Genuine record" not "Attestation": plain language for the tamper-proof
  // seal, and it makes the Summary's "…on the Genuine record tab" line point at
  // a tab that actually exists. The tab id stays `attestation`.
  label: "Genuine record",
  icon: <AttestationGlyph />,
};

export function SessionDetailPane({
  repoRoot,
  row,
  onBack,
}: {
  repoRoot: string;
  row: IntentRow;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<Tab>("summary");
  // When the reader clicks a changed-file entity in the Summary (a file pill in
  // the intent prose, or a row in "Files changed"), we jump to Changes and ask
  // it to open that file. null = just switch tabs (e.g. "Open in Changes →").
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  // Best-effort Claude sessions — used to relabel a guard `[auto]` row with
  // the agent's real prompt + turn count. Absence never breaks the view.
  // Seeded from the process-lifetime cache so re-opening a session (or opening
  // several in a row) paints the correlated title/turns immediately instead of
  // re-shelling `claude list-sessions` on every mount; the effect revalidates.
  const [sessions, setSessions] = useState<ClaudeSession[]>(
    () => peekCache<ClaudeSession[]>(`sessions:claude:${repoRoot}`) ?? [],
  );
  // A native Aura chat row carries no intent-log changeset (the session edits
  // the working tree and never commits), so the Changes tab would otherwise be
  // empty. This holds its computed changeset — the files it edited + each
  // file's diff vs the session's start baseline — fetched below. null for a
  // non-chat row or an orchestrator-only session (which edited nothing here).
  const [mgrChangeset, setMgrChangeset] = useState<IntentChangeset | null>(() => {
    const sid = (row.manager_session_id ?? "").trim();
    return sid
      ? peekCache<IntentChangeset>(`mgrChangeset:${repoRoot}:${sid}`) ?? null
      : null;
  });

  const openFile = (path?: string) => {
    setPendingFile(path ?? null);
    setTab("changes");
  };

  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    // Stale-while-revalidate: paint the cached session list first (already
    // seeded into state), refresh underneath, and never let a failed refresh
    // blank a list we already have.
    const key = `sessions:claude:${repoRoot}`;
    const cached = peekCache<ClaudeSession[]>(key);
    if (cached) setSessions(cached);
    api
      .claudeListSessions(repoRoot)
      .then((s) => {
        const list = Array.isArray(s) ? s : [];
        writeCache(key, list);
        if (alive) setSessions(list);
      })
      .catch(() => {
        // A failed revalidation must not wipe a cached roster.
        if (alive && !cached) setSessions([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // Native Aura chat rows: pull the session's own changeset so the Changes tab
  // shows the files it edited and their diffs. A normal intent row skips this
  // (it already carries `row.changeset`); a chat row that orchestrated without
  // editing comes back empty, which is honest — its changes live in the child
  // agent sessions, not here.
  useEffect(() => {
    const sid = (row.manager_session_id ?? "").trim();
    if (!repoRoot || !sid) {
      setMgrChangeset(null);
      return;
    }
    let alive = true;
    // Stale-while-revalidate per manager session: paint the last-known
    // changeset instantly, refresh underneath, and keep the cached one if the
    // refresh fails.
    const key = `mgrChangeset:${repoRoot}:${sid}`;
    const cached = peekCache<IntentChangeset>(key);
    if (cached) setMgrChangeset(cached);
    api
      .managerSessionChangeset(repoRoot, sid)
      .then((cs) => {
        const val = cs ?? null;
        if (val) writeCache(key, val);
        if (alive) setMgrChangeset(val);
      })
      .catch(() => {
        if (alive && !cached) setMgrChangeset(null);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, row.manager_session_id]);

  // Captured once per render so the header chip and the Summary "When" row
  // compute their relative time from the same clock.
  const nowSecs = useMemo(() => Math.floor(Date.now() / 1000), []);
  const rel = relTime(nowSecs - row.timestamp);

  // A genuine intent row carries its own changeset; a native Aura chat row has
  // none and borrows the fetched session changeset instead. Everything
  // downstream (Changes tab, churn chips, file count, Alignment sha) reads this
  // unified value so both kinds of session render the same way.
  const changeset = row.changeset ?? mgrChangeset;
  const files = changeset?.files ?? [];
  const churn = churnOf(files);
  const fileCount = files.length;
  // Changed-symbol names (functions / types from this run's AST change-note),
  // so the headline + Summary prose chip `traceFieldsForRef` not just file
  // names. Best-effort: empty until/unless the commits' notes resolve.
  const changedSymbols = useChangesetSymbols(repoRoot, files);
  // Same change-note source, but keyed by file so the Rewind menu can offer a
  // surgical per-function revert (identifier + file together).
  const symbolsByFile = useChangesetSymbolsByFile(repoRoot, files);
  // Surgical "Bring this back" — the Time machine's recovery verb, folded into
  // the Changes tab so undo lives where you SEE the change. One per piece.
  const {
    state: bringBack,
    run: runBringBack,
    reset: resetBringBack,
    busySymbol,
  } = useBringBack(repoRoot);
  const signed = !!row.signed_block_id;
  const hasChangeset = !!changeset;
  // Set only on a synthetic row minted from a native Aura chat (manager)
  // session — drives the Transcript tab to replay the persisted chat via
  // `managerLoadTranscript` rather than a Claude JSONL file read.
  const managerSessionId = (row.manager_session_id ?? "").trim() || null;

  // A blocked/halted guard record (see the Sessions feed's block convention):
  // an attempt Aura refused to let land. It has no transcript, no changeset, and
  // nothing to resume or prove — it renders as its own short "here's what was
  // stopped" report, not the normal asked→built→prove session.
  const isBlocked = row.intent_type === "blocked";

  // Correlated real session (when this row is an agent run we can match to a
  // Claude Code session by time). Drives the real title, "Asked", and turns.
  // A native Aura chat row has its OWN transcript (replayed by id), so it must
  // never borrow a time-nearby Claude session — that would paint a wrong turn
  // count and a wrong Resume target. A blocked record has no session at all, so
  // it must NOT borrow the nearest transcript by time either (that false match
  // is what made a block read a bogus "21 steps · Resume"). Skip correlation
  // entirely for both.
  const sess = useMemo(
    () =>
      managerSessionId || isBlocked
        ? null
        : correlateClaudeSession(row, sessions),
    [managerSessionId, isBlocked, row, sessions],
  );
  const title = sessionDisplayTitle(row, sessions);
  // Identity (headline + summary body) is the row's OWN logged intent for a
  // genuine intent row, and it must stay STABLE when the async Claude-session
  // correlation resolves a render later — it must never swap a clean intent
  // title for the raw first prompt mid-view (the "it became something else with
  // no intervention" flip). Only a guard auto-stub — a junk `[auto]` row with
  // no real intent of its own — borrows the correlated session's prompt as its
  // headline. The correlation still layers in turn count / Resume / Transcript
  // additively for every row; those pop in, but the title + prose don't move.
  const asked = isAutoStub(row) ? sess?.first_prompt || title : row.intent;

  // Headline / body split so the header carries a tight title and the Summary
  // body carries the elaboration — the same text never prints twice. Both render
  // through the entity-aware renderers (code chips + clickable changed files).
  const { headline, body } = useMemo(() => splitIntent(asked), [asked]);
  const bodyLabel = isAutoStub(row) && sess?.first_prompt ? "Prompt" : "Reason";

  // The session's own commit sha (first changeset file that carries one) — this
  // is the durable key that lets the Alignment tab pull the asked→said→did→
  // verdict report for THIS run. Uncommitted / working-tree runs have none, so
  // the Alignment tab simply doesn't appear (there's no committed change to
  // judge yet). See [[Trace IA v3]] — the verdict lives on the run it judges.
  const alignmentSha = useMemo(() => {
    for (const f of files) {
      const c = (f.commit ?? "").trim();
      if (c) return c;
    }
    return null;
  }, [files]);
  const showAlignment = TRACE_IA_V3 && !!alignmentSha;

  // Only fetch the alignment report while its tab is active — keeps the CLI
  // call off the critical path for the common Summary-first open. Aggregates
  // every commit in the run's changeset (not just the first sha) so "what
  // changed" reflects the whole run, matching the Changes tab's file scope.
  const {
    report: alignReport,
    loading: alignLoading,
    error: alignError,
  } = useSessionIntentReport(repoRoot, files, showAlignment && tab === "alignment");

  // Tab set, assembled left-to-right in a stable order so the header never
  // reshuffles between rows: Summary · [Alignment] · [Attestation] · Changes ·
  // Transcript. Alignment folds in when the IA-v3 consolidation is on AND there
  // is a committed change to judge (the former standalone Intent↔AST page);
  // Attestation folds in when the run is signed (the former standalone
  // Attestations dialog) so the run's cryptographic proof rides on the run
  // itself. Both are additive — a plain unsigned, uncommitted run still reads
  // Summary · Changes · Transcript.
  const tabs = useMemo<WizardStepMeta[]>(() => {
    // A blocked record is a single short report — no transcript, no changeset,
    // no alignment/attestation. Only the Summary applies.
    if (isBlocked) return [SUMMARY_TAB];
    const t: WizardStepMeta[] = [SUMMARY_TAB];
    if (showAlignment) t.push(ALIGNMENT_TAB);
    if (signed) t.push(ATTESTATION_TAB);
    t.push({ ...CHANGES_TAB, label: `Changes · ${fileCount}` });
    t.push(TRANSCRIPT_TAB);
    return t;
  }, [isBlocked, fileCount, showAlignment, signed]);
  const tabIds = useMemo(() => tabs.map((t) => t.id) as Tab[], [tabs]);

  // Defensive: if the active tab ever leaves the set, fall back to Summary so
  // the strip and body can never disagree.
  useEffect(() => {
    if (!tabIds.includes(tab)) setTab("summary");
  }, [tabIds, tab]);

  const whenAbsolute = useMemo(() => {
    const d = new Date(row.timestamp * 1000);
    // toLocaleString can throw on a NaN/invalid date in some engines; guard.
    const s = d.toLocaleString();
    return s === "Invalid Date" ? "—" : s;
  }, [row.timestamp]);

  // Depth chips — the honest measure of a run. A person sends a few
  // *messages*; the agent then takes many *steps* (reading, editing, running
  // commands) to answer each. Counting only the typed prompts made a deep
  // one-prompt session read a misleading "1 turn", so we lead with the agent's
  // step count and only add the message count when the human steered more than
  // once. Falls back to the old turn label for sessions scanned before steps
  // were tracked (step_count === 0 but a prompt exists).
  const depthChips = useMemo(() => {
    if (!sess) return [] as string[];
    const chips: string[] = [];
    if (sess.turn_count > 1) chips.push(`${sess.turn_count} messages`);
    if (sess.step_count > 0) {
      chips.push(`${sess.step_count} step${sess.step_count === 1 ? "" : "s"}`);
    } else if (sess.turn_count === 1) {
      chips.push("1 turn");
    }
    return chips;
  }, [sess]);

  return (
    <FullscreenOverlay
      onClose={onBack}
      tabs={
        <WizardStepTabs
          variant="tabs"
          steps={tabs}
          index={Math.max(0, tabIds.indexOf(tab))}
          onJump={(i) => setTab(tabIds[i])}
        />
      }
      actions={
        // Resume the live Claude session, or surgically rewind one function /
        // file this run changed (not a blanket restore). Lives in the wizard
        // header button slot so it never eats the body's scroll height.
        <SessionActions
          repoRoot={repoRoot}
          sess={sess}
          managerSessionId={managerSessionId}
          managerLabel={title}
          files={files}
          symbolsByFile={symbolsByFile}
          onDismiss={onBack}
        />
      }
    >
      {/* Session header — title + rollup chips, sitting directly under the
          overlay's full-bleed wizard tab bar (the same shell the task / PR
          detail wizards use, so a session opens as a proper focus surface
          rather than tabs floating inside the workpane). */}
      <div className="shrink-0 border-b border-line-soft px-6 pb-3.5 pt-4">
        {/* Headline — a tight, single-thought title. Code entities render as
            chips and changed-file names become clickable pills (jump to
            Changes). Clamped to ~2 lines so a long first sentence can't push
            the chips off-screen. */}
        <h1
          className="text-[17px] font-semibold leading-snug text-text-1"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
          title={title}
        >
          <InlineEntities
            text={headline || title}
            files={files}
            symbols={changedSymbols}
            onOpenFile={openFile}
          />
        </h1>

        {/* Rollup chips */}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-3">
          <AgentBadge agentId={row.agent_id} />
          <span className="text-text-4">·</span>
          <span className="text-text-4">{rel}</span>
          {depthChips.map((c) => (
            <Fragment key={c}>
              <span className="text-text-4">·</span>
              <span>{c}</span>
            </Fragment>
          ))}
          {hasChangeset ? (
            <>
              <span className="text-text-4">·</span>
              <span>
                {fileCount} {fileCount === 1 ? "file" : "files"}
              </span>
              {churn.hasChurn ? (
                <span className="font-mono text-[10px]">
                  <span className="text-accent-green">+{churn.adds}</span>
                  <span className="text-text-4"> / </span>
                  <span className="text-text-3">−{churn.dels}</span>
                </span>
              ) : null}
            </>
          ) : null}
          {row.intent_type === "blocked" ? (
            <>
              <span className="text-text-4">·</span>
              <span className="rounded border border-red px-1.5 py-px text-[10px] font-medium text-red">
                Blocked
              </span>
            </>
          ) : row.intent_type ? (
            <>
              <span className="text-text-4">·</span>
              <span className="rounded border border-line-soft px-1.5 py-px text-[10px] text-text-4">
                {row.intent_type}
              </span>
            </>
          ) : null}
          {signed ? (
            <>
              <span className="text-text-4">·</span>
              <span
                className="flex items-center gap-1 text-text-3"
                title={row.key_id ? `Signed with key ${row.key_id}` : "Signed"}
              >
                <LockIcon />
                <span className="text-[10px]">Signed</span>
              </span>
            </>
          ) : null}
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────── */}
      {/* overflow-hidden so the Changes two-pane can own its own column
          scroll; Summary re-introduces its own vertical scroll inside. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "summary" ? (
          <SessionSummary
            row={row}
            repoRoot={repoRoot}
            files={files}
            symbols={changedSymbols}
            bodyText={body}
            bodyLabel={bodyLabel}
            whenAbsolute={whenAbsolute}
            rel={rel}
            onOpenFile={openFile}
          />
        ) : tab === "alignment" ? (
          // Does this run's committed change match what was asked? Rebuilt in
          // the session-detail language (verdict hero + spec cards) so it reads
          // as one card with Summary/Attestation, not the standalone Intent↔AST
          // page's numbered-rail story.
          <SessionAlignment
            repoRoot={repoRoot}
            report={alignReport}
            sessions={sessions}
            loading={alignLoading}
            error={alignError}
            onDismiss={onBack}
          />
        ) : tab === "attestation" ? (
          // This run's cryptographic proof — the former standalone Attestations
          // dialog, now native to the run it signs, in the session-detail
          // spec-sheet language. Guarded to the signed case by the tab set.
          <SessionAttestation
            repoRoot={repoRoot}
            blockId={row.signed_block_id ?? ""}
            keyId={row.key_id ?? null}
            intentType={row.intent_type ?? null}
          />
        ) : tab === "transcript" ? (
          // A native Aura chat (manager) row carries no Claude JSONL — replay
          // it from its persisted session instead. Claude rows replay from the
          // correlated JSONL `file_path`. Anything else (a commit-reconstructed
          // entry) has no step-by-step record, so we say so plainly.
          managerSessionId ? (
            <SessionTranscript
              filePath={managerSessionId}
              agentId={row.agent_id}
              source="manager"
            />
          ) : sess?.file_path ? (
            <SessionTranscript filePath={sess.file_path} agentId={row.agent_id} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
              <span className="text-[13px] text-text-2">
                No live conversation recorded
              </span>
              <span className="max-w-[320px] text-[12px] leading-relaxed text-text-4">
                This entry was reconstructed from a commit, so there's no
                step-by-step transcript. The Summary and Changes tabs show what
                it did.
              </span>
            </div>
          )
        ) : files.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <span className="text-[12px] text-text-3">
              No file changes recorded for this run.
            </span>
          </div>
        ) : (
          // The diff, with surgical per-piece undo wired in (folds the Time
          // machine's recovery into the place you actually see the change). The
          // result banner pins below the diff only while a bring-back is in
          // flight or just landed.
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <ChangesView
                repoRoot={repoRoot}
                files={files}
                initialSelected={pendingFile}
                onBringBack={runBringBack}
                busySymbol={busySymbol}
              />
            </div>
            {bringBack.kind !== "idle" ? (
              <div className="shrink-0 border-t border-line-soft px-3 pb-3">
                <BringBackResult state={bringBack} onDismiss={resetBringBack} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </FullscreenOverlay>
  );
}
