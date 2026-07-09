// CycleSidebarPanel — OO.4.
//
// Left-rail entry for the Plane-style Cycles surface (sprints with
// strict windows + lifecycle). Lists every cycle in the per-repo
// catalog; the active one (status === "active") is highlighted at
// the top, and clicking any row notifies the parent so it can filter
// the kanban / list / spreadsheet view down to that cycle's tasks.
//
// State here is intentionally tiny — load on mount, refresh after
// every mutation. The parent owns the "currently selected cycle"
// state because that same selection drives the filter applied to
// the visible task set; storing it locally would force prop-drilling
// the filter back up.

import { useCallback, useEffect, useState } from "react";
import { api, type Cycle } from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type Props = {
  repoRoot: string;
  /** Currently selected cycle id (or null for "all tasks"). Used to
   *  highlight the active row and toggle selection off when the user
   *  clicks the same row twice. */
  selectedId: string | null;
  /** Fired when the user picks a cycle (or clears the selection by
   *  re-clicking the active one). `null` means "show all tasks". */
  onSelect: (cycleId: string | null) => void;
  /** Optional callback fired after the panel mutates the catalog
   *  (create/upsert/delete). Lets the parent refresh task counts. */
  onChanged?: () => void;
};

export function CycleSidebarPanel({
  repoRoot,
  selectedId,
  onSelect,
  onChanged,
}: Props) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.tasksCyclesList(repoRoot);
      setCycles(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sort: active first, then planned by start_date asc, then completed.
  // Stable secondary sort by `name` for deterministic rendering.
  const ordered = sortCycles(cycles);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this cycle? Tasks will detach but stay on the board.")) return;
    try {
      await api.tasksCyclesDelete(repoRoot, id);
      if (selectedId === id) onSelect(null);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2">
        <span className="text-[10px] uppercase tracking-wider text-text-5">
          Cycles
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setCreating(true)}
          className="text-[10.5px] text-text-4 hover:text-text-1 px-1"
          title="New cycle"
        >
          + New
        </Button>
      </div>
      {loading && cycles.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-text-5">Loading…</div>
      ) : error ? (
        <div className="px-2 py-1 text-[11px] text-red-400" title={error}>
          (failed to load)
        </div>
      ) : ordered.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-text-5">No cycles yet</div>
      ) : (
        <ul className="flex flex-col">
          {ordered.map((c) => (
            <CycleRow
              key={c.id}
              cycle={c}
              selected={selectedId === c.id}
              onSelect={() => onSelect(selectedId === c.id ? null : c.id)}
              onDelete={() => void handleDelete(c.id)}
            />
          ))}
        </ul>
      )}
      {creating && (
        <CycleCreateInline
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            try {
              await api.tasksCyclesUpsert(repoRoot, input);
              setCreating(false);
              await refresh();
              onChanged?.();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      )}
    </div>
  );
}

function CycleRow({
  cycle,
  selected,
  onSelect,
  onDelete,
}: {
  cycle: Cycle;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const tone =
    cycle.status === "active"
      ? "border-l-emerald-500"
      : cycle.status === "completed"
        ? "border-l-text-5"
        : "border-l-sky-500";
  return (
    <li className="group">
      <button
        type="button"
        onClick={onSelect}
        title={`${cycle.start_date} → ${cycle.end_date}`}
        className={`w-full flex items-center justify-between gap-2 px-2 py-1 text-left text-[11.5px] rounded border-l-2 ${tone} ${
          selected
            ? "bg-accent-soft text-accent"
            : "text-text-2 hover:bg-bg-2 hover:text-text-1"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{cycle.name}</span>
        <span className="text-[10px] text-text-5 tabular-nums shrink-0">
          {cycle.task_ids.length}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 text-text-5 hover:text-red-400 text-[10px] px-1"
          title="Delete cycle"
          aria-label={`Delete cycle ${cycle.name}`}
        >
          ×
        </button>
      </button>
    </li>
  );
}

function CycleCreateInline({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: {
    id: string;
    name: string;
    start_date: string;
    end_date: string;
    status: "planned" | "active" | "completed";
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const canSubmit = name.trim().length > 0 && start.length > 0 && end.length > 0;
  const slug = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return (
    <div className="px-2 py-2 border-t border-line-soft bg-bg-2/40 flex flex-col gap-1.5">
      <Input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Cycle name (e.g. Week 22)"
        className="w-full text-[11.5px]"
      />
      <div className="grid grid-cols-2 gap-1.5">
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="bg-bg-content border border-line-soft rounded px-1.5 py-1 text-[11px] text-text-1 focus:outline-none focus:border-line"
          aria-label="Start date"
        />
        <input
          type="date"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="bg-bg-content border border-line-soft rounded px-1.5 py-1 text-[11px] text-text-1 focus:outline-none focus:border-line"
          aria-label="End date"
        />
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          onClick={onCancel}
          className="text-[11px] text-text-4 hover:text-text-1"
        >
          Cancel
        </Button>
        <Button
          variant="default"
          size="xs"
          disabled={!canSubmit}
          onClick={() =>
            void onSubmit({
              id: slug(name) || `cycle-${Date.now()}`,
              name: name.trim(),
              start_date: start,
              end_date: end,
              status: "planned",
            })
          }
        >
          Create
        </Button>
      </div>
    </div>
  );
}

/** Active cycles float to the top, then planned (earliest start
 *  first), then completed. Within a group, sort by name for a stable
 *  render order across re-fetches. Exported for the test surface and
 *  for the parent that may want to mirror the same ordering in its
 *  empty-state hint. */
export function sortCycles(rows: Cycle[]): Cycle[] {
  const rank = (c: Cycle) =>
    c.status === "active" ? 0 : c.status === "planned" ? 1 : 2;
  return [...rows].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.status === "planned") {
      const cmp = a.start_date.localeCompare(b.start_date);
      if (cmp !== 0) return cmp;
    }
    return a.name.localeCompare(b.name);
  });
}
