// PlanWizard — the proposed plan opened as a PROPER fullscreen wizard
// overlay, not a workpane tab. A Manager brain proposes a plan; the user
// clicks "Open plan" and the whole app dims to a focused FullscreenOverlay
// with two tabs — Document (the design write-up) and Tasks (the breakdown)
// — and a Build / Cancel cluster pinned top-right. The plan title leads
// the body (the overlay deliberately has no title slot; its tabs carry
// the context). Esc closes.
//
// Single renderer, two surfaces: the Document / Tasks bodies and the
// decision controls are the exact same components the PlanTab workpane
// renders (PlanDocumentBody / PlanTasksBody / PlanDecisionControls), so
// the wizard and the tab never drift. The only difference is the shell —
// an app-level overlay vs. an in-pane tab.
//
// State lives in planWizardStore (a tiny useSyncExternalStore): one plan
// open at a time, opened via openPlanWizard(...) from the chat surface.

import { useCallback, useState } from "react";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { WizardStepTabs } from "../ui/wizard";
import { Button } from "../ui/button";
import { SegmentedControl } from "../ui/segmented";
import { Switch } from "../ui/switch";
import {
  closePlanWizard,
  togglePlanWizardTodo,
  usePlanWizard,
} from "../../lib/planWizardStore";
import { useEditorStore } from "../../lib/editorStore";
import { focusAmbientManager } from "../../lib/focusManager";
import { useManagerSession } from "../../lib/managerStore";
import { api, type PlanParallelism } from "../../lib/api";
import {
  isPlanEmpty,
  PLAN_TAB_STEPS,
  PlanDocumentBody,
  PlanEmptyState,
  PlanTasksBody,
  resolveRef,
} from "./PlanTab";

// Mount this once near the app root. It renders nothing until a plan is
// opened via openPlanWizard(); then it mounts the FullscreenOverlay.
export function PlanWizardHost() {
  const plan = usePlanWizard();
  if (!plan) return null;
  // `key` so the wizard's local tab state resets when a different plan is
  // opened without unmounting the host.
  return <PlanWizardOverlay key={plan.id} />;
}

function PlanWizardOverlay() {
  const plan = usePlanWizard();
  const store = useEditorStore();
  const [tab, setTab] = useState(0);
  const sessionId = plan?.sessionId ?? null;

  // Track the live session so the Build / Cancel cluster mirrors the
  // brain's pending_plan state — it disappears the instant the decision
  // is consumed (from here, the chat card, or anywhere), exactly like the
  // PlanTab header does.
  const liveSession = useManagerSession(sessionId);

  // Open a file ref behind the overlay, then close the wizard so the user
  // actually lands on the file (an overlay would otherwise hide it).
  const onOpenFile = useCallback(
    async (ref: string) => {
      if (!plan) return;
      const abs = resolveRef(ref, plan.repoRoot);
      if (!abs) return;
      closePlanWizard();
      try {
        await store.open(abs);
      } catch {
        // best-effort — missing file silently no-ops
      }
    },
    [store, plan],
  );

  // Jump back to the originating Manager chat, then close the wizard.
  const onOpenSession = useCallback(() => {
    if (sessionId && plan?.repoRoot) {
      focusAmbientManager(plan.repoRoot, sessionId);
    }
    closePlanWizard();
  }, [sessionId, plan?.repoRoot]);

  if (!plan) return null;

  const isAwaitingDecision =
    !!liveSession?.pending_plan && liveSession.pending_plan.id === plan.id;
  const empty = isPlanEmpty(plan);

  return (
    <FullscreenOverlay
      onClose={closePlanWizard}
      tabs={
        empty ? undefined : (
          <WizardStepTabs
            steps={PLAN_TAB_STEPS}
            index={tab}
            onJump={setTab}
            variant="tabs"
          />
        )
      }
      footer={
        isAwaitingDecision && sessionId ? (
          <PlanWizardDecisionBar
            sessionId={sessionId}
            planId={plan.id}
            initialParallelism={
              (liveSession?.pending_plan?.parallelism ?? "auto") as PlanParallelism
            }
          />
        ) : undefined
      }
    >
      {empty ? (
        <PlanEmptyState
          title={plan.title}
          onOpenChat={sessionId ? onOpenSession : null}
        />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-[760px] mx-auto px-6 py-6 flex flex-col gap-5">
            {/* The overlay carries no title chrome — render the plan title
                as the lead of the body so it's always present above both
                tabs' content. */}
            <header className="flex flex-col gap-1.5">
              <div
                className="t-sm t-ui"
                style={{ color: "var(--color-text-3)" }}
              >
                Plan
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
                {plan.title || "Untitled plan"}
              </h1>
            </header>

            {tab === 0 ? (
              <PlanDocumentBody plan={plan} onOpenFile={onOpenFile} />
            ) : (
              <PlanTasksBody
                plan={plan}
                onToggle={togglePlanWizardTodo}
                onOpenFile={onOpenFile}
                onOpenSession={onOpenSession}
              />
            )}
          </div>
        </div>
      )}
    </FullscreenOverlay>
  );
}

// The wizard's sticky decision bar — the same Build / Cancel verbs the chat
// card carries, but rendered with the app's design-system primitives (3D
// `Button`, `SegmentedControl`, `Switch`) in the overlay's footer, exactly
// like every other fullscreen wizard (CreateTaskWizard, PRDetailPane). The
// compact chevron-fold cluster that PlanTab uses is a tiny-header
// affordance; a fullscreen wizard has room to lay the options out flat.
// Visibility is gated by the caller on the live session's pending_plan, so
// the whole bar vanishes the instant the decision is consumed.
function PlanWizardDecisionBar({
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

  const decide = useCallback(
    async (decision: "build" | "cancel") => {
      if (submitting) return;
      setSubmitting(decision);
      setErr(null);
      try {
        await api.managerDecidePlan(
          sessionId,
          planId,
          decision,
          decision === "build" ? notifyTeam : false,
          decision === "build" ? parallelism : undefined,
        );
        // Success: close the wizard so the user lands back to watch the
        // build (or returns to chat on cancel). The live session's
        // pending_plan also clears, which would unmount this bar anyway.
        closePlanWizard();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setSubmitting(null);
      }
    },
    [submitting, sessionId, planId, notifyTeam, parallelism],
  );

  return (
    <div className="flex w-full items-center justify-between gap-4">
      {/* Build options, low-emphasis, on the left. */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2">
          <span className="t-2xs t-ui" style={{ color: "var(--color-text-3)" }}>
            Run
          </span>
          <SegmentedControl
            value={parallelism}
            onChange={setParallelism}
            ariaLabel="Build parallelism"
            options={[
              { value: "auto", label: "Auto" },
              { value: "parallel", label: "Parallel" },
              { value: "serial", label: "Serial" },
            ]}
          />
        </div>
        <label
          className="flex items-center gap-2 t-xs t-ui select-none cursor-pointer"
          style={{ color: "var(--color-text-2)" }}
          title="Let your team know this plan is building."
        >
          <Switch
            checked={notifyTeam}
            onCheckedChange={setNotifyTeam}
            disabled={submitting !== null}
          />
          Notify team
        </label>
        {err && (
          <span className="t-2xs t-ui" style={{ color: "var(--color-red, #f87171)" }}>
            {err}
          </span>
        )}
      </div>

      {/* Primary verbs on the right — same shape as every other wizard. */}
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          disabled={submitting !== null}
          onClick={() => void decide("cancel")}
        >
          {submitting === "cancel" ? "Cancelling…" : "Cancel plan"}
        </Button>
        <Button
          variant="accentSoft"
          size="sm"
          disabled={submitting !== null}
          onClick={() => void decide("build")}
          title="Waiting for your go-ahead — start building this plan"
        >
          {submitting === "build" ? "Building…" : "Build"}
        </Button>
      </div>
    </div>
  );
}
