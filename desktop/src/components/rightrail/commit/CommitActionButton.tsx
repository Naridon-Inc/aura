// The commit box's one button and its menu: the action the branch needs next
// (Commit, Push, Pull, Sync, Publish branch) with every other git action one
// chevron away. Drawn as the details panel's split button so it reads as the
// same control as the toolbar's git action above it.

import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Check,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import type { AheadBehind } from "../../../lib/api";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import type { PrimaryActionState, PrimaryActionType } from "../getPrimaryAction";

type Props = {
  primary: PrimaryActionState;
  ahead: AheadBehind;
  /** The branch has been read at least once; until then Push can't say
   *  whether it would publish. */
  aheadRead: boolean;
  canCommit: boolean;
  busy: boolean;
  onPrimary: () => void;
  onCommit: () => void;
  onCommitAndPush: () => void;
  onPush: () => void;
  onPull: () => void;
  onSync: () => void;
  onFetch: () => void;
};

export function CommitActionButton({
  primary,
  ahead,
  aheadRead,
  canCommit,
  busy,
  onPrimary,
  onCommit,
  onCommitAndPush,
  onPush,
  onPull,
  onSync,
  onFetch,
}: Props) {
  const count =
    primary.action === "push"
      ? String(ahead.ahead)
      : primary.action === "pull"
        ? String(ahead.behind)
        : primary.action === "sync"
          ? `${ahead.behind}/${ahead.ahead}`
          : null;
  return (
    <div className="ui-git-action-group">
      <Button
        size="sm"
        variant={primary.action === "commit" ? "default" : "outline"}
        onClick={onPrimary}
        disabled={primary.disabled}
        title={primary.tooltip}
      >
        <ActionIcon action={primary.action} />
        <span className="ui-details-commit-label">{primary.label}</span>
        {count != null && <span className="ui-details-commit-count">{count}</span>}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="iconSm"
            variant="outline"
            disabled={busy}
            aria-label="More commit actions"
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onCommit} disabled={!canCommit}>
            <Check />
            Commit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCommitAndPush} disabled={!canCommit}>
            <ArrowUp />
            Commit and push
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onPush}
            disabled={!aheadRead || (ahead.ahead === 0 && ahead.has_upstream)}
          >
            <ArrowUp />
            <span className="ui-details-commit-label">
              {!aheadRead || ahead.has_upstream ? "Push" : "Publish branch"}
            </span>
            {ahead.ahead > 0 && (
              <span className="ui-details-commit-count">{ahead.ahead}</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onPull} disabled={ahead.behind === 0}>
            <ArrowDown />
            <span className="ui-details-commit-label">Pull</span>
            {ahead.behind > 0 && (
              <span className="ui-details-commit-count">{ahead.behind}</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onSync}
            disabled={ahead.ahead === 0 && ahead.behind === 0}
          >
            <ArrowDownUp />
            Sync
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onFetch} title="Check for new commits from teammates">
            <RefreshCw />
            Fetch
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ActionIcon({ action }: { action: PrimaryActionType }) {
  if (action === "commit") return <Check size={12} />;
  if (action === "pull") return <ArrowDown size={12} />;
  if (action === "sync") return <ArrowDownUp size={12} />;
  return <ArrowUp size={12} />;
}
