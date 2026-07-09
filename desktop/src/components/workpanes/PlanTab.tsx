// PlanTab — Cursor-parity rich plan surface. Renders the full plan
// envelope the Manager brain shipped via `aura propose-plan --json`:
// objective, baseline (markdown), architecture (mermaid), numbered
// implementation phases with clickable file refs, deliverables, tests,
// and the todos checkbox list.
//
// Plans flow: Manager brain runs `aura propose-plan` →
// ManagerChatView's PlanCard renders a condensed inline card and
// auto-opens this tab. The snapshot keeps rendering even after the
// originating session resolves the plan (build/cancel) — Cursor parity.
// Plans are session-only; sanitizeRefForPersist drops them so a shell
// restart does not resurrect stale plans.
//
// Mermaid is lazy-imported so the ~3MB graph engine never enters the
// initial bundle. If the import or render fails (bad syntax, etc.) we
// degrade gracefully to the raw graph source in a code block.
//
// File ref chips call `editor.open(absPath)` — the resolution joins
// each `fileRefs` entry against `plan.repoRoot`. We intentionally do
// not pre-validate existence; the open call already swallows missing
// files via WorkSurface's error boundary.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileText, ListChecks } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type PlanTabData, useEditorStore } from "../../lib/editorStore";
import { focusAmbientManager } from "../../lib/focusManager";
import { useManagerSession } from "../../lib/managerStore";
import { AgentIcon } from "../agent/AgentIcon";
import { MermaidDiagram } from "../notes/MermaidDiagram";
import { WizardStepTabs } from "../ui/wizard";
import { api, type AgentDescriptor, type PlanParallelism } from "../../lib/api";

export function PlanTab({ plan }: { plan: PlanTabData }) {
  const store = useEditorStore();
  const sessionId = plan.sessionId ?? null;
  // Tabbed plan view: a Document tab (the plan write-up) and a Tasks
  // tab (the todo checklist). The header above the strip is shared
  // chrome and stays pinned across both tabs.
  const [tab, setTab] = useState(0);
  // Live session lookup so the action bar visibility tracks the brain's
  // pending_plan state instead of the (potentially stale) tab snapshot.
  // The brain clears pending_plan on Build / Cancel; once that happens
  // the action bar disappears even though the tab keeps rendering the
  // plan content as a frozen snapshot.
  const liveSession = useManagerSession(sessionId);
  const isAwaitingDecision =
    !!liveSession?.pending_plan && liveSession.pending_plan.id === plan.id;

  const onToggle = useCallback(
    (idx: number) => {
      store.togglePlanTodo(plan.id, idx);
    },
    [store, plan.id],
  );

  // Chat-first: "open session" now flips the right-rail Aura panel to the
  // owning Manager session instead of opening a workspace tab.
  const onOpenSession = useCallback(() => {
    if (sessionId && plan.repoRoot) focusAmbientManager(plan.repoRoot, sessionId);
  }, [sessionId, plan.repoRoot]);

  const onOpenFile = useCallback(
    async (relOrAbs: string) => {
      const abs = resolveRef(relOrAbs, plan.repoRoot);
      if (!abs) return;
      try {
        await store.open(abs);
      } catch {
        // best-effort — missing file silently no-ops
      }
    },
    [store, plan.repoRoot],
  );

  // A plan ships with just a title when the brain emits a stub (no
  // phases, no architecture, no deliverables, no tests, no todos, no
  // baseline). Rendering empty headings under that title looks like a
  // broken page; show a branded AURA hero instead so the surface feels
  // intentional. The user can return to chat (where the plan was
  // proposed) via the "Open chat" button.
  if (isPlanEmpty(plan)) {
    return (
      <PlanEmptyState
        title={plan.title}
        onOpenChat={sessionId ? onOpenSession : null}
      />
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg-content overflow-hidden text-fg-strong min-h-0">
      {/* Pinned chrome — the header and tab strip stay fixed above the
          scroll region so they're always visible regardless of tab. */}
      <div className="flex-shrink-0">
        <div className="max-w-[760px] mx-auto px-5 pt-4 pb-3">
          <PlanHeader
            title={plan.title || "Untitled plan"}
            sessionId={sessionId}
            planId={plan.id}
            isAwaitingDecision={isAwaitingDecision}
            initialParallelism={
              (liveSession?.pending_plan?.parallelism ?? "auto") as PlanParallelism
            }
          />
        </div>
        <WizardStepTabs
          steps={PLAN_TAB_STEPS}
          index={tab}
          onJump={setTab}
          variant="tabs"
        />
      </div>

      {/* Only the active tab's content scrolls. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-5 py-4 flex flex-col gap-5">
          {tab === 0 ? (
            <PlanDocumentBody plan={plan} onOpenFile={onOpenFile} />
          ) : (
            <PlanTasksBody
              plan={plan}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onOpenSession={onOpenSession}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// The Document / Tasks step strip — shared by the PlanTab workpane and
// the fullscreen PlanWizard so both surfaces carry the exact same tabs.
export const PLAN_TAB_STEPS = [
  { id: "document", label: "Document", icon: <FileText size={14} /> },
  { id: "tasks", label: "Tasks", icon: <ListChecks size={14} /> },
];

// True when the plan has no body content beyond a title — the brain
// occasionally emits a stub envelope while queueing a follow-up turn.
// Both surfaces fall back to the branded PlanEmptyState in that case.
export function isPlanEmpty(plan: PlanTabData): boolean {
  const lead = (plan.objective?.trim() || plan.summary || "").trim();
  return (
    !lead &&
    !plan.baseline?.trim() &&
    !plan.architectureMermaid?.trim() &&
    (plan.phases?.length ?? 0) === 0 &&
    (plan.deliverables?.length ?? 0) === 0 &&
    (plan.tests?.length ?? 0) === 0 &&
    plan.todos.length === 0
  );
}

// ── Reusable tab bodies ─────────────────────────────────────────────
//
// The plan write-up and the task breakdown are extracted so the
// fullscreen PlanWizard renders them identically to the workpane tab —
// one renderer, two surfaces. Both take a resolved `onOpenFile` so the
// caller decides what "open a file ref" means (PlanTab opens a workpane
// tab; the wizard closes itself first, then opens the file behind it).

// The Document tab: objective lead, current baseline (markdown),
// proposed architecture (mermaid), numbered implementation phases with
// clickable file refs, deliverables, and tests.
export function PlanDocumentBody({
  plan,
  onOpenFile,
}: {
  plan: PlanTabData;
  onOpenFile: (ref: string) => void;
}) {
  const lead = (plan.objective?.trim() || plan.summary || "").trim();
  const phases = plan.phases ?? [];
  const deliverables = plan.deliverables ?? [];
  const tests = plan.tests ?? [];
  const hasArchitecture = !!plan.architectureMermaid?.trim();
  const hasBaseline = !!plan.baseline?.trim();

  return (
    <>
      {lead && (
        <p
          className="whitespace-pre-wrap"
          style={{
            color: "var(--color-text-2)",
            fontSize: "14px",
            lineHeight: 1.6,
          }}
        >
          {lead}
        </p>
      )}

      {hasBaseline && (
        <PlanSection title="Current baseline">
          <div className="plan-prose">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {plan.baseline as string}
            </ReactMarkdown>
          </div>
        </PlanSection>
      )}

      {hasArchitecture && (
        <PlanSection title="Proposed architecture">
          <MermaidDiagram code={plan.architectureMermaid as string} />
        </PlanSection>
      )}

      {phases.length > 0 && (
        <PlanSection title="Implementation plan">
          <ol className="flex flex-col gap-3">
            {phases.map((phase, i) => (
              <li key={`${i}-${phase.title}`} className="flex gap-3">
                <PhaseNumber n={i + 1} />
                <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                  <div className="t-base t-heading text-text-1">
                    {phase.title}
                  </div>
                  {phase.body && (
                    <div className="plan-prose" style={{ color: "var(--color-text-2)" }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {phase.body}
                      </ReactMarkdown>
                    </div>
                  )}
                  {phase.fileRefs && phase.fileRefs.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-0.5">
                      {phase.fileRefs.map((ref) => (
                        <FileRefChip
                          key={ref}
                          path={ref}
                          onClick={() => onOpenFile(ref)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </PlanSection>
      )}

      {deliverables.length > 0 && (
        <PlanSection title="Deliverables">
          <ul
            className="flex flex-col gap-1 t-base"
            style={{ color: "var(--color-text-1)" }}
          >
            {deliverables.map((d, i) => (
              <li key={i} className="flex gap-2">
                <span
                  style={{ color: "var(--color-text-3)" }}
                  className="select-none"
                >
                  ·
                </span>
                <span className="flex-1">{d}</span>
              </li>
            ))}
          </ul>
        </PlanSection>
      )}

      {tests.length > 0 && (
        <PlanSection title="Tests">
          <ul
            className="flex flex-col gap-1 t-base"
            style={{ color: "var(--color-text-1)" }}
          >
            {tests.map((t, i) => (
              <li key={i} className="flex gap-2">
                <span
                  style={{ color: "var(--color-text-3)" }}
                  className="select-none"
                >
                  ·
                </span>
                <span className="flex-1">{t}</span>
              </li>
            ))}
          </ul>
        </PlanSection>
      )}
    </>
  );
}

// The Tasks tab: the todo checklist (checkbox, file refs, agent badge,
// assignee, skill-routing override) plus the "referenced by" jump-back
// to the originating Manager session.
export function PlanTasksBody({
  plan,
  onToggle,
  onOpenFile,
  onOpenSession,
}: {
  plan: PlanTabData;
  onToggle: (idx: number) => void;
  onOpenFile: (ref: string) => void;
  onOpenSession: () => void;
}) {
  const sessionId = plan.sessionId ?? null;
  return (
    <>
      <section className="flex flex-col gap-2">
        <div className="t-sm t-ui" style={{ color: "var(--color-text-3)" }}>
          {plan.todos.length} {plan.todos.length === 1 ? "Task" : "Tasks"}
        </div>
        <div
          style={{
            height: 1,
            background: "var(--color-line-soft)",
          }}
        />
        {plan.todos.length === 0 ? (
          <div
            className="t-sm italic py-1"
            style={{ color: "var(--color-text-4)" }}
          >
            No tasks in this plan.
          </div>
        ) : (
          <ul className="flex flex-col">
            {plan.todos.map((todo, i) => (
              <li
                key={`${i}-${todo.description}`}
                className="flex items-start gap-2.5 py-1.5 -mx-2 px-2 rounded group hover:bg-[var(--color-bg-2)] transition-colors"
              >
                <button
                  type="button"
                  onClick={() => onToggle(i)}
                  className="mt-[3px] flex items-center justify-center flex-shrink-0 transition-colors"
                  title={todo.done ? "Mark not done" : "Mark done"}
                >
                  {todo.done ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="7" fill="var(--color-text-3)" />
                      <path
                        d="M4.5 8l2.5 2.5 5-5"
                        stroke="var(--color-bg-deep)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <div
                      className="w-[14px] h-[14px] rounded-full border-[1.5px] transition-colors"
                      style={{ borderColor: "var(--color-text-4)" }}
                    />
                  )}
                </button>
                <div className="flex-1 flex flex-col gap-1 min-w-0">
                  <div
                    className={`t-md ${todo.done ? "line-through" : ""}`}
                    style={{
                      color: todo.done
                        ? "var(--color-text-4)"
                        : "var(--color-text-1)",
                    }}
                  >
                    {todo.description}
                  </div>
                  {todo.fileRefs && todo.fileRefs.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {todo.fileRefs.map((ref) => (
                        <FileRefChip
                          key={ref}
                          path={ref}
                          onClick={() => onOpenFile(ref)}
                        />
                      ))}
                    </div>
                  )}
                  {todo.goal && (
                    <div
                      className="t-xs t-ui flex items-baseline gap-1"
                      style={{ color: "var(--color-text-3)" }}
                    >
                      <span style={{ color: "var(--color-text-4)" }}>
                        Done when
                      </span>
                      <span>{todo.goal}</span>
                    </div>
                  )}
                  {todo.acceptance && todo.acceptance.length > 0 && (
                    <VerifyList checks={todo.acceptance} />
                  )}
                  {todo.subtasks && todo.subtasks.length > 0 && (
                    <ul
                      className="flex flex-col gap-1.5 mt-1 pl-2.5 border-l"
                      style={{ borderColor: "var(--color-border-1)" }}
                    >
                      {todo.subtasks.map((sub, si) => (
                        <li
                          key={`${si}-${sub.description}`}
                          className="flex flex-col gap-1 min-w-0"
                        >
                          <div className="flex items-baseline gap-1.5 min-w-0">
                            <span
                              className="t-sm flex-1 min-w-0"
                              style={{ color: "var(--color-text-2)" }}
                            >
                              {sub.description}
                            </span>
                            {sub.agent && (
                              <span
                                className="flex items-center gap-1 t-xs t-ui flex-shrink-0"
                                style={{ color: "var(--color-text-3)" }}
                                title={sub.agent}
                              >
                                <AgentIcon agentId={sub.agent} size={11} />
                              </span>
                            )}
                          </div>
                          {sub.goal && (
                            <div
                              className="t-xs t-ui flex items-baseline gap-1"
                              style={{ color: "var(--color-text-3)" }}
                            >
                              <span style={{ color: "var(--color-text-4)" }}>
                                Done when
                              </span>
                              <span>{sub.goal}</span>
                            </div>
                          )}
                          {sub.acceptance && sub.acceptance.length > 0 && (
                            <VerifyList checks={sub.acceptance} />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {todo.agent && (
                  <div
                    className="flex items-center gap-1 t-xs t-ui flex-shrink-0 mt-0.5"
                    style={{ color: "var(--color-text-3)" }}
                  >
                    <AgentIcon agentId={todo.agent} size={12} />
                    <span>{todo.agent}</span>
                  </div>
                )}
                {todo.assignee && (
                  <div
                    className="flex items-center gap-1 t-xs t-ui flex-shrink-0 mt-0.5"
                    style={{ color: "var(--color-text-3)" }}
                    title={`Assigned to ${todo.assignee}`}
                  >
                    <span>@{todo.assignee.split("@")[0]}</span>
                  </div>
                )}
                {todo.suggestedProvider && (
                  <SkillBadge
                    suggestion={todo.suggestedProvider}
                    currentAgent={todo.agent}
                    canOverride={
                      plan.sessionId !== null && (plan.pendingPlanId ?? null) !== null
                    }
                    onOverride={(agentId) => {
                      if (!plan.sessionId || !plan.pendingPlanId) return;
                      void api.managerOverrideTodoAgent(
                        plan.sessionId,
                        plan.pendingPlanId,
                        i,
                        agentId,
                      );
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {sessionId && (
        <div className="flex flex-col gap-2 mt-2">
          <div className="t-xs t-ui px-1" style={{ color: "var(--color-text-3)" }}>
            Referenced by 1 Agent
          </div>
          <button
            type="button"
            onClick={onOpenSession}
            className="flex items-center gap-2 px-3 py-2 border text-left transition-colors"
            style={{
              borderColor: "var(--color-line-soft)",
              background: "var(--color-bg-card)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <div
              className="flex items-center justify-center w-5 h-5"
              style={{
                background: "var(--color-bg-2)",
                color: "var(--color-text-3)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H3a1 1 0 0 1-1-1V4z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="t-sm" style={{ color: "var(--color-text-1)" }}>
              Manager session
              <span style={{ color: "var(--color-text-4)" }} className="mx-1.5">·</span>
              <span style={{ color: "var(--color-text-4)" }}>Open chat</span>
            </div>
          </button>
        </div>
      )}
    </>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

// Compact Cursor-style header bar: a muted `Plans › {title}` breadcrumb
// on the left, the clean plan title below it, and — only while the live
// session still has this plan pending — a small primary Build button
// plus a chevron menu folding Cancel / parallelism / Notify team. When
// the plan is a frozen snapshot (already resolved, no live session)
// the action cluster simply does not render, leaving just the title.
function PlanHeader({
  title,
  sessionId,
  planId,
  isAwaitingDecision,
  initialParallelism,
}: {
  title: string;
  sessionId: string | null;
  planId: string;
  isAwaitingDecision: boolean;
  initialParallelism: PlanParallelism;
}) {
  return (
    <header className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-3">
        <div
          className="t-sm t-ui min-w-0 truncate"
          style={{ color: "var(--color-text-3)" }}
        >
          Plans
          <span className="mx-1.5" style={{ color: "var(--color-text-4)" }}>
            ›
          </span>
          <span style={{ color: "var(--color-text-2)" }}>{title}</span>
        </div>
        {isAwaitingDecision && sessionId && (
          <PlanDecisionControls
            sessionId={sessionId}
            planId={planId}
            initialParallelism={initialParallelism}
          />
        )}
      </div>
      <h1
        style={{
          fontSize: "23px",
          fontWeight: 600,
          lineHeight: 1.2,
          color: "var(--color-text-1)",
          letterSpacing: "var(--letter-spacing-tight)",
        }}
      >
        {title}
      </h1>
    </header>
  );
}

function PlanSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2
        style={{
          fontSize: "15px",
          fontWeight: 600,
          lineHeight: 1.3,
          color: "var(--color-text-1)",
          letterSpacing: "var(--letter-spacing-tight)",
        }}
      >
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function PhaseNumber({ n }: { n: number }) {
  return (
    <div
      className="flex-shrink-0 flex items-center justify-center t-xs t-ui mt-0.5"
      style={{
        width: 20,
        height: 20,
        borderRadius: "999px",
        background: "var(--color-bg-2)",
        color: "var(--color-text-3)",
      }}
    >
      {n}
    </div>
  );
}

// VerifyList — the plain-language "what to test" checklist a todo (or its
// sub-step) ships alongside its goal. These are the acceptance checks the
// Manager brain wrote and the same ones that get folded into the board
// task body + the `aura goals add --check` ledger entry on Build. Rendered
// as hollow boxes (not the filled done-circle) so it reads as "still to
// verify", never "already passed".
function VerifyList({ checks }: { checks: string[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="t-xs t-ui" style={{ color: "var(--color-text-4)" }}>
        Verify
      </span>
      <ul className="flex flex-col gap-0.5">
        {checks.map((check, ci) => (
          <li
            key={`${ci}-${check}`}
            className="flex items-start gap-1.5 t-xs t-ui"
            style={{ color: "var(--color-text-3)" }}
          >
            <span
              className="mt-[3px] w-[10px] h-[10px] rounded-[2px] border-[1.5px] flex-shrink-0"
              style={{ borderColor: "var(--color-text-4)" }}
            />
            <span className="min-w-0">{check}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FileRefChip({
  path,
  onClick,
}: {
  path: string;
  onClick: () => void;
}) {
  const display = path.split("/").pop() || path;
  return (
    <button
      type="button"
      onClick={onClick}
      title={path}
      className="inline-flex items-center gap-1 px-1.5 py-[2px] t-xs t-ui font-mono transition-colors hover:opacity-80"
      style={{
        background: "var(--color-bg-2)",
        color: "var(--color-text-2)",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--color-line-soft)",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
        <path
          d="M3 2h6l4 4v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M9 2v4h4" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <span className="truncate max-w-[260px]">{display}</span>
    </button>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

// Empty-state hero for a plan with no body content. The brain
// occasionally emits a stub plan envelope (just a title) when it's
// queueing a follow-up turn — without this, the PlanTab page would be
// a giant blank canvas with one floating title. We give it weight by
// showing the AURA wordmark, a one-line description of what a plan
// even is in this app, and (when we know which session minted the
// plan) a single primary action that drops the user back into the
// chat where the plan was proposed.
export function PlanEmptyState({
  title,
  onOpenChat,
}: {
  title: string;
  onOpenChat: (() => void) | null;
}) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-bg-content px-8 py-12">
      <div className="max-w-[480px] w-full flex flex-col items-center gap-5 text-center">
        <div
          className="t-2xs t-ui uppercase"
          style={{
            color: "var(--color-text-3)",
            letterSpacing: "0.18em",
          }}
        >
          Aura
        </div>
        <div
          className="t-3xl t-heading"
          style={{
            fontSize: "clamp(28px, 4vw, 36px)",
            lineHeight: 1.1,
            color: "var(--color-text-1)",
            letterSpacing: "var(--letter-spacing-tight)",
          }}
        >
          {title?.trim() ? title : "No plan yet"}
        </div>
        <p
          className="t-base"
          style={{ color: "var(--color-text-3)", maxWidth: 380 }}
        >
          Plans appear here when the Manager drafts a multi-step build.
          Until then, the chat is the source of truth — describe the goal
          and Aura will propose a plan you can review.
        </p>
        {onOpenChat && (
          <button
            type="button"
            onClick={onOpenChat}
            className="t-sm t-ui px-3 py-1.5 transition-colors"
            style={{
              background: "var(--color-text-1)",
              color: "var(--color-bg-1)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            Open chat
          </button>
        )}
      </div>
    </div>
  );
}

export function resolveRef(ref: string, repoRoot: string | null): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) return trimmed;
  if (!repoRoot) return null;
  const root = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  return `${root}/${trimmed}`;
}

// Bucket G3 — auto-routing badge surfaced on a PlanTab todo row when
// the Skill Ledger has ≥10 historical samples for the todo's
// taxonomy cell. Renders the suggested provider's id + sample count;
// clicking opens a dropdown of every registered agent so the user can
// override before clicking Build. After Build (canOverride=false) the
// badge becomes read-only — the suggestion still surfaces for context
// but the dropdown disappears.
function SkillBadge({
  suggestion,
  currentAgent,
  canOverride,
  onOverride,
}: {
  suggestion: { providerId: string; score: number; sampleCount: number };
  currentAgent: string | null;
  canOverride: boolean;
  onOverride: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || agents.length > 0) return;
    let cancelled = false;
    void api.agentsList().then((list) => {
      if (!cancelled) setAgents(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open, agents.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const matchesSuggestion =
    !currentAgent || currentAgent === suggestion.providerId;
  const tone = matchesSuggestion
    ? "var(--color-accent)"
    : "var(--color-text-3)";
  const label = useMemo(() => {
    return `${suggestion.providerId} • best match`;
  }, [suggestion]);

  return (
    <div ref={ref} className="relative flex-shrink-0 mt-0.5">
      <button
        type="button"
        onClick={() => canOverride && setOpen((v) => !v)}
        disabled={!canOverride}
        className="t-xs t-ui px-1.5 py-0.5 border transition-colors"
        style={{
          borderColor: tone,
          color: tone,
          background: "color-mix(in srgb, var(--color-accent) 6%, transparent)",
          borderRadius: "var(--radius-sm)",
          cursor: canOverride ? "pointer" : "default",
        }}
        title={
          canOverride
            ? `Aura recommends ${suggestion.providerId}, based on ${suggestion.sampleCount} similar tasks it's handled well. Click to pick a different one.`
            : `Aura recommends ${suggestion.providerId}, based on ${suggestion.sampleCount} similar tasks it's handled well.`
        }
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 z-10 flex flex-col min-w-[160px]"
          style={{
            background: "var(--color-bg-1)",
            border: "1px solid var(--color-line)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-popover, 0 4px 12px rgba(0,0,0,0.18))",
          }}
        >
          {agents
            .filter((a) => a.available)
            .map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onOverride(a.id);
                  setOpen(false);
                }}
                className="t-xs t-ui px-2 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--color-bg-2)]"
                style={{ color: "var(--color-text-1)" }}
              >
                <AgentIcon agentId={a.id} size={12} />
                <span className="flex-1">{a.label || a.id}</span>
                {a.id === suggestion.providerId && (
                  <span
                    className="t-2xs"
                    style={{ color: "var(--color-accent)" }}
                  >
                    suggested
                  </span>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ── Plan decision controls ─────────────────────────────────────────────
//
// Compact Cursor-style action cluster that lives in the PlanTab header
// while the originating session still has this plan pending. A small
// primary Build button plus a chevron menu that folds the secondary
// controls (parallelism, Notify team, Cancel plan) — no bulky bottom
// bar. Without it the only place to click Build / Cancel was the inline
// PlanCard in the chat surface, so a user reviewing the plan in detail
// had to scroll back to chat to resolve. Visibility is gated on the
// LIVE session's `pending_plan` (by the caller), so the whole cluster
// disappears as soon as the brain consumes the decision (from anywhere
// — chat card, here, or a future surface).

export function PlanDecisionControls({
  sessionId,
  planId,
  initialParallelism,
}: {
  sessionId: string;
  planId: string;
  initialParallelism: PlanParallelism;
}) {
  const [submitting, setSubmitting] = useState<"build" | "cancel" | null>(null);
  const [notifyTeam, setNotifyTeam] = useState(false);
  const [parallelism, setParallelism] = useState<PlanParallelism>(initialParallelism);
  const [err, setErr] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const decide = useCallback(
    async (decision: "build" | "cancel") => {
      if (submitting) return;
      setSubmitting(decision);
      setErr(null);
      setMenuOpen(false);
      try {
        await api.managerDecidePlan(
          sessionId,
          planId,
          decision,
          decision === "build" ? notifyTeam : false,
          decision === "build" ? parallelism : undefined,
        );
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setSubmitting(null);
      }
      // Success path: the cluster unmounts when the live session's
      // pending_plan clears, so no setSubmitting(null) needed here.
    },
    [submitting, sessionId, planId, notifyTeam, parallelism],
  );

  return (
    <div
      ref={menuRef}
      className="relative flex items-center gap-1.5 flex-shrink-0"
    >
      <button
        type="button"
        disabled={submitting !== null}
        onClick={() => void decide("build")}
        className="t-sm t-accent px-3 py-1 disabled:opacity-50 transition-colors"
        style={{
          background: "var(--color-accent)",
          color: "var(--color-bg-0)",
          borderRadius: "var(--radius-md)",
        }}
        title="Waiting for your go-ahead — start building this plan"
      >
        {submitting === "build" ? "Building…" : "Build"}
      </button>
      <button
        type="button"
        disabled={submitting !== null}
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center justify-center px-1.5 py-1 border disabled:opacity-50 transition-colors hover:bg-[var(--color-bg-2)]"
        style={{
          borderColor: "var(--color-line)",
          borderRadius: "var(--radius-md)",
          color: "var(--color-text-2)",
        }}
        title="More options"
        aria-label="More plan options"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {menuOpen && (
        <div
          className="absolute right-0 top-full mt-1.5 z-20 flex flex-col gap-2.5 p-3 min-w-[220px]"
          style={{
            background: "var(--color-bg-1)",
            border: "1px solid var(--color-line)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-popover, 0 4px 12px rgba(0,0,0,0.18))",
          }}
        >
          <div className="flex flex-col gap-1.5">
            <div
              className="t-2xs t-ui"
              style={{ color: "var(--color-text-3)" }}
            >
              Parallelism
            </div>
            <PlanTabParallelism
              value={parallelism}
              onChange={setParallelism}
              disabled={submitting !== null}
            />
          </div>
          <label
            className="t-xs t-ui flex items-center gap-1.5 select-none cursor-pointer"
            style={{ color: "var(--color-text-2)" }}
            title="Let your team know this plan is building."
          >
            <input
              type="checkbox"
              checked={notifyTeam}
              onChange={(e) => setNotifyTeam(e.target.checked)}
              disabled={submitting !== null}
              className="cursor-pointer"
            />
            Notify team
          </label>
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => void decide("cancel")}
            className="t-xs t-ui px-2 py-1.5 border text-left disabled:opacity-50 transition-colors hover:bg-[var(--color-bg-2)]"
            style={{
              background: "transparent",
              borderColor: "var(--color-line)",
              borderRadius: "var(--radius-sm)",
              color: "var(--color-text-2)",
            }}
          >
            {submitting === "cancel" ? "Cancelling…" : "Cancel plan"}
          </button>
          {err && (
            <div
              className="t-2xs t-ui px-2 py-1 rounded"
              style={{
                background: "rgba(248,113,113,0.12)",
                color: "var(--color-red, #f87171)",
              }}
            >
              {err}
            </div>
          )}
        </div>
      )}
      {err && !menuOpen && (
        <div
          className="absolute right-0 top-full mt-1.5 z-20 t-2xs t-ui px-2 py-1 rounded whitespace-nowrap"
          style={{
            background: "rgba(248,113,113,0.12)",
            color: "var(--color-red, #f87171)",
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

function PlanTabParallelism({
  value,
  onChange,
  disabled,
}: {
  value: PlanParallelism;
  onChange: (v: PlanParallelism) => void;
  disabled: boolean;
}) {
  const options: { id: PlanParallelism; label: string; hint: string }[] = [
    { id: "auto", label: "Auto", hint: "Zone-overlap heuristic (default)" },
    { id: "parallel", label: "Parallel", hint: "Concurrent parallel copies, ignore overlap" },
    { id: "serial", label: "Serial", hint: "One task at a time" },
  ];
  return (
    <div
      className="inline-flex items-center"
      style={{
        background: "var(--color-bg-2)",
        borderRadius: "var(--radius-sm)",
        padding: "2px",
      }}
    >
      {options.map((opt) => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            title={opt.hint}
            className="t-2xs t-ui px-2 py-1 transition-colors disabled:opacity-50"
            style={{
              background: selected ? "var(--color-bg-card)" : "transparent",
              color: selected ? "var(--color-text-1)" : "var(--color-text-3)",
              borderRadius: "var(--radius-xs)",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
