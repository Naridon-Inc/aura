import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { PendingPlan, PlanParallelism } from "../../../lib/api";
import { WaveDispatchPanel } from "../WaveDispatchPanel";
import { Segment } from "../../ui/segment";

/// v0.2.31 LL.1 — collapsible Orchestrator section on the PlanCard.
/// Maps the plan's todos to LaneSpec entries (one lane per todo) and
/// delegates to `<WaveDispatchPanel>` for the actual fan-out. Lives
/// alongside the legacy Build button — operators choose Build for the
/// single-agent path or expand Orchestrator for manager-of-managers.
export function PlanOrchestratorSection({
  plan,
  repoRoot,
}: {
  plan: PendingPlan;
  repoRoot: string | null;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const laneCount = plan.todos?.length ?? 0;
  // The transcript's own fold (the one a run of tool calls collapses into):
  // a chevron row that opens in place. It was a bordered band with its own
  // hover fill, a second kind of disclosure in the same conversation.
  return (
    <section className="ui-tool-group chat-plan-assignments">
      <button
        type="button"
        className="ui-tool-group-trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={14} className={open ? "ui-chevron-open" : ""} />
        <span>Agent assignments</span>
        <span className="ui-tool-group-note">
          {laneCount} task{laneCount === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div id={id} className="ui-tool-group-content">
          <WaveDispatchPanel plan={plan} repoRoot={repoRoot} />
        </div>
      )}
    </section>
  );
}

/** How many of a plan's tasks may run at once, in the words the plan's
 *  options menu and the segmented control both show. */
export const PARALLELISM_OPTIONS: ReadonlyArray<{
  value: PlanParallelism;
  label: string;
  title: string;
}> = [
  {
    value: "auto",
    label: "When safe",
    title: "Side by side, but hold a task back while another is in the same files.",
  },
  {
    value: "parallel",
    label: "All at once",
    title: "Side by side even in the same files. Faster, and you merge the overlap yourself.",
  },
  {
    value: "serial",
    label: "One at a time",
    title: "Never run two together, even when they'd never meet.",
  },
];

/// Bucket D — segmented control on the PlanCard footer. Three modes:
/// Auto (current zone-overlap heuristic), Parallel (ignore overlaps,
/// concurrent worktrees), Serial (one task at a time, even disjoint).
/// The brain's per-todo agent picks still apply on top — this is just
/// the dispatch-tick behaviour at the session level.
///
/// Wears the app's one segmented strip (`Segment`). It used to draw its own:
/// a bordered track whose selected cell was a SOLID accent fill with inverted
/// text — the loudest thing on a plan card, and a third appearance for a
/// gesture the right rail and every board switch already share.
export function ParallelismControl({
  value,
  onChange,
  disabled,
}: {
  value: PlanParallelism;
  onChange: (v: PlanParallelism) => void;
  disabled?: boolean;
}) {
  return (
    <Segment
      value={value}
      onChange={onChange}
      disabled={disabled}
      size="xs"
      ariaLabel="How many tasks may run at once"
      options={[...PARALLELISM_OPTIONS]}
    />
  );
}
