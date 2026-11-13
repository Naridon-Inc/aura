import { type ReactNode } from "react";
import { ArrowUpRight, Check, CircleDashed, CircleX } from "lucide-react";
import { DiffCount } from "./sidebar";
import { HoverCard, HoverCardTrigger, HoverCardContent, useHoverCardDismiss } from "./hover-card";
import {
  GitWorkflowActions,
  type GitWorkflow,
  type GitWorkflowAction,
} from "./git-workflow";
export type WorkspaceStage =
  | "backlog"
  | "in-progress"
  | "in-review"
  | "done"
  | "canceled";
export const WORKSPACE_STAGES: { id: WorkspaceStage; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "in-progress", label: "In progress" },
  { id: "in-review", label: "In review" },
  { id: "done", label: "Done" },
  { id: "canceled", label: "Canceled" },
];
export interface WorkspaceOverview {
  id: string;
  title: string;
  branch: string;
  project: string;
  projectId: string;
  stage: WorkspaceStage;
  summary?: string;
  updatedAt: number;
  createdAt?: number;
  timeLabel: string;
  added?: number;
  removed?: number;
  archived?: boolean;
  unread?: boolean;
  workflow: GitWorkflow;
}
export function WorkspaceStageIcon({ stage }: { stage: WorkspaceStage }) {
  return (
    <span className="ui-workspace-stage" data-stage={stage}>
      {stage === "backlog" ? (
        <CircleDashed />
      ) : stage === "done" ? (
        <Check />
      ) : stage === "canceled" ? (
        <CircleX />
      ) : (
        <svg viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
          <path
            d={
              stage === "in-progress"
                ? "M8 2a6 6 0 0 1 0 12Z"
                : "M8 2a6 6 0 1 1-6 6h6Z"
            }
            fill="currentColor"
          />
        </svg>
      )}
    </span>
  );
}
export function WorkspacePreviewCard({
  workspace,
  onAction,
  onOpenPr,
}: {
  workspace: WorkspaceOverview;
  onAction?: (action: GitWorkflowAction) => void;
  onOpenPr?: () => void;
}) {
  return (
    <div className="ui-workspace-card-content">
      <div className="ui-workspace-card-meta">
        <span title={workspace.branch}>{workspace.branch}</span>
        {workspace.added != null && (
          <DiffCount added={workspace.added} removed={workspace.removed ?? 0} />
        )}
        <WorkspaceStageIcon stage={workspace.stage} />
      </div>
      <strong className="ui-workspace-card-title">{workspace.title}</strong>
      {workspace.summary && (
        <p className="ui-workspace-card-summary">{workspace.summary}</p>
      )}
      <footer>
        <GitWorkflowActions
          workflow={workspace.workflow}
          onAction={onAction}
          compact
        />
        {workspace.workflow.prNumber && (
          <button
            className="ui-workspace-card-pr"
            onClick={(event) => {
              event.stopPropagation();
              onOpenPr?.();
            }}
          >
            #{workspace.workflow.prNumber}
            <ArrowUpRight size={10} />
          </button>
        )}
        <time>{workspace.timeLabel}</time>
      </footer>
    </div>
  );
}
export function WorkspaceHoverPreview({
  workspace,
  children,
  side = "right",
  onAction,
  onOpenPr,
}: {
  workspace: WorkspaceOverview;
  children: ReactNode;
  side?: "right" | "bottom";
  onAction?: (action: GitWorkflowAction) => void;
  onOpenPr?: () => void;
}) {
  const { open, onOpenChange, triggerRef } = useHoverCardDismiss();
  return (
    <HoverCard openDelay={450} closeDelay={150} open={open} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild ref={triggerRef}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side={side}
        align="start"
        sideOffset={side === "bottom" ? 6 : 10}
        collisionPadding={12}
        className="ui-workspace-hover"
      >
        <WorkspacePreviewCard
          workspace={workspace}
          onAction={onAction}
          onOpenPr={onOpenPr}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
