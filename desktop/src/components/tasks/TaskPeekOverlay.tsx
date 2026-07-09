// TaskPeekOverlay — Plane `.peek` slide-over.
//
// Replaces the legacy 400px right rail. Anchored to the board surface
// (`absolute inset-0 z-50`), this slides in from the right edge with a
// dim scrim covering the rest. Width tracks the mockup spec
// `clamp(720px, 62vw, 1180px)` so the peek dominates the surface while
// the sidebar / left content stays visually present underneath.
//
// Layout per docs/plane-app-examples.html `.peek-body`:
//
//     ┌──────────────────────────────────────┐
//     │ ◀ AURA-42                       … × │  peek-head
//     ├─────────────────────────────┬────────┤
//     │ Title (text-22 / 600)       │        │
//     │ Description (rich)          │  side  │
//     │ Activity                    │  300px │
//     │ Comments                    │        │
//     └─────────────────────────────┴────────┘
//
// peek-main: minmax(0, 1fr) with 24px 36px padding
// peek-side: 300px, bg-surface-2, prop-grid (80px label · 1fr value)
//
// Behaviour:
//   • Esc closes (capture-phase so it dismisses peek first, board second)
//   • Click on the scrim closes
//   • Mounting dispatches `aura:detail-tab-opened` so the app-level
//     sidebar auto-collapses (paired with the list view's "keep
//     sidebar visible" rule — see App.tsx `inDetailSurface`).

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  Link2,
  Maximize2,
  Trash2,
  X,
} from "lucide-react";
import {
  DescriptionCard,
  ActivityCard,
  CommentsCard,
} from "./TaskDetailSidePanel";
import { PeekSideRail } from "./PeekSideRail";
import { TaskIdChip } from "../TasksBoard";
import type {
  Cycle,
  Module,
  Task,
  TaskLabel,
  TaskState,
  TeamMember,
  UpdateTaskInput,
} from "../../lib/api";

type Props = {
  task: Task;
  allTasks: Task[];
  members: TeamMember[];
  taskStates?: TaskState[];
  taskLabels?: TaskLabel[];
  cycles?: Cycle[];
  modules?: Module[];
  repoRoot: string;
  currentHandle?: string | null;
  onClose: () => void;
  /** Mockup `expandToPage()` — promote the peek to the full detail page. */
  onExpand?: () => void;
  /** Jump to another task in the peek (prev/next stepping). */
  onNavigate?: (id: string) => void;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  onDelete: () => void;
  onCreateChild?: (parentId: string, title: string) => Promise<void>;
};

export function TaskPeekOverlay({
  task,
  allTasks,
  members,
  taskStates = [],
  cycles = [],
  modules = [],
  repoRoot,
  currentHandle = null,
  onClose,
  onExpand,
  onNavigate,
  onPatch,
  onDelete,
  onCreateChild,
}: Props) {
  // Slide-in: mount off-canvas (translateX 100%) then flip to 0 on the
  // next frame so the 240ms transition actually runs. Mirrors the
  // mockup `.peek` → `.peek.on` transform.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Prev/next stepping wraps around the (already-filtered) task list the
  // board handed us. Mirrors the mockup `peekStep(dir)`.
  const { prevId, nextId } = useMemo(() => {
    const idx = allTasks.findIndex((t) => t.id === task.id);
    if (idx === -1 || allTasks.length < 2) {
      return { prevId: null as string | null, nextId: null as string | null };
    }
    const n = allTasks.length;
    return {
      prevId: allTasks[(idx - 1 + n) % n]!.id,
      nextId: allTasks[(idx + 1) % n]!.id,
    };
  }, [allTasks, task.id]);

  // Esc closes (capture). `aura:detail-tab-opened` fires on mount so
  // the app sidebar collapses; `aura:detail-tab-closed` on unmount so
  // it restores when the user returns to the list/board view.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    window.dispatchEvent(new CustomEvent("aura:detail-tab-opened"));
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.dispatchEvent(new CustomEvent("aura:detail-tab-closed"));
    };
  }, [onClose]);

  function copyLink() {
    try {
      void navigator.clipboard.writeText(`AURA-${task.sequence_id}`);
    } catch {
      // clipboard rejected (rare in the Tauri webview) — stay quiet.
    }
  }

  // Portal to <body> + position fixed so the peek slides in from the
  // app window's right edge — covering the right-rail tabs (Story,
  // Aura, Chat, Tasks) and any other inner-frame chrome. Anchoring it
  // to the board surface (`absolute inset-0`) made the layout feel
  // cluttered: the peek competed with the right rail for width instead
  // of dominating it.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Task ${task.sequence_id} detail`}
      className="fixed inset-0 z-[60] flex"
      // Click on the scrim closes. The peek panel below stops
      // propagation so clicks inside don't fall through.
      onClick={onClose}
    >
      {/* Scrim — left half */}
      <div
        aria-hidden
        className="flex-1 transition-opacity duration-200 ease-out"
        style={{ background: "oklch(0.12 0 0 / 35%)", opacity: shown ? 1 : 0 }}
      />
      {/* Peek panel — slides in from the right edge (mockup `.peek`). */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="h-full flex flex-col bg-bg-content border-l-[0.5px] border-line-soft shadow-[-10px_0_30px_rgba(0,0,0,0.25)] will-change-transform"
        style={{
          width: "clamp(720px, 62vw, 1180px)",
          maxWidth: "96%",
          transform: shown ? "translateX(0)" : "translateX(100%)",
          transition: "transform 240ms cubic-bezier(0.25,0.8,0.25,1)",
        }}
      >
        {/* peek-head: [close · expand · id]  …  [prev · next · link · delete] */}
        <div className="flex items-center gap-1 px-3 h-11 border-b-[0.5px] border-line-soft flex-shrink-0">
          <PeekIconButton onClick={onClose} title="Close peek (Esc)" label="Close">
            <X className="w-4 h-4" strokeWidth={1.75} aria-hidden />
          </PeekIconButton>
          {onExpand && (
            <PeekIconButton
              onClick={onExpand}
              title="Open as full page"
              label="Open as full page"
            >
              <Maximize2 className="w-[15px] h-[15px]" strokeWidth={1.75} aria-hidden />
            </PeekIconButton>
          )}
          <TaskIdChip
            sequenceId={task.sequence_id}
            className="font-mono text-[12px] tracking-[0.02em] text-text-3 px-2"
          />
          <div className="flex-1" />
          <PeekIconButton
            onClick={() => prevId && onNavigate?.(prevId)}
            disabled={!prevId || !onNavigate}
            title="Previous work item"
            label="Previous"
          >
            <ChevronUp className="w-4 h-4" strokeWidth={1.75} aria-hidden />
          </PeekIconButton>
          <PeekIconButton
            onClick={() => nextId && onNavigate?.(nextId)}
            disabled={!nextId || !onNavigate}
            title="Next work item"
            label="Next"
          >
            <ChevronDown className="w-4 h-4" strokeWidth={1.75} aria-hidden />
          </PeekIconButton>
          <PeekIconButton onClick={copyLink} title="Copy link" label="Copy link">
            <Link2 className="w-4 h-4" strokeWidth={1.75} aria-hidden />
          </PeekIconButton>
          <PeekIconButton
            onClick={onDelete}
            title="Delete work item"
            label="Delete"
            danger
          >
            <Trash2 className="w-4 h-4" strokeWidth={1.75} aria-hidden />
          </PeekIconButton>
        </div>
        {/* peek-body — minmax(0, 1fr) | 300px */}
        <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_300px] overflow-hidden">
          {/* peek-main */}
          <div className="overflow-y-auto px-9 py-6 pb-20 min-w-0">
            <PeekTitle task={task} onPatch={onPatch} />
            <div className="mt-4">
              <DescriptionCard task={task} members={members} onPatch={onPatch} />
            </div>
            <div className="mt-8">
              <ActivityCard task={task} repoRoot={repoRoot} onPatch={onPatch} />
            </div>
            <div className="mt-6">
              <CommentsCard
                task={task}
                repoRoot={repoRoot}
                currentHandle={currentHandle}
              />
            </div>
          </div>
          {/* peek-side — 300px property rail. Plane mockup `.peek-side`
              renders a flat `.prop` list (no card headers) with grouped
              dividers and popover-triggered pickers. See PeekSideRail. */}
          <aside
            className="overflow-y-auto px-4 py-4 border-l-[0.5px] border-line-soft bg-bg-1/60"
            aria-label="Task properties"
          >
            <PeekSideRail
              task={task}
              allTasks={allTasks}
              members={members}
              taskStates={taskStates}
              cycles={cycles}
              modules={modules}
              repoRoot={repoRoot}
              onPatch={onPatch}
              onCreateChild={onCreateChild}
            />
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Mockup `.btn.ghost.icon` — 28px square ghost button used across the
// peek head. Danger variant tints the trash action rose on hover.
function PeekIconButton({
  onClick,
  title,
  label,
  disabled = false,
  danger = false,
  children,
}: {
  onClick: () => void;
  title: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className={`w-7 h-7 rounded-[5px] grid place-items-center transition-colors disabled:opacity-30 disabled:pointer-events-none ${
        danger
          ? "text-text-4 hover:text-rose-400 hover:bg-rose-500/10"
          : "text-text-4 hover:text-text-1 hover:bg-bg-2"
      }`}
    >
      {children}
    </button>
  );
}

// Plane `.peek-title` — 22px / 600, inline-editable.
function PeekTitle({
  task,
  onPatch,
}: {
  task: Task;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  return (
    <textarea
      defaultValue={task.title}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (next && next !== task.title) {
          void onPatch({ id: task.id, title: next });
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.currentTarget.value = task.title;
          e.currentTarget.blur();
        }
      }}
      rows={1}
      placeholder="Untitled work item"
      className="w-full bg-transparent text-text-1 text-[22px] font-semibold leading-tight tracking-[-0.01em] resize-none focus:outline-none focus:bg-bg-2/40 rounded px-2 -mx-2 py-1"
    />
  );
}
