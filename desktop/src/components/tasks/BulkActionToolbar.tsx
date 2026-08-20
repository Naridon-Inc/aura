// BulkActionToolbar — OO.5.
//
// Floating action bar that appears at the bottom of the TasksBoard
// when the user has multi-selected one or more cards. Routes every
// click through the OO.5 bulk endpoints; surface the affected /
// errored split so partial-success runs are visible.
//
// The toolbar owns no selection state — the parent passes the selected
// ids in and a clearer callback. That keeps the component re-usable
// across views (board / list / spreadsheet) once multi-select gets
// wired up everywhere.

import { useState } from "react";
import {
  api,
  type BulkOpResult,
  type TaskLabel,
  type TaskState,
  type TeamMember,
} from "../../lib/api";
import { Button } from "../ui/button";

type Props = {
  repoRoot: string;
  selectedIds: string[];
  /** Per-repo state catalog for the "Move to state" dropdown. */
  taskStates: TaskState[];
  /** Per-repo label catalog for the "Set labels" dropdown. */
  taskLabels: TaskLabel[];
  /** Team roster for the "Assign" dropdown. */
  members: TeamMember[];
  /** Clear the selection set on the parent. Called after every
   *  successful bulk op so the toolbar collapses back. */
  onCleared: () => void;
  /** Re-fetch the task list on the parent. Called after every op
   *  whose mutation is reflected in `Task` rows. */
  onChanged: () => Promise<void> | void;
};

export function BulkActionToolbar({
  repoRoot,
  selectedIds,
  taskStates,
  taskLabels,
  members,
  onCleared,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<BulkOpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pickerOpen, setPickerOpen] = useState<
    "state" | "assign" | "label" | null
  >(null);

  if (selectedIds.length === 0) return null;

  const run = async (
    kind: string,
    op: () => Promise<BulkOpResult>,
    options?: { skipChange?: boolean },
  ) => {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      const out = await op();
      setResult(out);
      if (!options?.skipChange) {
        await onChanged();
      }
      // Auto-clear selection when every supplied id succeeded; keep it
      // when there were errors so the user can re-target the failures.
      if (out.errors.length === 0) onCleared();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Bulk task actions"
      className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 bg-bg-content border border-line-soft rounded-lg shadow-lg shadow-black/30 px-3 py-2 flex items-center gap-2 max-w-[640px]"
    >
      <span className="text-sm text-text-2 font-medium pr-1">
        {selectedIds.length} selected
      </span>
      <span className="w-px h-5 bg-line-soft" />

      {/* State picker */}
      <div className="relative">
        <Button
          variant="subtle"
          size="xs"
          onClick={() => setPickerOpen(pickerOpen === "state" ? null : "state")}
          disabled={busy != null}
          className="text-sm"
        >
          {busy === "state" ? "Moving…" : "Move state"}
        </Button>
        {pickerOpen === "state" && (
          <div className="absolute bottom-full mb-1 left-0 min-w-[160px] bg-bg-content border border-line-soft rounded shadow-lg py-1 max-h-64 overflow-y-auto">
            {taskStates.length === 0 ? (
              <div className="text-xs text-text-5 px-2 py-1">
                Catalog empty
              </div>
            ) : (
              taskStates.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setPickerOpen(null);
                    void run("state", () =>
                      api.tasksBulkStateChange(repoRoot, selectedIds, s.id),
                    );
                  }}
                  className="w-full text-left text-sm px-2 py-1 text-text-2 hover:bg-state-hover hover:text-text-1 flex items-center gap-2"
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: s.color || "var(--color-text-4)" }}
                  />
                  {s.name}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Assign picker */}
      <div className="relative">
        <Button
          variant="subtle"
          size="xs"
          onClick={() =>
            setPickerOpen(pickerOpen === "assign" ? null : "assign")
          }
          disabled={busy != null}
          className="text-sm"
        >
          {busy === "assign" ? "Assigning…" : "Assign"}
        </Button>
        {pickerOpen === "assign" && (
          <div className="absolute bottom-full mb-1 left-0 min-w-[180px] bg-bg-content border border-line-soft rounded shadow-lg py-1 max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                setPickerOpen(null);
                void run("assign", () =>
                  api.tasksBulkAssign(repoRoot, selectedIds, []),
                );
              }}
              className="w-full text-left text-sm px-2 py-1 text-text-2 hover:bg-state-hover hover:text-text-1 italic"
            >
              Clear assignees
            </button>
            <div className="border-t border-line-soft/50 my-1" />
            {members.length === 0 ? (
              <div className="text-xs text-text-5 px-2 py-1">
                No team members
              </div>
            ) : (
              members.map((m) => (
                <button
                  key={m.handle}
                  type="button"
                  onClick={() => {
                    setPickerOpen(null);
                    void run("assign", () =>
                      api.tasksBulkAssign(repoRoot, selectedIds, [m.handle]),
                    );
                  }}
                  className="w-full text-left text-sm px-2 py-1 text-text-2 hover:bg-state-hover hover:text-text-1"
                >
                  {m.handle}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Label picker */}
      <div className="relative">
        <Button
          variant="subtle"
          size="xs"
          onClick={() => setPickerOpen(pickerOpen === "label" ? null : "label")}
          disabled={busy != null}
          className="text-sm"
        >
          {busy === "label" ? "Labeling…" : "Set labels"}
        </Button>
        {pickerOpen === "label" && (
          <div className="absolute bottom-full mb-1 left-0 min-w-[160px] bg-bg-content border border-line-soft rounded shadow-lg py-1 max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                setPickerOpen(null);
                void run("label", () =>
                  api.tasksBulkLabel(repoRoot, selectedIds, []),
                );
              }}
              className="w-full text-left text-sm px-2 py-1 text-text-2 hover:bg-state-hover hover:text-text-1 italic"
            >
              Strip all labels
            </button>
            <div className="border-t border-line-soft/50 my-1" />
            {taskLabels.length === 0 ? (
              <div className="text-xs text-text-5 px-2 py-1">
                Catalog empty
              </div>
            ) : (
              taskLabels.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => {
                    setPickerOpen(null);
                    void run("label", () =>
                      api.tasksBulkLabel(repoRoot, selectedIds, [l.id]),
                    );
                  }}
                  className="w-full text-left text-sm px-2 py-1 text-text-2 hover:bg-state-hover hover:text-text-1 flex items-center gap-2"
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: l.color || "var(--color-text-4)" }}
                  />
                  {l.name}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <span className="w-px h-5 bg-line-soft" />

      <Button
        variant="subtle"
        size="xs"
        onClick={() =>
          void run("archive", () =>
            api.tasksBulkArchive(repoRoot, selectedIds),
          )
        }
        disabled={busy != null}
        className="text-sm"
      >
        {busy === "archive" ? "Archiving…" : "Archive"}
      </Button>

      <button
        type="button"
        onClick={() => setConfirmingDelete(true)}
        disabled={busy != null}
        className="text-sm px-2 py-1 rounded bg-red/15 hover:bg-red/25 text-red hover:text-red disabled:opacity-40"
      >
        Delete
      </button>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onCleared}
        disabled={busy != null}
        className="ml-1 text-xs text-text-5 hover:text-text-2"
        aria-label="Clear selection"
      >
        ×
      </Button>

      {/* Inline status (success or per-task failure summary) */}
      {result && (
        <div className="ml-2 text-xs leading-snug">
          {result.errors.length === 0 ? (
            <span className="text-text-2">
              {result.affected.length} updated
            </span>
          ) : (
            <span className="text-red">
              {result.affected.length} ok · {result.errors.length} failed
            </span>
          )}
        </div>
      )}
      {error && (
        <div className="ml-2 text-xs text-red leading-snug">
          {error}
        </div>
      )}

      {confirmingDelete && (
        <div className="absolute bottom-full mb-2 right-2 bg-bg-content border border-line-soft rounded shadow-lg px-3 py-2 flex flex-col gap-2 text-sm">
          <span className="text-text-1">
            Delete {selectedIds.length} task
            {selectedIds.length > 1 ? "s" : ""}?
          </span>
          <span className="text-text-5">
            This drops tasks, relations, and comments. The activity log
            keeps a final &quot;deleted&quot; entry.
          </span>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setConfirmingDelete(false)}
              className="text-text-4 hover:text-text-1"
            >
              Cancel
            </Button>
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false);
                void run("delete", () =>
                  api.tasksBulkDelete(repoRoot, selectedIds),
                );
              }}
              className="bg-red/20 hover:bg-red/30 text-red hover:text-red px-2 py-1 rounded"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
