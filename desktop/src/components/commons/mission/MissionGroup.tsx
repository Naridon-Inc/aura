// MissionGroup — one collapsible stage section in the Activity list, matching
// the Warp Oz grouping: a header row [chevron] [Stage] [count], then the run
// rows. The header carries the stage's status tone as a faint left tick + the
// count tint, so "Building" reads warm/live and "Done" reads green without
// shouting. Collapse state is owned by the parent (so it survives a re-poll).

import type { JSX, ReactNode } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

import {
  STAGE_LABEL,
  STAGE_TONE,
  STAGE_HINT,
  type MissionStageId,
} from "./missionData";

export function MissionGroup(props: {
  stage: MissionStageId;
  count: number;
  collapsed?: boolean;
  onToggle?: (stage: MissionStageId) => void;
  /** Optional far-right header affordance (e.g. the Failed group's "Retry all").
   *  Rendered as a sibling of the toggle — never nested inside it — so its own
   *  click handler stays independent of the collapse toggle. */
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const { stage, count, collapsed, onToggle, action, children } = props;
  const tone = STAGE_TONE[stage];
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <section className="mb-1">
      <div className="group flex w-full items-center gap-1.5 rounded-md pr-1.5 transition-colors hover:bg-bg-2/50">
        <button
          type="button"
          onClick={() => onToggle?.(stage)}
          title={STAGE_HINT[stage]}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left"
        >
          <Chevron
            size={14}
            className="shrink-0 text-text-5 transition-transform"
          />
          <span
            className="text-[12px] font-semibold tracking-tight"
            style={{ color: tone }}
          >
            {STAGE_LABEL[stage]}
          </span>
          <span
            className="ml-0.5 rounded-full px-1.5 text-[10.5px] font-medium tabular-nums"
            style={{
              color: tone,
              background: `color-mix(in srgb, ${tone} 12%, transparent)`,
            }}
          >
            {count}
          </span>
          {!action && (
            <span className="ml-auto pr-1 text-[10.5px] text-text-5 opacity-0 transition-opacity group-hover:opacity-100">
              {STAGE_HINT[stage]}
            </span>
          )}
        </button>
        {action && <span className="shrink-0">{action}</span>}
      </div>

      {!collapsed && <div className="mt-0.5 space-y-0.5 pl-1">{children}</div>}
    </section>
  );
}
