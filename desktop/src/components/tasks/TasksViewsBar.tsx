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
import { Segment } from "../ui/segment";
import type { TaskView } from "../../lib/api";

// Sentinel value for the implicit "All issues" cell — kept out of the
// view-id namespace (slugs are kebab-case, so no underscores collide).
const ALL_VIEWS = "__all__";

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
  // The saved view under the cursor when the Segment was right-clicked —
  // drives which view rename/delete act on. Null for the "All issues"
  // cell (which has nothing to rename or delete).
  const [ctxView, setCtxView] = useState<TaskView | null>(null);

  const options = [
    { value: ALL_VIEWS, label: "All issues" },
    ...views.map((v) => ({ value: v.id, label: v.name })),
  ];

  return (
    <div className="border-b-[0.5px] border-line-soft bg-bg-content">
      {/* The view switcher uses the shared Segment control; a right-click
          on a saved cell resolves back to its view (via data-segment-value)
          to keep the rename/delete menu. The scroller lets a long set of
          views overflow-x without clipping the Segment's rounded track. */}
      <div className="px-4 sm:px-6 h-9 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
        <ContextMenu onOpenChange={(open) => !open && setCtxView(null)}>
          <ContextMenuTrigger asChild>
            <div
              className="shrink-0"
              onContextMenuCapture={(e) => {
                const cell = (e.target as HTMLElement).closest(
                  "[data-segment-value]",
                );
                const val = cell?.getAttribute("data-segment-value") ?? null;
                const v = val ? views.find((x) => x.id === val) ?? null : null;
                setCtxView(v);
                // No real view under the cursor ("All issues" or the gap) →
                // suppress the menu entirely rather than open an empty one.
                if (!v) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
            >
              <Segment
                ariaLabel="Task views"
                value={activeId ?? ALL_VIEWS}
                onChange={(val) => onSelect(val === ALL_VIEWS ? null : val)}
                options={options}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-[160px]">
            <ContextMenuItem
              className="text-[11.5px]"
              onSelect={() => ctxView && setRenameTarget(ctxView)}
            >
              <Pencil className="w-3 h-3 mr-2" strokeWidth={1.5} aria-hidden />
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              className="text-[11.5px] text-red focus:text-red"
              onSelect={() => ctxView && setConfirmDelete(ctxView)}
            >
              <Trash2 className="w-3 h-3 mr-2" strokeWidth={1.5} aria-hidden />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/* Save-active button — only visible when a view is selected AND its
            state has drifted from disk. Mirrors VSCode's "*" dirty marker. */}
        {activeId && dirty && onSaveActive && (
          <button
            type="button"
            onClick={() => void onSaveActive()}
            title="Save changes to this view"
            className="shrink-0 text-[10.5px] px-1.5 h-[22px] rounded bg-accent/15 border border-accent/30 text-accent hover:bg-accent/25"
          >
            Save view
          </button>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setNamingOpen(true)}
          title="New view from current filters"
          className="shrink-0 gap-0.5 text-[11px] text-text-4 hover:text-text-1 hover:bg-bg-2"
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
