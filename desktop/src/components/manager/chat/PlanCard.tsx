import { useCallback, useState } from "react";
import { MoreHorizontal, Play } from "lucide-react";
import { api, type PendingPlan, type PlanParallelism } from "../../../lib/api";
import { PlanReview } from "../../ui/chat-decisions";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { openPlanWizard } from "../../../lib/planWizardStore";
import { formatRelativeApprovalTime } from "./QuestionCard";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import {
  PARALLELISM_OPTIONS,
  PlanOrchestratorSection,
} from "./PlanOrchestrator";

// ── Interactive plan card ───────────────────────────────────────────────
//
// Rendered whenever `session.pending_plan` is set. Backed by the persisted
// plan on the session so it survives reload mid-decision. Clicking Build
// or Cancel routes to `managerDecidePlan` which resolves the bridge
// waiter — the CLI brain (claude/gemini/etc) that's blocked inside
// `aura propose-plan` wakes up with the verb, then either fans out
// subagents (Build) or backs off and asks the user a follow-up (Cancel).

export function PlanCard({
  sessionId,
  plan,
  onError,
  onBuildStart,
  grouped = false,
  repoRoot,
}: {
  sessionId: string;
  plan: PendingPlan;
  onError: (msg: string) => void;
  /** Fires the instant Build is pressed (before the backend round-trip) so the
   *  parent can show an immediate "Spinning up the crew…" line and close the
   *  silent gap before the live crew strip appears. */
  onBuildStart?: () => void;
  /** Inline-in-scroll mode: when prev author was the same agent, hide
   *  the avatar gutter. */
  grouped?: boolean;
  repoRoot?: string | null;
}) {
  const [submitting, setSubmitting] = useState<
    "build" | "revise" | "cancel" | null
  >(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionFeedback, setRevisionFeedback] = useState("");
  // Bucket N3 — opt-in team broadcast on Build. Default off so the
  // common single-developer case stays quiet. When set, the backend
  // fires `aura msg send "Plan built: <title> (<plan_task_id>)"` after
  // the build kicks off.
  const [notifyTeam, setNotifyTeam] = useState(false);
  // Bucket D — Auto / Parallel / Serial picker. `Auto` (default)
  // honours the existing zone-overlap heuristic. `Parallel` opts the
  // user into concurrent worktrees racing the same files. `Serial`
  // forces strict one-at-a-time even when zones are disjoint.
  const [parallelism, setParallelism] = useState<PlanParallelism>(
    plan.parallelism ?? "auto",
  );
  // Inventory blocker #3 — local approval overlay so the row updates
  // instantly on click. Backend persists + emits a fresh snapshot which
  // will overwrite this, but the optimistic state covers the round-trip
  // window. `null` means "fall back to whatever's on the persisted plan".
  const [approvalOverlay, setApprovalOverlay] = useState<{
    approved_by: string;
    approved_at: number;
  } | null>(null);
  const [approving, setApproving] = useState(false);
  const approvedBy = approvalOverlay?.approved_by ?? plan.approved_by ?? null;
  const approvedAt = approvalOverlay?.approved_at ?? plan.approved_at ?? null;

  const decide = useCallback(
    async (decision: "build" | "revise" | "cancel") => {
      if (submitting) return;
      const feedback = revisionFeedback.trim();
      if (decision === "revise" && !feedback) return;
      setSubmitting(decision);
      // Optimistic hand-off: the moment Build is pressed, ask the parent to
      // show "Spinning up the crew…" so the chat never goes silent during the
      // spawn. Cancel doesn't spawn anything, so it stays quiet.
      if (decision === "build") onBuildStart?.();
      try {
        await api.managerDecidePlan(
          sessionId,
          plan.id,
          decision,
          decision === "build" ? notifyTeam : false,
          decision === "build" ? parallelism : undefined,
          decision === "revise" ? feedback : undefined,
        );
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        setSubmitting(null);
      }
    },
    [
      submitting,
      sessionId,
      plan.id,
      onError,
      onBuildStart,
      notifyTeam,
      parallelism,
      revisionFeedback,
    ],
  );

  // "Open plan" → the proper fullscreen wizard overlay (Document / Tasks),
  // not a workpane tab. The user reviews the full design doc + breakdown in
  // focus, then Builds or Cancels from the overlay's top-bar cluster.
  const openAsTab = useCallback(() => {
    openPlanWizard(pendingPlanToTabInput(plan), repoRoot ?? null, sessionId);
  }, [plan, repoRoot, sessionId]);

  // Inventory blocker #3 — Approve handler. Resolves the current user's
  // effective identity (per-repo git identity overlay, fallback to the
  // global device identity), stamps the pending plan, and overlays the
  // result locally so the row updates without waiting for the next
  // session snapshot. Display-name beats email when both are set; if
  // neither is set we fall back to "you" rather than a blank handle so
  // the audit row is never empty.
  const approve = useCallback(async () => {
    if (approving || approvedBy) return;
    setApproving(true);
    try {
      let handle = "you";
      try {
        const identity = repoRoot
          ? await api.deviceIdentityForRepo(repoRoot)
          : await api.deviceIdentity();
        const name = identity.display_name?.trim();
        const email = identity.email?.trim();
        handle = name || email || "you";
      } catch {
        // Fall back to "you" — better than blocking approval if the
        // identity lookup transiently fails (cloud down, repo without
        // a git user.* set, etc).
      }
      const stamp = await api.managerApprovePlan(sessionId, plan.id, handle);
      setApprovalOverlay(stamp);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }, [approving, approvedBy, repoRoot, sessionId, plan.id, onError]);

  const description = plan.summary?.trim() || plan.objective?.trim() || "";
  const meta = [
    plan.phases?.length ? `${plan.phases.length} phases` : null,
    `${plan.todos.length} task${plan.todos.length === 1 ? "" : "s"}`,
    approvedBy
      ? `Approved by ${approvedBy}${approvedAt ? ` · ${formatRelativeApprovalTime(approvedAt)}` : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const status =
    submitting === "build"
      ? "Building…"
      : submitting === "cancel"
        ? "Cancelling…"
        : approvedBy
          ? "Approved"
          : "Ready for review";
  return (
    <div className={grouped ? "mt-1" : "mt-2"}>
      <PlanReview
        className="chat-plan-review"
        title={plan.title}
        summary={description}
        status={status}
        meta={meta}
        onOpen={openAsTab}
        actions={
          <>
            {/* The plan's options are the shared menu. They were a popover
                of ghost buttons, a segmented strip and a bare checkbox — each
                row a different control, none of them reachable by the menu's
                own keys. The note asking for changes needs a text box, which
                a menu can't hold, so it opens under the plan instead. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="iconXs"
                  aria-label="Plan options"
                  title="Plan options"
                  disabled={submitting !== null}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="min-w-[272px]">
                <DropdownMenuLabel>Plan options</DropdownMenuLabel>
                {!approvedBy && (
                  <DropdownMenuItem
                    disabled={approving || submitting !== null}
                    onSelect={() => void approve()}
                  >
                    {approving ? "Approving…" : "Approve plan"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={submitting !== null}>
                    Run tasks
                    <span className="ui-menu-value">
                      {PARALLELISM_OPTIONS.find((o) => o.value === parallelism)?.label}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={parallelism}
                      onValueChange={(value) => setParallelism(value as PlanParallelism)}
                    >
                      {PARALLELISM_OPTIONS.map((o) => (
                        <DropdownMenuRadioItem key={o.value} value={o.value} title={o.title}>
                          {o.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuCheckboxItem
                  checked={notifyTeam}
                  disabled={submitting !== null}
                  onCheckedChange={(value) => setNotifyTeam(value === true)}
                  onSelect={(event) => event.preventDefault()}
                >
                  Notify team when building starts
                </DropdownMenuCheckboxItem>
                <DropdownMenuItem
                  disabled={submitting !== null}
                  onSelect={() => setRevisionOpen((value) => !value)}
                >
                  {revisionOpen ? "Close the change request" : "Request changes"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={submitting !== null}
                  onSelect={() => void decide("cancel")}
                >
                  {submitting === "cancel" ? "Cancelling…" : "Cancel plan"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={openAsTab}
            >
              Review plan
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={submitting !== null}
              onClick={() => void decide("build")}
            >
              <Play />
              {submitting === "build" ? "Building…" : "Build"}
            </Button>
          </>
        }
        extra={
          <>
            {revisionOpen && (
              <div className="chat-plan-revision">
                <Textarea
                  autoFocus
                  aria-label="Plan changes"
                  value={revisionFeedback}
                  onChange={(event) => setRevisionFeedback(event.target.value)}
                  rows={3}
                  maxLength={8000}
                  placeholder="What should the plan change?"
                />
                <div className="ui-pattern-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setRevisionOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    disabled={submitting !== null || !revisionFeedback.trim()}
                    onClick={() => void decide("revise")}
                  >
                    {submitting === "revise" ? "Sending…" : "Send feedback"}
                  </Button>
                </div>
              </div>
            )}
            <PlanOrchestratorSection plan={plan} repoRoot={repoRoot ?? null} />
          </>
        }
      >
        {plan.todos.length > 0 && (
          <ol className="chat-plan-tasks">
            {plan.todos.slice(0, 3).map((todo, i) => (
              <li key={i}>
                <span className="chat-task-mark" aria-hidden />
                <span>{todo.description}</span>
              </li>
            ))}
            {plan.todos.length > 3 && (
              <li>
                <span className="chat-plan-tasks-more">
                  {plan.todos.length - 3} more in the full plan
                </span>
              </li>
            )}
          </ol>
        )}
      </PlanReview>
    </div>
  );
}

// PendingPlan from the wire is snake_case (mirrors the Rust struct);
// `editor.openPlan` expects camelCase. Centralizing the conversion here
// keeps the auto-open path and the manual "Open" click producing the
// exact same PlanTab shape regardless of how the user reached it.
export function pendingPlanToTabInput(plan: PendingPlan) {
  return {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
    objective: plan.objective,
    baseline: plan.baseline,
    architectureMermaid: plan.architecture_mermaid,
    phases: plan.phases?.map((p) => ({
      title: p.title,
      body: p.body,
      fileRefs: p.file_refs ?? [],
    })),
    deliverables: plan.deliverables,
    tests: plan.tests,
    pendingPlanId: plan.id,
    todos: plan.todos.map((t) => ({
      description: t.description,
      agent: t.agent ?? null,
      fileRefs: t.file_refs,
      assignee: t.assignee ?? null,
      suggestedProvider: t.suggested_provider
        ? {
            providerId: t.suggested_provider.provider_id,
            score: t.suggested_provider.score,
            sampleCount: t.suggested_provider.sample_count,
          }
        : null,
      goal: t.goal ?? null,
      acceptance: t.acceptance ?? [],
      subtasks: t.subtasks?.map((s) => ({
        description: s.description,
        agent: s.agent ?? null,
        goal: s.goal ?? null,
        acceptance: s.acceptance ?? [],
      })),
    })),
  };
}
