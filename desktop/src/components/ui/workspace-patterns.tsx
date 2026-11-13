import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowUpRight,
  Check,
  Circle,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Pin,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import { Button } from "./button";
import { AsciiSpinner } from "./ascii-spinner";
import { Select } from "./select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu";
import {
  WorkspaceStatusIcon,
  WORKSPACE_STATUS_LABELS,
  type WorkspaceStatus,
} from "./workspace-status";
export type WorkspaceActivity = WorkspaceStatus;
export function WorkspaceActivityBadge({
  state,
  compact = false,
}: {
  state: WorkspaceActivity;
  compact?: boolean;
}) {
  return (
    <span className="ui-workspace-activity" data-state={state}>
      <WorkspaceStatusIcon status={state} />
      {!compact && WORKSPACE_STATUS_LABELS[state]}
    </span>
  );
}
export function WorkspaceActionsMenu({
  name,
  pinned,
  sections = [],
  onPin,
  onRename,
  onArchive,
  onMove,
  onCopyBranch,
  onOpen,
}: {
  name: string;
  pinned?: boolean;
  sections?: { id: string; label: string }[];
  onPin?: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  onMove?: (section: string) => void;
  onCopyBranch?: () => void;
  onOpen?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="iconXs" variant="ghost" aria-label={`${name} actions`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {onOpen && (
          <DropdownMenuItem onSelect={onOpen}>
            <ArrowUpRight />
            Open workspace
          </DropdownMenuItem>
        )}
        {onPin && (
          <DropdownMenuItem onSelect={onPin}>
            <Pin />
            {pinned ? "Unpin workspace" : "Pin workspace"}
          </DropdownMenuItem>
        )}
        {onRename && (
          <DropdownMenuItem onSelect={onRename}>
            <Pencil />
            Rename workspace
          </DropdownMenuItem>
        )}
        {onCopyBranch && (
          <DropdownMenuItem onSelect={onCopyBranch}>
            <GitBranch />
            Copy branch name
          </DropdownMenuItem>
        )}
        {onMove && sections.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to section</DropdownMenuSubTrigger>
            <DropdownMenuSubContent sideOffset={6}>
              {sections.map((section) => (
                <DropdownMenuItem key={section.id} onSelect={() => onMove(section.id)}>
                  {section.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {onArchive && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onArchive}>
              <Archive />
              Archive workspace
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function WorkspaceEmpty({
  type = "workspace",
  onCreate,
}: {
  type?: "workspace" | "repository" | "changes";
  onCreate?: () => void;
}) {
  const title =
    type === "changes"
      ? "No changes"
      : type === "repository"
        ? "No repositories yet"
        : "No workspaces yet";
  return (
    <div className="ui-pattern-empty">
      <GitBranch size={20} />
      <p>{title}</p>
      {onCreate && (
        <Button variant="outline" size="sm" onClick={onCreate}>
          {type === "repository" ? "Add repository" : "Create workspace"}
        </Button>
      )}
    </div>
  );
}
export function ChangeScopeToolbar({
  scope,
  onScopeChange,
  query,
  onQueryChange,
  branches,
}: {
  scope: string;
  onScopeChange: (scope: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  branches: { value: string; label: string }[];
}) {
  return (
    <div className="ui-change-toolbar">
      <Select aria-label="Change scope" value={scope} options={branches} onChange={onScopeChange} />
      <input
        aria-label="Filter changed files"
        placeholder="Filter files…"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
    </div>
  );
}
export interface DiffLine {
  type: "context" | "added" | "removed" | "hunk";
  content: string;
  oldLine?: number;
  newLine?: number;
}
export function FileDiff({ name, lines }: { name: string; lines: DiffLine[] }) {
  return (
    <section className="ui-file-diff">
      <header>{name}</header>
      <div role="table" aria-label={`Changes in ${name}`}>
        {lines.map((line, index) => (
          <div role="row" key={index} data-kind={line.type}>
            <span role="cell" className="ui-diff-line-number">
              {line.oldLine}
            </span>
            <span role="cell" className="ui-diff-line-number">
              {line.newLine}
            </span>
            <code role="cell">
              <span aria-hidden>
                {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
              </span>
              {line.content}
            </code>
          </div>
        ))}
      </div>
    </section>
  );
}
export interface CheckRun {
  id: string;
  title: string;
  status: "pending" | "running" | "passed" | "failed";
  detail?: string;
}
export function CheckRunList({
  checks,
  onRetry,
}: {
  checks: CheckRun[];
  onRetry?: (id: string) => void;
}) {
  if (!checks.length) return <div className="ui-pattern-empty">No checks have run.</div>;
  return (
    <div className="ui-check-runs">
      {checks.map((check) => (
        <div key={check.id} data-status={check.status}>
          {check.status === "running" ? (
            <AsciiSpinner />
          ) : check.status === "passed" ? (
            <Check size={14} />
          ) : check.status === "failed" ? (
            <X size={14} />
          ) : (
            <Circle size={14} />
          )}
          <span>
            {check.title}
            {check.detail && <small>{check.detail}</small>}
          </span>
          {check.status === "failed" && onRetry && (
            <Button
              size="iconXs"
              variant="ghost"
              aria-label={`Retry ${check.title}`}
              onClick={() => onRetry(check.id)}
            >
              <RefreshCw />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
export function BackgroundTask({
  title,
  startedAt,
  status,
  children,
  onStop,
}: {
  title: string;
  startedAt: number;
  status: "running" | "done" | "error";
  children?: ReactNode;
  onStop?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status]);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <section className="ui-background-task">
      <header>
        {status === "running" ? (
          <AsciiSpinner />
        ) : status === "error" ? (
          <X size={14} />
        ) : (
          <Check size={14} />
        )}
        <span>{title}</span>
        <small>
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </small>
        {status === "running" && onStop && (
          <Button size="xs" variant="outline" onClick={onStop}>
            Stop
          </Button>
        )}
      </header>
      {children}
    </section>
  );
}
export function Participants({ names }: { names: string[] }) {
  return (
    <div className="ui-participants">
      <Users size={14} />
      {names.map((name) => (
        <span key={name} title={name}>
          {name}
        </span>
      ))}
    </div>
  );
}
