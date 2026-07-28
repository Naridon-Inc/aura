// ModuleSidebarPanel — OO.4.
//
// Left-rail entry for the Plane-style Modules surface (long-lived
// workstream containers that span many cycles). Lists every module
// in the per-repo catalog; clicking a row notifies the parent so it
// can filter the visible task set down to that module's members.
//
// Mirror of `CycleSidebarPanel` with two differences:
//   • Status ladder is `planned | in_progress | completed` (not
//     `planned | active | completed`).
//   • No date window — modules are open-ended.

import { useCallback, useEffect, useState } from "react";
import { api, type Module } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type Props = {
  repoRoot: string;
  /** Currently selected module id (or null for "no module filter"). */
  selectedId: string | null;
  /** Fired when the user picks a module (or clears the selection by
   *  re-clicking the active one). */
  onSelect: (moduleId: string | null) => void;
  /** Optional callback fired after the catalog mutates. */
  onChanged?: () => void;
};

export function ModuleSidebarPanel({
  repoRoot,
  selectedId,
  onSelect,
  onChanged,
}: Props) {
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.tasksModulesList(repoRoot);
      setModules(rows);
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

  const ordered = sortModules(modules);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this module? Tasks will detach but stay on the board.")) return;
    try {
      await api.tasksModulesDelete(repoRoot, id);
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
          Modules
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setCreating(true)}
          className="text-[10.5px] text-text-4 hover:text-text-1 px-1"
          title="New module"
        >
          + New
        </Button>
      </div>
      {loading && modules.length === 0 ? (
        <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-4">
          <AsciiSpinner />
          Loading…
        </div>
      ) : error ? (
        <div className="px-2 py-1 text-[11px] text-red" title={error}>
          Couldn't load modules.
        </div>
      ) : ordered.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-text-4 leading-snug">
          No modules yet — use <span className="text-text-3">+ New</span> to start one.
        </div>
      ) : (
        <ul className="flex flex-col">
          {ordered.map((m) => (
            <ModuleRow
              key={m.id}
              mod={m}
              selected={selectedId === m.id}
              onSelect={() => onSelect(selectedId === m.id ? null : m.id)}
              onDelete={() => void handleDelete(m.id)}
            />
          ))}
        </ul>
      )}
      {creating && (
        <ModuleCreateInline
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            try {
              await api.tasksModulesUpsert(repoRoot, input);
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

function ModuleRow({
  mod,
  selected,
  onSelect,
  onDelete,
}: {
  mod: Module;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const tone =
    mod.status === "in_progress"
      ? "border-l-accent"
      : mod.status === "completed"
        ? "border-l-text-5"
        : "border-l-text-4";
  return (
    <li className="group">
      <button
        type="button"
        onClick={onSelect}
        title={mod.description || mod.name}
        className={`w-full flex items-center justify-between gap-2 px-2 py-1 text-left text-[11.5px] rounded border-l-2 ${tone} ${
          selected
            ? "bg-accent-soft text-accent"
            : "text-text-2 hover:bg-bg-2 hover:text-text-1"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{mod.name}</span>
        <span className="text-[10px] text-text-5 tabular-nums shrink-0">
          {mod.task_ids.length}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 text-text-5 hover:text-red text-[10px] px-1"
          title="Delete module"
          aria-label={`Delete module ${mod.name}`}
        >
          ×
        </button>
      </button>
    </li>
  );
}

function ModuleCreateInline({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: {
    id: string;
    name: string;
    description: string;
    status: "planned" | "in_progress" | "completed";
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const canSubmit = name.trim().length > 0;
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
        placeholder="Module name (e.g. Notifications)"
        className="w-full text-[11.5px]"
      />
      <Input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Purpose (optional)"
        className="w-full text-[11px] text-text-2"
      />
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
              id: slug(name) || `module-${Date.now()}`,
              name: name.trim(),
              description: description.trim(),
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

/** in_progress first, then planned, then completed. Within a group,
 *  alphabetical by name for stable render order. Exported so tests
 *  and other surfaces can mirror the ordering rule. */
export function sortModules(rows: Module[]): Module[] {
  const rank = (m: Module) =>
    m.status === "in_progress" ? 0 : m.status === "planned" ? 1 : 2;
  return [...rows].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name);
  });
}
