import {
  Circle,
  CircleAlert,
  GitPullRequestArrow,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  GitPullRequestClosed,
  ClipboardList,
  MessageCircleQuestion,
  HardDrive,
  X,
} from "lucide-react";
import { AsciiSpinner } from "./ascii-spinner";
export type WorkspaceStatus =
  | "idle"
  | "branch"
  | "local"
  | "unstarted"
  | "working"
  | "planning"
  | "waiting"
  | "cancelling"
  | "archiving"
  | "initializing"
  | "setting-up"
  | "review"
  | "review-plan"
  | "permission"
  | "question"
  | "done"
  | "merged"
  | "error"
  | "failed"
  | "checks-failing"
  | "checks-pending"
  | "open-pr"
  | "draft-pr"
  | "closed-pr"
  | "merge-queued"
  | "merge-conflict"
  | "ready-to-merge";
export const WORKSPACE_STATUS_LABELS: Record<WorkspaceStatus, string> = {
  idle: "Idle",
  branch: "Branch",
  local: "Local workspace",
  unstarted: "Not started",
  working: "Working",
  planning: "Planning",
  waiting: "Waiting for background tasks",
  cancelling: "Cancelling",
  archiving: "Archiving",
  initializing: "Initializing",
  "setting-up": "Setting up",
  review: "Ready to merge",
  "review-plan": "Review plan",
  permission: "Needs permission",
  question: "Answer question",
  done: "Merged",
  merged: "Merged",
  error: "Error",
  failed: "Initialization failed",
  "checks-failing": "Checks failing",
  "checks-pending": "Checks pending",
  "open-pr": "Open pull request",
  "draft-pr": "Draft pull request",
  "closed-pr": "Closed pull request",
  "merge-queued": "In merge queue",
  "merge-conflict": "Merge conflict",
  "ready-to-merge": "Ready to merge",
};
export function WorkspaceStatusIcon({
  status,
  unread,
  size = 14,
}: {
  status: WorkspaceStatus;
  unread?: boolean;
  size?: number;
}) {
  const busy = [
    "working",
    "planning",
    "waiting",
    "cancelling",
    "archiving",
    "initializing",
    "setting-up",
  ].includes(status);
  const attention = ["review-plan", "permission", "question"].includes(status);
  const Icon =
    status === "review-plan"
      ? ClipboardList
      : status === "question"
        ? MessageCircleQuestion
        : ["error", "failed", "permission"].includes(status)
          ? CircleAlert
          : status === "checks-failing"
            ? X
            : ["done", "merged", "merge-queued"].includes(status)
              ? GitMerge
              : status === "draft-pr"
                ? GitPullRequestDraft
                : status === "merge-conflict" || status === "closed-pr"
                  ? GitPullRequestClosed
                  : ["review", "ready-to-merge"].includes(status)
                    ? GitPullRequestArrow
                    : ["open-pr", "checks-pending"].includes(status)
                      ? GitPullRequest
                      : status === "local"
                        ? HardDrive
                        : status === "unstarted"
                          ? Circle
                          : GitBranch;
  return (
    <span
      className="ui-workspace-status"
      data-status={status}
      role="img"
      aria-label={
        unread && !busy && !attention ? "Unread activity" : WORKSPACE_STATUS_LABELS[status]
      }
      title={WORKSPACE_STATUS_LABELS[status]}
      style={{ width: size, height: size }}
    >
      {busy ? (
        <AsciiSpinner size={size} />
      ) : unread && !attention ? (
        <span className="ui-workspace-unread" />
      ) : (
        <Icon size={size} />
      )}
    </span>
  );
}
