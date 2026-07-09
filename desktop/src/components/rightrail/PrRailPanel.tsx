// PrRailPanel — the PR triage Inbox, re-homed into the right rail (ADE).
//
// IA decision (docs/plan/22 §H): pull requests live in ONE place. The
// old center "All pull requests" view (InboxPane) and its left filter
// rail (InboxSidebar) collapse into this single narrow-rail panel:
//   • filter chips across the top  = the awaiting-review / mine / …
//     bucket views (the "filter views" the user asked to keep), and
//   • a compact scroll list below  = the PRs in the active bucket.
// Clicking a row opens the singleton PRDetailPane in the center via
// `editor.openPrDetail` (fromInbox stays false, so closing the detail
// doesn't try to pop back to a center inbox that no longer exists here).
//
// Data layer is shared with InboxPane through `prsCache`, so the two
// never double-fetch and a label/approve elsewhere repaints this list.

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { type PrSummary } from "../../lib/api";
import {
  fetchPrList,
  getPrListCached,
  invalidatePrList,
  subscribePrList,
} from "../../lib/prsCache";
import {
  bucketize,
  BUCKET_LABEL,
  BUCKET_DOT,
  BUCKET_ORDER,
  type Bucket,
} from "../workpanes/InboxPane";
import { useEditorStore } from "../../lib/editorStore";
import { GhErrorNotice } from "../github/GhErrorNotice";
import { sendToAmbientManager } from "../../lib/focusManager";
import { PR_FLOW_INITIAL, prFlowReduce, describePrFlowStage } from "../../lib/prFlowState";
import { PR_SKILLS, buildPrSkillPrompt, type PrSkillId } from "../../lib/prSkills";

// "all" is the implicit default chip; the rest mirror the Inbox buckets.
type Filter = "all" | Bucket;

export function PrRailPanel({ repoRoot }: { repoRoot: string }) {
  const editor = useEditorStore();
  const cached = getPrListCached(repoRoot);
  const [prs, setPrs] = useState<PrSummary[]>(cached ?? []);
  const [loading, setLoading] = useState(cached == null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const refresh = useCallback(
    async (force = false) => {
      if (getPrListCached(repoRoot) == null) setLoading(true);
      setError(null);
      try {
        const list = await (force
          ? invalidatePrList(repoRoot)
          : fetchPrList(repoRoot));
        setPrs(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [repoRoot],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => subscribePrList(repoRoot, (list) => setPrs(list)),
    [repoRoot],
  );

  const buckets = useMemo(() => bucketize(prs), [prs]);
  // Only surface chips that actually have PRs — an empty repo shows just
  // "All", not seven zero-count buckets.
  const activeChips = useMemo(
    () => BUCKET_ORDER.filter((b) => buckets[b].length > 0),
    [buckets],
  );

  const rows =
    filter === "all"
      ? [...prs].sort(
          (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
        )
      : buckets[filter];

  const selected =
    editor.selectedPr?.repoRoot === repoRoot ? editor.selectedPr.number : null;

  // Parity W8 — PR copilot. Skill buttons expand a prompt template (repo
  // override-able) and dispatch it into the project's ambient Manager chat.
  // The local reducer drives the observable subset of the PR flow protocol
  // (idle → collecting_context → drafting); once the brain has the prompt it
  // owns the rest, so we RESET. FAIL sticks with the error until dismissed.
  const [flow, dispatchFlow] = useReducer(prFlowReduce, PR_FLOW_INITIAL);
  const [copilotError, setCopilotError] = useState<string | null>(null);
  const copilotBusy = flow.stage !== "idle" && flow.stage !== "failed";

  const runSkill = useCallback(
    async (skillId: PrSkillId) => {
      const skill = PR_SKILLS.find((s) => s.id === skillId);
      if (!skill) return;
      setCopilotError(null);
      dispatchFlow({ type: "START" });
      try {
        const pr =
          selected != null ? (prs.find((p) => p.number === selected) ?? null) : null;
        const prompt = await buildPrSkillPrompt(
          repoRoot,
          skill,
          pr ? { prNumber: pr.number, title: pr.title, headRef: pr.head_ref } : {},
        );
        dispatchFlow({ type: "CONTEXT_READY" });
        await sendToAmbientManager(repoRoot, prompt);
        // Prompt delivered — the brain owns the flow from here.
        dispatchFlow({ type: "RESET" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatchFlow({ type: "FAIL", error: msg });
        setCopilotError(msg);
      }
    },
    [prs, repoRoot, selected],
  );

  return (
    <div className="h-full flex flex-col bg-bg-content">
      {/* Header */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-line-soft shrink-0">
        <span className="text-text-1 text-[12px] font-semibold">
          Pull requests
        </span>
        <span className="text-text-4 text-[11px] tabular-nums">
          {prs.length}
        </span>
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={loading}
          title="Refresh"
          className="ml-auto w-6 h-6 rounded-md text-text-4 hover:text-text-1 hover:bg-bg-2 flex items-center justify-center disabled:opacity-50"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path
              d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* Filter chips — the bucket "views" */}
      {activeChips.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2.5 py-2 border-b border-line-soft/60 shrink-0">
          <Chip
            label="All"
            count={prs.length}
            dot={null}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {activeChips.map((b) => (
            <Chip
              key={b}
              label={BUCKET_LABEL[b]}
              count={buckets[b].length}
              dot={BUCKET_DOT[b]}
              active={filter === b}
              onClick={() => setFilter(b)}
            />
          ))}
        </div>
      )}

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && prs.length === 0 ? (
          <Hint>Loading PRs…</Hint>
        ) : error ? (
          <GhErrorNotice error={error} onRetry={() => void refresh(true)} />
        ) : rows.length === 0 ? (
          <Hint>
            {filter === "all"
              ? "No open pull requests."
              : `Nothing in “${BUCKET_LABEL[filter]}”.`}
          </Hint>
        ) : (
          rows.map((p) => (
            <Row
              key={p.number}
              row={p}
              selected={p.number === selected}
              onSelect={() => editor.openPrDetail(repoRoot, p.number, p.title)}
            />
          ))
        )}
      </div>

      {/* Ask Aura — PR skills dispatched into the ambient Manager chat */}
      <div className="border-t border-line-soft px-2.5 py-2 shrink-0">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[10px] uppercase tracking-wide text-text-4 font-medium">
            Ask Aura about this PR
          </span>
          {copilotBusy && (
            <span className="text-[10px] text-text-3">
              {describePrFlowStage(flow.stage)}
            </span>
          )}
          <span className="ml-auto text-[10px] text-text-4 truncate">
            {selected != null ? `#${selected}` : "current branch"}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {PR_SKILLS.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={copilotBusy}
              title={s.summary}
              onClick={() => void runSkill(s.id)}
              className="px-2 py-1 rounded-md text-[11px] border border-line-soft text-text-2 hover:bg-bg-2 hover:text-text-1 transition-colors disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
        </div>
        {flow.stage === "failed" && copilotError && (
          <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-red-400">
            <span className="flex-1 break-words">{copilotError}</span>
            <button
              type="button"
              title="Dismiss"
              onClick={() => {
                setCopilotError(null);
                dispatchFlow({ type: "RESET" });
              }}
              className="shrink-0 text-text-4 hover:text-text-1"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({
  label,
  count,
  dot,
  active,
  onClick,
}: {
  label: string;
  count: number;
  dot: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors ${
        active
          ? "bg-bg-2 text-text-1"
          : "text-text-3 hover:bg-bg-2 hover:text-text-1"
      }`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
      <span className="truncate max-w-[120px]">{label}</span>
      <span className="text-text-4 tabular-nums">{count}</span>
    </button>
  );
}

function Row({
  row,
  selected,
  onSelect,
}: {
  row: PrSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const risk =
    row.aura_risk_score === null
      ? "bg-text-4/40"
      : row.aura_risk_score > 60
        ? "bg-red-500"
        : row.aura_risk_score > 0
          ? "bg-yellow-500"
          : "bg-green-500";
  const decisionTone =
    row.review_decision === "APPROVED"
      ? "text-green-400"
      : row.review_decision === "CHANGES_REQUESTED"
        ? "text-red-400"
        : "text-text-4";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 border-b border-line-soft/40 hover:bg-bg-2 transition-colors ${
        selected ? "bg-bg-2" : ""
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${risk}`} />
        <span className="text-[11px] text-text-4 tabular-nums shrink-0">
          #{row.number}
        </span>
        <span className="text-[12px] text-text-1 truncate">{row.title}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 pl-4 text-[11px] text-text-4 min-w-0">
        <span className="truncate">{row.author}</span>
        <span className="font-mono truncate text-text-4/80">
          {row.head_ref}
        </span>
        {row.review_decision && (
          <span className={`shrink-0 ${decisionTone}`}>
            {humanDecision(row.review_decision)}
          </span>
        )}
        {row.checks_state && (
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              row.checks_state === "success"
                ? "bg-green-500"
                : row.checks_state === "failure"
                  ? "bg-red-500"
                  : "bg-yellow-500"
            }`}
            title={`CI ${row.checks_state}`}
          />
        )}
        <span className="ml-auto tabular-nums shrink-0">
          <span className="text-green-400">+{row.additions}</span>
          <span className="text-text-4"> </span>
          <span className="text-red-400">−{row.deletions}</span>
        </span>
      </div>
    </button>
  );
}

function humanDecision(d: string): string {
  return d
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-text-4 text-[12px] px-3 py-3 leading-relaxed">
      {children}
    </div>
  );
}
