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

type Props = {
  file: ChangedFile;
  isSelected: boolean;
  /** v0.2.7 Phase 5 — receives the MouseEvent so the caller can branch
   *  on Cmd/Shift modifiers. Plain click opens the diff in the active
   *  workpane; Shift opens it in a new tab; Cmd opens the file in
   *  edit (not diff) mode. */
  onClick: (e: React.MouseEvent) => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  /** Disable buttons while a mutation is in flight for this row. */
  isBusy?: boolean;
  /** Worktree path for the right-click "Reveal" / "Copy path" actions. */
  repoRoot?: string;
};

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

function statusColor(status: string): string {
  switch (status) {
    case "M":
      return "text-amber";
    case "A":
      return "text-green";
    case "D":
      return "text-red";
    case "R":
      return "text-violet";
    case "?":
      return "text-text-3";
    default:
      return "text-text-3";
  }
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

export function FileRow({
  file,
  isSelected,
  onClick,
  onStage,
  onUnstage,
  onDiscard,
  isBusy = false,
  repoRoot,
}: Props) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden py-1.5"
          >
            <span
              className={`shrink-0 w-4 h-4 rounded-sm flex items-center justify-center text-[10px] font-mono font-semibold bg-bg-1 ${statusColor(file.status)}`}
            >
              {statusGlyph(file.status)}
            </span>
            <span className="flex-1 min-w-0 flex items-center gap-1.5">
              <span className="text-[12px] text-text-1 text-start truncate overflow-hidden text-ellipsis">
                {name}
              </span>
              {showStats && (
                <span className="flex items-center gap-1 text-[10.5px] font-mono shrink-0 whitespace-nowrap font-medium">
                  {file.additions > 0 && (
                    <span className="text-green">+{file.additions}</span>
                  )}
                  {file.deletions > 0 && (
                    <span className="text-red">−{file.deletions}</span>
                  )}
                </span>
              )}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-[10.5px]">
          <div className="font-medium mb-0.5 truncate max-w-[260px]">{file.path}</div>
          <div className="text-text-3 leading-snug">
            click: diff &nbsp;·&nbsp; ⇧ click: new tab &nbsp;·&nbsp; ⌘ click: editor
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
