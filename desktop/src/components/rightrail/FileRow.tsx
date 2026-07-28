// One row in the right-rail Changes panel. Status letter + filename +
// per-row +N -N stats + hover-only stage/unstage/discard actions +
// right-click context menu. Mirrors Superset's FileItem layout but
// reuses Aura's existing Tauri git surface (no tRPC).

import { useState } from "react";
import type { ChangedFile } from "../../lib/useGitChanges";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { InlineDiff } from "./InlineDiff";
import { Churn } from "../diff/Churn";

type Props = {
  file: ChangedFile;
  isSelected: boolean;
  /** Row click routes to the work surface: a plain click opens the Monaco diff
   *  view; Shift opens the diff in a new tab; Cmd/Ctrl opens the file in edit
   *  mode. Receives the MouseEvent so the caller can branch on the modifiers.
   *  The inline +/− peek is a separate affordance on the leading caret. */
  onClick: (e: React.MouseEvent) => void;
  /** Marks the row active (selection highlight) — fired alongside the click. */
  onSelect?: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  /** Disable buttons while a mutation is in flight for this row. */
  isBusy?: boolean;
  /** Worktree path for the right-click "Reveal" / "Copy path" actions, and
   *  the root the inline diff fetches against. */
  repoRoot?: string;
};

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

function statusGlyph(status: string): string {
  switch (status) {
    case "M":
      return "M";
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    case "?":
      return "U";
    default:
      return "·";
  }
}

/** What the letter means, in words — the badge is a one-letter shorthand, so
 *  the hover carries the plain-language read for anyone who doesn't know it. */
function statusWord(status: string): string {
  switch (status) {
    case "M":
      return "edited";
    case "A":
      return "added";
    case "D":
      return "removed";
    case "R":
      return "renamed";
    case "?":
      return "brand new — not tracked yet";
    default:
      return "changed";
  }
}

export function FileRow({
  file,
  isSelected,
  onClick,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  isBusy = false,
  repoRoot,
}: Props) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const name = fileName(file.path);
  const showStats = file.additions > 0 || file.deletions > 0;
  const isDelete = file.status === "?" || file.status === "A";
  const discardLabel = isDelete ? "Delete" : "Discard";

  function copyPath() {
    if (!repoRoot) return;
    const abs = `${repoRoot}/${file.path}`;
    navigator.clipboard.writeText(abs).catch(() => {});
  }
  function copyRelative() {
    navigator.clipboard.writeText(file.path).catch(() => {});
  }

  function handleDiscardClick() {
    if (confirmDiscard) {
      onDiscard?.();
      setConfirmDiscard(false);
    } else {
      setConfirmDiscard(true);
      window.setTimeout(() => setConfirmDiscard(false), 2500);
    }
  }

  const row = (
    <div
      className={`group w-full flex items-stretch gap-1 px-2 text-left rounded-sm cursor-pointer transition-colors ${
        isSelected ? "bg-bg-2" : "hover:bg-bg-2/60"
      }`}
    >
      {/* Leading caret — the secondary affordance: toggles the inline +/−
          peek in the rail without leaving it. Stops propagation so the row's
          primary click (open the Monaco diff) doesn't also fire. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
        aria-label={expanded ? "Hide inline diff" : "Peek diff inline"}
        aria-expanded={expanded}
        className="shrink-0 flex items-center justify-center w-4 text-text-5 hover:text-text-2 transition-colors"
      >
        <span
          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden
        >
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
            <path
              d="M6 3l5 5-5 5"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              // Primary action: open the file in the work surface. Plain click
              // → Monaco diff view; Shift → new tab; Cmd/Ctrl → editor (all
              // resolved from the modifiers inside `onClick`).
              onSelect?.();
              onClick(e);
            }}
            className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden py-1.5"
          >
            <span
              className="shrink-0 w-4 h-4 rounded-sm flex items-center justify-center text-[10px] font-mono font-semibold bg-bg-1 text-text-3"
              title={statusWord(file.status)}
            >
              {statusGlyph(file.status)}
            </span>
            <span className="flex-1 min-w-0 flex items-center gap-1.5">
              <span className="text-[12px] text-text-1 text-start truncate overflow-hidden text-ellipsis">
                {name}
              </span>
              {showStats && (
                <Churn
                  additions={file.additions}
                  deletions={file.deletions}
                  className="text-[10.5px]"
                />
              )}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-[10.5px]">
          <div className="font-medium mb-0.5 truncate max-w-[260px]">{file.path}</div>
          <div className="text-text-3 leading-snug">
            click: diff view &nbsp;·&nbsp; ⇧ click: new tab &nbsp;·&nbsp; ⌘ click: editor
          </div>
        </TooltipContent>
      </Tooltip>
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {onDiscard && (
          <RowAction
            label={confirmDiscard ? `Confirm ${discardLabel.toLowerCase()}` : discardLabel}
            destructive={confirmDiscard}
            onClick={handleDiscardClick}
            disabled={isBusy}
          >
            {isDelete ? (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 5h10M5.5 5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M4 5l1 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l1-9"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </RowAction>
        )}
        {onStage && (
          <RowAction label="Stage" onClick={onStage} disabled={isBusy}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 3v10M3 8h10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </RowAction>
        )}
        {onUnstage && (
          <RowAction label="Unstage" onClick={onUnstage} disabled={isBusy}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <path
                d="M3 8h10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </RowAction>
        )}
      </div>
    </div>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onClick={copyPath}>Copy path</ContextMenuItem>
          <ContextMenuItem onClick={copyRelative}>
            Copy relative path
          </ContextMenuItem>
          {(onStage || onUnstage || onDiscard) && <ContextMenuSeparator />}
          {onStage && (
            <ContextMenuItem onClick={onStage} disabled={isBusy}>
              Stage
            </ContextMenuItem>
          )}
          {onUnstage && (
            <ContextMenuItem onClick={onUnstage} disabled={isBusy}>
              Unstage
            </ContextMenuItem>
          )}
          {onDiscard && (
            <ContextMenuItem
              onClick={onDiscard}
              disabled={isBusy}
              className="text-red focus:text-red"
            >
              {discardLabel}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {expanded && repoRoot && <InlineDiff repoRoot={repoRoot} path={file.path} />}
    </>
  );
}

function RowAction({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          disabled={disabled}
          className={`size-5 rounded flex items-center justify-center transition-colors ${
            disabled
              ? "text-text-5"
              : destructive
                ? "text-red hover:bg-red/15"
                : "text-text-3 hover:text-text-1 hover:bg-bg-1"
          }`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
