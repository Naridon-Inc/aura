import {
  GitBranch,
  GitPullRequest,
  GitPullRequestDraft,
  GitMerge,
  ArrowUpRight,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Check,
  CircleAlert,
  TriangleAlert,
} from "lucide-react";
import { Button } from "./button";
import { AsciiSpinner } from "./ascii-spinner";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu";
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from "./popover";
import { Tooltip } from "./tooltip";
export type GitWorkflowState =
  | "no-pr"
  | "uncommitted"
  | "ahead"
  | "behind"
  | "diverged"
  | "conflicts"
  | "draft"
  | "checks-failing"
  | "checks-pending"
  | "changes-requested"
  | "review-required"
  | "ready"
  | "queued"
  | "merged"
  | "closed"
  | "blocked"
  | "working"
  | "loading"
  | "creating-pr"
  | "pushing"
  | "pulling"
  | "merging"
  | "approve-pr"
  | "unable-to-merge"
  | "stack-blocked";
export type GitWorkflowAction =
  | "create-pr"
  | "create-draft-pr"
  | "create-pr-manually"
  | "commit-push"
  | "push"
  | "pull"
  | "sync"
  | "resolve-conflicts"
  | "ready-for-review"
  | "fix-checks"
  | "address-comments"
  | "review"
  | "merge"
  | "archive"
  | "open-pr"
  | "cancel-merge"
  | "enable-auto-merge"
  | "disable-auto-merge"
  | "approve-pr"
  | "view-checks"
  | "view-logs"
  | "continue";
export interface GitWorkflow {
  state: GitWorkflowState;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  targetBranch?: string;
  ahead?: number;
  behind?: number;
  changedFiles?: number;
  failedChecks?: number;
  totalChecks?: number;
  pendingChecks?: number;
  detail?: string;
  autoMergeEnabled?: boolean;
  canAutoMerge?: boolean;
  hasFixableChecks?: boolean;
  logsAvailable?: boolean;
  hasPendingComments?: boolean;
  /** How Merge merges ("Squash and merge"), shown over the button where
   *  tooltips are on; "Merge" when unset. */
  mergeTooltip?: string;
  /** Replaces the state's label (a failed first read names the failure). */
  label?: string;
  /** Draws the label in the warning colour. */
  warningTone?: boolean;
  /** Why the pull request info couldn't be read; the row then opens these
   *  details instead of the git summary. */
  issue?: GitWorkflowIssue;
}
export type GitWorkflowIssueAction = "retry" | "open-settings";
export interface GitWorkflowIssue {
  title: string;
  description: string;
  action?: GitWorkflowIssueAction;
}
export const GIT_WORKFLOW_LABELS: Record<GitWorkflowState, string> = {
  "no-pr": "No PR open",
  uncommitted: "Uncommitted changes",
  ahead: "Ahead of remote",
  behind: "Behind remote",
  diverged: "Incompatible with remote",
  conflicts: "Merge conflicts",
  draft: "Draft PR open",
  "checks-failing": "Checks failed",
  "checks-pending": "Checks pending…",
  "changes-requested": "PR changes requested",
  "review-required": "PR review required",
  ready: "Ready to merge",
  queued: "Queued to merge",
  merged: "Merged",
  closed: "PR closed",
  blocked: "Blocked from merging",
  working: "Working…",
  loading: "Loading status…",
  "creating-pr": "Creating PR…",
  pushing: "Pushing…",
  pulling: "Pulling…",
  merging: "Merging…",
  "approve-pr": "PR review required",
  "unable-to-merge": "Unable to merge",
  "stack-blocked": "Stack blocked",
};
const actions: Partial<Record<GitWorkflowState, [string, GitWorkflowAction]>> = {
  "no-pr": ["Create PR", "create-pr"],
  uncommitted: ["Commit and push", "commit-push"],
  ahead: ["Push", "push"],
  behind: ["Pull", "pull"],
  diverged: ["Resolve", "sync"],
  conflicts: ["Resolve", "resolve-conflicts"],
  draft: ["Ready for review", "ready-for-review"],
  "checks-failing": ["Fix errors", "fix-checks"],
  "changes-requested": ["Add all comments to chat", "address-comments"],
  "approve-pr": ["Approve PR", "approve-pr"],
  ready: ["Merge", "merge"],
  merged: ["Archive", "archive"],
  closed: ["Archive", "archive"],
};
export function GitWorkflowActions({
  workflow,
  onAction,
  compact = false,
  showContinue = false,
  showTooltips = false,
}: {
  workflow: GitWorkflow;
  onAction?: (action: GitWorkflowAction) => void;
  compact?: boolean;
  showContinue?: boolean;
  /** Off in previews and hover cards. */
  showTooltips?: boolean;
}) {
  const action: [string, GitWorkflowAction] | undefined =
    workflow.state === "checks-pending"
      ? workflow.canAutoMerge
        ? [
            workflow.autoMergeEnabled ? "Disable auto-merge" : "Automerge",
            workflow.autoMergeEnabled ? "disable-auto-merge" : "enable-auto-merge",
          ]
        : undefined
      : workflow.state === "checks-failing" && workflow.hasFixableChecks === false
        ? [
            workflow.logsAvailable ? "View logs" : "View checks",
            workflow.logsAvailable ? "view-logs" : "view-checks",
          ]
        : workflow.state === "changes-requested" && workflow.hasPendingComments === false
          ? undefined
          : actions[workflow.state];
  if (workflow.state === "queued") return <span className="ui-git-queued">Queued</span>;
  if (workflow.state === "working") return <AsciiSpinner />;
  if (!action) return null;
  const Icon =
    workflow.state === "no-pr"
      ? GitPullRequest
      : workflow.state === "ready"
        ? GitMerge
        : workflow.state === "ahead"
          ? ArrowUp
          : workflow.state === "behind"
            ? ArrowDown
            : GitBranch;
  const button = (
    <Button
      size={compact ? "xs" : "sm"}
      variant={
        ["no-pr", "draft", "checks-pending"].includes(workflow.state) ? "outline" : "default"
      }
      disabled={!onAction}
      onClick={() => onAction?.(action[1])}
    >
      <Icon size={12} />
      {action[0]}
    </Button>
  );
  return (
    <div
      className="ui-git-action-group"
      data-state={workflow.state}
      onClick={(event) => event.stopPropagation()}
    >
      {showTooltips && workflow.state === "ready" ? (
        <Tooltip content={workflow.mergeTooltip ?? action[0]}>{button}</Tooltip>
      ) : (
        button
      )}
      {workflow.state === "merged" && showContinue && (
        <Button
          size={compact ? "xs" : "sm"}
          variant="outline"
          disabled={!onAction}
          onClick={() => onAction?.("continue")}
        >
          Continue
        </Button>
      )}
      {workflow.state === "no-pr" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="iconXs" variant="outline" aria-label="Create PR options">
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!onAction} onSelect={() => onAction?.("create-draft-pr")}>
              <GitPullRequestDraft />
              Create draft PR
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!onAction}
              onSelect={() => onAction?.("create-pr-manually")}
            >
              <ArrowUpRight />
              Create PR manually
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
export function GitWorkflowToolbar({
  workflow,
  onAction,
  onOpenPr,
  onOpenExternal,
  onIssueAction,
}: {
  workflow: GitWorkflow;
  onAction?: (action: GitWorkflowAction) => void;
  onOpenPr?: () => void;
  onOpenExternal?: () => void;
  onIssueAction?: (action: GitWorkflowIssueAction) => void;
}) {
  const busy = ["working", "loading", "creating-pr", "pushing", "pulling", "merging"].includes(
    workflow.state,
  );
  const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;
  const issue = workflow.issue;
  const label =
    workflow.label ??
    (workflow.state === "ahead"
      ? `Ahead by ${commits(workflow.ahead ?? 1)}`
      : workflow.state === "behind"
        ? `Behind by ${commits(workflow.behind ?? 1)}`
        : workflow.state === "checks-failing" && workflow.totalChecks
          ? `${workflow.failedChecks ?? 1} / ${workflow.totalChecks} checks failed`
          : GIT_WORKFLOW_LABELS[workflow.state]);
  return (
    <div className="ui-git-toolbar" data-state={workflow.state}>
      {workflow.prNumber && (
        <div className="ui-git-pr-link">
          <Button size="xs" variant="outline" onClick={onOpenPr}>
            #{workflow.prNumber}
          </Button>
          <Button
            size="iconXs"
            variant="outline"
            aria-label="Open in GitHub"
            disabled={!onOpenExternal && !workflow.prUrl}
            onClick={
              onOpenExternal ?? (() => window.open(workflow.prUrl, "_blank", "noopener,noreferrer"))
            }
          >
            <ArrowUpRight />
          </Button>
        </div>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="ui-git-summary"
            data-tone={workflow.warningTone ? "warning" : undefined}
            aria-label={issue ? `${label}. Show details` : `Git status: ${label}`}
          >
            {busy ? (
              <AsciiSpinner />
            ) : issue ? (
              <TriangleAlert size={12} className="ui-git-summary-warning" />
            ) : workflow.state === "merged" ? (
              <GitMerge size={14} />
            ) : workflow.state === "ready" ? (
              <Check size={14} />
            ) : workflow.state === "conflicts" ? (
              <CircleAlert size={14} />
            ) : (
              <GitBranch size={14} />
            )}
            <span>{label}</span>
          </button>
        </PopoverTrigger>
        {issue ? (
          <PopoverContent
            align="start"
            side="bottom"
            sideOffset={4}
            role="dialog"
            aria-label="PR status details"
            className="ui-git-issue-popover"
          >
            <div className="ui-git-issue-text">
              <p className="ui-git-issue-title">{issue.title}</p>
              <p className="ui-git-issue-description">{issue.description}</p>
            </div>
            {issue.action && (
              <PopoverClose asChild>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => onIssueAction?.(issue.action!)}
                >
                  {issue.action === "retry" ? "Retry" : "Open settings"}
                </Button>
              </PopoverClose>
            )}
          </PopoverContent>
        ) : (
          <PopoverContent align="end" className="ui-git-summary-popover">
            <strong>{label}</strong>
            <dl>
              <dt>Current branch</dt>
              <dd>{workflow.branch ?? "workspace"}</dd>
              <dt>Target branch</dt>
              <dd>{workflow.targetBranch ?? "main"}</dd>
              {workflow.changedFiles != null && (
                <>
                  <dt>Uncommitted changes</dt>
                  <dd>{workflow.changedFiles} files</dd>
                </>
              )}
            </dl>
            {workflow.detail && <p>{workflow.detail}</p>}
            <GitWorkflowActions workflow={workflow} onAction={onAction} />
          </PopoverContent>
        )}
      </Popover>
      {!(issue && workflow.label) && (
        <GitWorkflowActions
          workflow={workflow}
          onAction={onAction}
          compact
          showContinue
          showTooltips
        />
      )}
    </div>
  );
}

export interface GitCommitSummary {
  id: string;
  message: string;
  author: string;
  date: string;
}
export function GitChangeScope({
  branch,
  targetBranch,
  branches,
  scope,
  onScopeChange,
  onTargetBranchChange,
  commits = [],
  changedFiles,
  label: shownLabel,
}: {
  /** Left out, the menu names no current branch. */
  branch?: string;
  /** Left out (or with no handler), the menu offers no target branch. */
  targetBranch?: string;
  branches?: string[];
  scope: string;
  onScopeChange: (scope: string) => void;
  onTargetBranchChange?: (branch: string) => void;
  commits?: GitCommitSummary[];
  /** Left out, the menu offers no Uncommitted changes scope: a host that
   *  can't see the working tree can't scope to it. */
  changedFiles?: number;
  /** What the trigger reads, such as "3 files changed". Left out, it names
   *  the scope. */
  label?: string;
}) {
  const target = targetBranch !== undefined && !!onTargetBranchChange;
  const label =
    shownLabel ??
    (scope === "all"
      ? "All changes"
      : scope === "uncommitted"
        ? "Uncommitted changes"
        : (commits.find((c) => c.id === scope)?.message ?? "All changes"));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="ui-change-scope-trigger">
          {label}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="ui-change-scope-menu">
        {branch !== undefined && (
          <DropdownMenuLabel>
            Current branch <code>{branch}</code>
          </DropdownMenuLabel>
        )}
        {target && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              Target branch <code>{targetBranch}</code>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {(branches ?? []).map((name) => (
                <DropdownMenuItem key={name} onSelect={() => onTargetBranchChange(name)}>
                  {name}
                  {name === targetBranch && <Check size={12} />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {(branch !== undefined || target) && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => onScopeChange("all")}>
          All changes{scope === "all" && <Check size={12} />}
        </DropdownMenuItem>
        {changedFiles !== undefined && (
          <DropdownMenuItem onSelect={() => onScopeChange("uncommitted")}>
            Uncommitted changes <small>{changedFiles} files</small>
            {scope === "uncommitted" && <Check size={12} />}
          </DropdownMenuItem>
        )}
        {!!commits.length && <DropdownMenuSeparator />}
        {commits.map((commit) => (
          <DropdownMenuItem key={commit.id} onSelect={() => onScopeChange(commit.id)}>
            <span className="ui-commit-scope-item">
              <span>{commit.message}</span>
              <small>
                {commit.id} • {commit.author} • {commit.date}
              </small>
            </span>
            {scope === commit.id && <Check size={12} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
