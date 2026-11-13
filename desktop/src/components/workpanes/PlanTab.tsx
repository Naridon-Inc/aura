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
import { FileText, ListChecks, MessageSquare } from "lucide-react";
import { MarkdownBody } from "../manager/chat/Markdown";
import { ChatRepoRootContext } from "../manager/chat/context";
import { type PlanTabData, useEditorStore } from "../../lib/editorStore";
import { focusAmbientManager } from "../../lib/focusManager";
import { useManagerSession } from "../../lib/managerStore";
import { AgentIcon } from "../agent/AgentIcon";
import { MermaidDiagram } from "../notes/MermaidDiagram";
import { WizardStepTabs } from "../ui/wizard";
import { EmptyState } from "../ui/state";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TaskFact } from "../ui/tasks-board";
import {
  TaskDependencyLinks,
  TaskDetailNote,
  TaskDetailSection,
} from "../ui/tasks-detail";
import { Timeline } from "../ui/timeline";
import "../ui/plan-document.css";
import { api, type AgentDescriptor, type PlanParallelism } from "../../lib/api";
import { useDismiss } from "../../lib/useDismiss";
import { readAgentsList } from "../../lib/agentsListCache";

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
    <div className="ui-task-details ui-plan-doc">
      {lead && <p className="ui-plan-doc-lead">{lead}</p>}

      {hasBaseline && (
        <TaskDetailSection title="Current baseline">
          <PlanProse source={plan.baseline as string} repoRoot={plan.repoRoot} />
        </TaskDetailSection>
      )}

      {hasArchitecture && (
        <TaskDetailSection title="Proposed architecture">
          <MermaidDiagram code={plan.architectureMermaid as string} />
        </TaskDetailSection>
      )}

      {phases.length > 0 && (
        <TaskDetailSection title="Implementation plan" count={phases.length}>
          {/* The phases in order, numbered on the timeline's own markers. */}
          <Timeline
            entries={phases.map((phase, i) => ({
              id: `${i}-${phase.title}`,
              title: phase.title,
              marker: <span className="ui-plan-phase-number">{i + 1}</span>,
              detail:
                phase.body || (phase.fileRefs && phase.fileRefs.length > 0) ? (
                  <>
                    {phase.body && (
                      <PlanProse source={phase.body} repoRoot={plan.repoRoot} />
                    )}
                    {phase.fileRefs && phase.fileRefs.length > 0 && (
                      <FileRefList refs={phase.fileRefs} onOpenFile={onOpenFile} />
                    )}
                  </>
                ) : undefined,
            }))}
          />
        </TaskDetailSection>
      )}

      {deliverables.length > 0 && (
        <TaskDetailSection title="Deliverables" count={deliverables.length}>
          <ul className="ui-plan-doc-list">
            {deliverables.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </TaskDetailSection>
      )}

      {tests.length > 0 && (
        <TaskDetailSection title="Tests" count={tests.length}>
          <ul className="ui-plan-doc-list">
            {tests.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </TaskDetailSection>
      )}
    </div>
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
    <div className="ui-task-details ui-plan-doc">
      <TaskDetailSection title="Tasks" count={plan.todos.length}>
        {plan.todos.length === 0 ? (
          <TaskDetailNote>No tasks in this plan.</TaskDetailNote>
        ) : (
          <ul className="ui-plan-todos">
            {plan.todos.map((todo, i) => (
              <li
                key={`${i}-${todo.description}`}
                className="ui-plan-todo"
                data-done={todo.done || undefined}
              >
                <Checkbox
                  checked={todo.done}
                  onCheckedChange={() => onToggle(i)}
                  aria-label={todo.done ? "Mark not done" : "Mark done"}
                  title={todo.done ? "Mark not done" : "Mark done"}
                />
                <div className="ui-plan-todo-body">
                  <span className="ui-plan-todo-title">{todo.description}</span>
                  {todo.fileRefs && todo.fileRefs.length > 0 && (
                    <FileRefList refs={todo.fileRefs} onOpenFile={onOpenFile} />
                  )}
                  {todo.goal && <DoneWhen goal={todo.goal} />}
                  {todo.acceptance && todo.acceptance.length > 0 && (
                    <VerifyList checks={todo.acceptance} />
                  )}
                  {todo.subtasks && todo.subtasks.length > 0 && (
                    <ul className="ui-plan-subtasks">
                      {todo.subtasks.map((sub, si) => (
                        <li key={`${si}-${sub.description}`}>
                          <div className="ui-plan-subtask-head">
                            <span>{sub.description}</span>
                            {sub.agent && (
                              <span title={sub.agent}>
                                <AgentIcon agentId={sub.agent} size={11} />
                              </span>
                            )}
                          </div>
                          {sub.goal && <DoneWhen goal={sub.goal} />}
                          {sub.acceptance && sub.acceptance.length > 0 && (
                            <VerifyList checks={sub.acceptance} />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="ui-plan-todo-facts">
                  {todo.agent && (
                    <TaskFact icon={<AgentIcon agentId={todo.agent} size={12} />}>
                      {todo.agent}
                    </TaskFact>
                  )}
                  {todo.assignee && (
                    <TaskFact title={`Assigned to ${todo.assignee}`}>
                      @{todo.assignee.split("@")[0]}
                    </TaskFact>
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
                </div>
              </li>
            ))}
          </ul>
        )}
      </TaskDetailSection>

      {sessionId && (
        <TaskDetailSection title="Referenced by 1 agent">
          <TaskDependencyLinks
            items={[
              {
                id: "session",
                label: "Manager session",
                icon: <MessageSquare />,
                hint: "Open chat",
              },
            ]}
            onOpen={() => onOpenSession()}
          />
        </TaskDetailSection>
      )}
    </div>
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

// A markdown passage of the plan, read with the plan's own repository as the
// root its file links resolve against.
function PlanProse({
  source,
  repoRoot,
}: {
  source: string;
  repoRoot: string | null | undefined;
}) {
  return (
    <div className="ui-plan-prose">
      <ChatRepoRootContext.Provider value={repoRoot ?? null}>
        <MarkdownBody source={source} />
      </ChatRepoRootContext.Provider>
    </div>
  );
}

function DoneWhen({ goal }: { goal: string }) {
  return (
    <p className="ui-plan-done-when">
      <span>Done when</span> {goal}
    </p>
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
    <div className="ui-plan-verify">
      <span>Verify</span>
      <ul>
        {checks.map((check, ci) => (
          <li key={`${ci}-${check}`}>
            <span className="ui-plan-verify-box" aria-hidden />
            <span>{check}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The files a phase or a task names, each one opening in the editor.
function FileRefList({
  refs,
  onOpenFile,
}: {
  refs: string[];
  onOpenFile: (ref: string) => void;
}) {
  return (
    <div className="ui-plan-files">
      {refs.map((ref) => (
        <Button
          key={ref}
          variant="outline"
          size="xs"
          className="ui-plan-file"
          title={ref}
          onClick={() => onOpenFile(ref)}
        >
          <FileText />
          <span>{ref.split("/").pop() || ref}</span>
        </Button>
      ))}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

// Empty state for a plan with no body content. The brain occasionally emits a
// stub plan envelope (just a title) when it's queueing a follow-up turn —
// without this, the PlanTab page would be a giant blank canvas with one
// floating title. When we know which session minted the plan, the one action
// drops the reader back into the chat where it was proposed.
//
// This used to be a bespoke hero: a wordmark, a 36px display title and an
// inverted white button that appeared nowhere else in the app. It says the
// same thing in the app's own shape now.
export function PlanEmptyState({
  title,
  onOpenChat,
}: {
  title: string;
  onOpenChat: (() => void) | null;
}) {
  return (
    <div className="ui-plan-empty">
      <EmptyState
        icon={ListChecks}
        title={title?.trim() ? title : "No plan yet"}
        body="A plan is Aura’s proposal for a job too big to do in one go. The steps it means to take, written down before it takes them, so you can change your mind first. Describe what you want in chat and one appears here."
        action={
          onOpenChat
            ? { label: "Open chat", onClick: onOpenChat, icon: MessageSquare }
            : undefined
        }
      />
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

  useEffect(() => {
    if (!open || agents.length > 0) return;
    let cancelled = false;
    void readAgentsList()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, agents.length]);

  const matchesSuggestion =
    !currentAgent || currentAgent === suggestion.providerId;
  const label = useMemo(() => {
    return `${suggestion.providerId} • best match`;
  }, [suggestion]);

  return (
    <DropdownMenu open={canOverride && open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={!canOverride}>
        <Button
          variant="outline"
          size="xs"
          className="ui-plan-skill"
          data-match={matchesSuggestion || undefined}
          title={
            canOverride
              ? `Aura recommends ${suggestion.providerId}, based on ${suggestion.sampleCount} similar tasks it's handled well. Click to pick a different one.`
              : `Aura recommends ${suggestion.providerId}, based on ${suggestion.sampleCount} similar tasks it's handled well.`
          }
        >
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {agents
          .filter((a) => a.available)
          .map((a) => (
            <DropdownMenuItem key={a.id} onSelect={() => onOverride(a.id)}>
              <AgentIcon agentId={a.id} size={12} />
              <span className="ui-plan-skill-name">{a.label || a.id}</span>
              {a.id === suggestion.providerId && (
                <Badge variant="outline">suggested</Badge>
              )}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const [submitting, setSubmitting] = useState<"build" | "revise" | "cancel" | null>(null);
  const [notifyTeam, setNotifyTeam] = useState(false);
  const [parallelism, setParallelism] = useState<PlanParallelism>(initialParallelism);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionFeedback, setRevisionFeedback] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useDismiss(menuOpen, () => setMenuOpen(false), menuRef);

  const decide = useCallback(
    async (decision: "build" | "revise" | "cancel") => {
      if (submitting) return;
      const feedback = revisionFeedback.trim();
      if (decision === "revise" && !feedback) return;
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
          decision === "revise" ? feedback : undefined,
        );
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setSubmitting(null);
      }
      // Success path: the cluster unmounts when the live session's
      // pending_plan clears, so no setSubmitting(null) needed here.
    },
    [submitting, sessionId, planId, notifyTeam, parallelism, revisionFeedback],
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
        title="Waiting for your go-ahead. Start building this plan"
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
            onClick={() => setRevisionOpen((value) => !value)}
            className="t-xs t-ui px-2 py-1.5 border text-left disabled:opacity-50 transition-colors hover:bg-[var(--color-bg-2)]"
            style={{
              background: "transparent",
              borderColor: "var(--color-line)",
              borderRadius: "var(--radius-sm)",
              color: "var(--color-text-2)",
            }}
          >
            Request changes
          </button>
          {revisionOpen && (
            <div className="flex flex-col gap-1.5">
              <textarea
                autoFocus
                value={revisionFeedback}
                onChange={(event) => setRevisionFeedback(event.target.value)}
                rows={3}
                maxLength={8000}
                placeholder="What should the plan change?"
                className="w-full resize-y t-xs px-2 py-1.5 outline-none"
                style={{
                  color: "var(--color-text-1)",
                  background: "var(--color-bg-2)",
                  border: "1px solid var(--color-line)",
                  borderRadius: "var(--radius-sm)",
                }}
              />
              <button
                type="button"
                disabled={submitting !== null || !revisionFeedback.trim()}
                onClick={() => void decide("revise")}
                className="self-end t-xs t-ui px-2 py-1 disabled:opacity-50"
                style={{
                  color: "var(--color-bg-0)",
                  background: "var(--color-accent)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {submitting === "revise" ? "Sending…" : "Send feedback"}
              </button>
            </div>
          )}
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
    { id: "auto", label: "When safe", hint: "Side by side, unless two tasks would touch the same files" },
    { id: "parallel", label: "All at once", hint: "Side by side even when two touch the same files" },
    { id: "serial", label: "One at a time", hint: "Never run two together" },
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
