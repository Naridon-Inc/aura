// TasksViewsBar — OO.2 Phase 2 (Plane parity).
//
// Browser-tabs-style row of saved view pills above the filter bar.
// Active view highlighted; right-most `+` creates a new view from the
// current filter/group/order/displayProp state; right-click a view
// opens rename/delete via a context menu.
//
// Source of truth: `<repoRoot>/.aura/tasks/views.json` (loaded via
// `api.taskViewsList`). The currently-selected view id is held by the
// parent (TasksBoard) and mirrored to localStorage so refreshes land
// back on the same view.
//
// "All" pseudo-view: when `activeId` is `null` we render an implicit
// "All issues" pill on the left so a fresh repo with zero saved views
// still shows the chrome.

import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import type { TaskView } from "../../lib/api";

type Props = {
  views: TaskView[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** Dirty bit: are the active filters different from the saved view? */
  dirty?: boolean;
  /** Save the current state into the active view (only meaningful when
   *  `activeId` is set and `dirty` is true). */
  onSaveActive?: () => Promise<void>;
};

export function TasksViewsBar({
  views,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  dirty = false,
  onSaveActive,
}: Props) {
  const [namingOpen, setNamingOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<TaskView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TaskView | null>(null);

  return (
    <div className="border-b-[0.5px] border-line-soft bg-bg-content">
      {/* Non-scrolling border wrapper + inner horizontal scroller. The
          border lives on the wrapper so the scroller can overflow-x
          without `overflow-y: auto` clipping each active tab's underline
          (the old `-mb-[1px]` trick got cropped on the bottom edge). */}
      <div className="px-4 sm:px-6 h-9 flex items-center gap-0.5 overflow-x-auto no-scrollbar">
        <ViewPill
          label="All issues"
          active={activeId === null}
          onClick={() => onSelect(null)}
        />
        {views.map((v) => (
          <ContextMenu key={v.id}>
            <ContextMenuTrigger asChild>
              <div className="shrink-0">
                <ViewPill
                  label={v.name}
                  active={v.id === activeId}
                  onClick={() => onSelect(v.id)}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-[160px]">
              <ContextMenuItem
                className="text-[11.5px]"
                onSelect={() => setRenameTarget(v)}
              >
                <Pencil className="w-3 h-3 mr-2" strokeWidth={1.5} aria-hidden />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                className="text-[11.5px] text-rose-300 focus:text-rose-200"
                onSelect={() => setConfirmDelete(v)}
              >
                <Trash2 className="w-3 h-3 mr-2" strokeWidth={1.5} aria-hidden />
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}

        {/* Save-active button — only visible when a view is selected AND its
            state has drifted from disk. Mirrors VSCode's "*" dirty marker. */}
        {activeId && dirty && onSaveActive && (
          <button
            type="button"
            onClick={() => void onSaveActive()}
            title="Save changes to this view"
            className="shrink-0 text-[10.5px] px-1.5 h-[22px] rounded bg-amber-500/15 border border-amber-500/30 text-amber-200 hover:bg-amber-500/25 ml-1"
          >
            Save view
          </button>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setNamingOpen(true)}
          title="New view from current filters"
          className="shrink-0 ml-1 gap-0.5 text-[11px] text-text-4 hover:text-text-1 hover:bg-bg-2"
        >
          <Plus className="w-3 h-3" strokeWidth={1.5} aria-hidden />
          <span>New view</span>
        </Button>
      </div>

      <NameDialog
        open={namingOpen}
        title="New view"
        initial=""
        onCancel={() => setNamingOpen(false)}
        onConfirm={async (name) => {
          await onCreate(name);
          setNamingOpen(false);
        }}
      />
      <NameDialog
        open={renameTarget !== null}
        title="Rename view"
        initial={renameTarget?.name ?? ""}
        onCancel={() => setRenameTarget(null)}
        onConfirm={async (name) => {
          if (renameTarget) await onRename(renameTarget.id, name);
          setRenameTarget(null);
        }}
      />
      <ConfirmDelete
        open={confirmDelete !== null}
        viewName={confirmDelete?.name ?? ""}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (confirmDelete) await onDelete(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

function ViewPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative shrink-0 inline-flex items-center h-9 px-2.5 text-[12px] whitespace-nowrap transition-colors",
        active ? "text-text-1 font-medium" : "text-text-4 hover:text-text-2",
      )}
    >
      {label}
      {active && (
        <span
          aria-hidden
          className="absolute inset-x-1.5 bottom-0 h-[2px] rounded-full bg-accent"
        />
      )}
    </button>
  );
}

function NameDialog({
  open,
  title,
  initial,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  initial: string;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  // Reset local state whenever we open with a fresh `initial`.
  // Using `key` on the parent component is simpler than an effect.
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
        else setName(initial);
      }}
    >
      <DialogContent className="max-w-[400px] bg-bg-chrome border-line-soft text-text-1">
        <DialogHeader>
          <DialogTitle className="text-[14px]">{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim() && !busy) {
              setBusy(true);
              void Promise.resolve(onConfirm(name.trim())).finally(() =>
                setBusy(false),
              );
            }
          }}
          placeholder="View name"
          className="w-full text-[13px]"
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!name.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(name.trim());
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDelete({
  open,
  viewName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  viewName: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[400px] bg-bg-chrome border-line-soft text-text-1">
        <DialogHeader>
          <DialogTitle className="text-[14px]">Delete view?</DialogTitle>
        </DialogHeader>
        <div className="text-[12.5px] text-text-3">
          "{viewName}" will be removed from this repo's views.json. Filters and
          tasks are not affected.
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="text-[12px] text-text-3 hover:text-text-1 hover:bg-bg-2"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
            className="text-[12px]"
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Generate a stable slug from a freeform view name. Mirrors the small
// slug helper in cmd_team etc. — kebab-case, ASCII-only, capped length.
export function slugifyViewName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || `view-${Date.now().toString(36)}`;
}
