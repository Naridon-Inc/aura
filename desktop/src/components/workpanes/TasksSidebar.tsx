// The Tasks rail — which slice of the work you're looking at.
//
// Rebuilt on places/PlaceRail, which is the right-hand Changes panel's shape:
// collapsible groups with a count on the header, groups that hide themselves
// when they hold nothing, the one thing a group makes revealed on hover.
//
// What went, and why:
//   • The 16px "Tasks" heading. The app rail says Tasks one column left, the
//     workpane tab says Tasks, and you clicked one of them to get here.
//   • The full-width "New task ⌘N" button. The board's header has a New task
//     button 200px away; two primaries for one act is a choice you shouldn't
//     have to make. The shortcut still works — it's the board's.
//   • The gear beside it, which went to global Settings — not a task control.
//   • The palette dots. "My tasks" wore violet, Active amber, Overdue rose,
//     Workstreams violet again: five hues carrying no meaning you could look
//     up, next to statuses that wear the real `TaskStateRing`. Rows that name
//     an idea get that idea's glyph; rows that name a grouping get none.
//
// What arrived: the project picker. Everything listed here belongs to a
// project, and the rail used to show whatever the app had open with no way to
// say "the other one" — so choosing the project is part of using the rail.
// "All projects" is offered because the board honours it (see TasksBoard's
// scope handling), not as a label.
//
// State still flows through `tasksFilterStore` so the board picks up
// selections without prop drilling or context.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AlarmClock,
  CircleDashed,
  ListChecks,
  Loader,
  Plus,
  User,
} from "lucide-react";

import { api, type Cycle, type Module, type Task } from "../../lib/api";
import { fetchCycles, fetchModules } from "../../lib/tasksCache";
import {
  setTasksSharedCrew,
  setTasksSharedCycleId,
  setTasksSharedGoal,
  setTasksSharedModuleId,
  setTasksSharedSidebar,
  useTasksSharedFilters,
} from "../../lib/tasksFilterStore";
import {
  ALL_PROJECTS,
  isAllProjects,
  loadTasksForRoots,
  rootsForScope,
  rootsKeyOf,
  scopeValueOf,
  setProjectScope,
  useKnownProjects,
  useProjectScope,
} from "../../lib/projectRoots";
import {
  PlaceRail,
  PlaceRailGroup,
  PlaceRailRow,
  PlaceRailScope,
} from "../places/PlaceRail";
import { SprintRailGroup } from "../tasks/SprintRailGroup";
import { WorkRailGroups } from "../tasks/WorkRailGroups";
import { TASK_COLUMNS } from "../tasks/taskColumns";
import { TaskStateRing } from "../tasks/taskGlyphs";
import { Button } from "../ui/button";

type Props = {
  repoRoot: string;
  /** Resolved git handle for the current user. Used for the "My tasks"
   *  bucket and `@me` resolution in the shared filter. */
  currentHandle?: string;
  /** Fired whenever the user picks a filter / sprint / workstream. The host
   *  opens or focuses the board so the selection has a visible effect even
   *  when another tab is in front. Without this the rail mutates the filter
   *  store and the board never surfaces. */
  onActivate?: () => void;
};

export function TasksSidebar({ repoRoot, currentHandle, onActivate }: Props) {
  const shared = useTasksSharedFilters();
  const scope = useProjectScope();
  const projects = useKnownProjects(repoRoot);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);

  // The roots this rail is counting. Exactly what the board draws — the two
  // read the same scope, so the numbers here and the cards there are the same
  // claim about the same set.
  const roots = useMemo(
    () => rootsForScope(scope, repoRoot, projects),
    [scope, repoRoot, projects],
  );
  const rootsKey = rootsKeyOf(roots);

  // Sprints and workstreams are per-project catalogs; under All projects there
  // is no single one to list, so those groups stand down rather than merging
  // eight projects' sprints into a list where two can share a name.
  const single = roots.length === 1 ? roots[0]! : null;

  const refresh = useCallback(async () => {
    try {
      const [t, c, m] = await Promise.all([
        loadTasksForRoots(roots),
        single
          ? fetchCycles(single).catch(() => [] as Cycle[])
          : Promise.resolve([] as Cycle[]),
        single
          ? fetchModules(single).catch(() => [] as Module[])
          : Promise.resolve([] as Module[]),
      ]);
      setTasks(t);
      setCycles(c);
      setModules(m);
    } finally {
      setLoading(false);
    }
    // rootsKey stands in for `roots` — a new array identity every render would
    // restart the poll below on every keystroke elsewhere in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, single]);

  useEffect(() => {
    void refresh();
    // Re-poll modestly — the board drives its own fetches when the user
    // mutates a task; this picks up sibling edits from CLI / agent runs.
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // The board broadcasts after a successful create / patch / delete so these
  // counts stay live without waiting on the poll.
  useEffect(() => {
    const onMutate = () => void refresh();
    window.addEventListener("aura:tasks:mutated", onMutate);
    return () => window.removeEventListener("aura:tasks:mutated", onMutate);
  }, [refresh]);

  const counts = useMemo(() => {
    const out = {
      all: 0,
      mine: 0,
      unassigned: 0,
      active: 0,
      overdue: 0,
      backlog: 0,
      in_progress: 0,
      in_review: 0,
      done: 0,
    };
    const today = new Date().toISOString().slice(0, 10);
    for (const t of tasks) {
      out.all += 1;
      if (t.status === "backlog") out.backlog += 1;
      else if (t.status === "in_progress") {
        out.in_progress += 1;
        out.active += 1;
      } else if (t.status === "in_review") {
        out.in_review += 1;
        out.active += 1;
      } else if (t.status === "done") out.done += 1;
      if (
        currentHandle &&
        (t.assignee === currentHandle || t.assignee_ids.includes(currentHandle))
      ) {
        out.mine += 1;
      }
      if (t.assignee_ids.length === 0 && !t.assignee) out.unassigned += 1;
      if (t.status !== "done" && t.due_date && t.due_date < today) {
        out.overdue += 1;
      }
    }
    return out;
  }, [tasks, currentHandle]);

  // How many tasks each workstream actually holds. Derived from the tasks
  // themselves rather than the catalog's `task_ids` mirror, so a stale mirror
  // can't put a number on screen the board would disagree with. (The sprint
  // rows count the same way — SprintRailGroup does its own tally off the same
  // list.)
  const moduleCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of tasks) {
      if (t.module_id) out.set(t.module_id, (out.get(t.module_id) ?? 0) + 1);
    }
    return out;
  }, [tasks]);

  const [addingWorkstream, setAddingWorkstream] = useState(false);
  const [workstreamName, setWorkstreamName] = useState("");
  const [workstreamErr, setWorkstreamErr] = useState<string | null>(null);

  async function createWorkstream() {
    const name = workstreamName.trim();
    if (!name || !single) return;
    // Same slug shape the label catalog and the state catalog use, so ids stay
    // readable on disk and in a task's `module_id`.
    const id =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `workstream-${modules.length + 1}`;
    setWorkstreamErr(null);
    try {
      await api.tasksModulesUpsert(single, { id, name, status: "planned" });
      setWorkstreamName("");
      setAddingWorkstream(false);
      await refresh();
    } catch (e) {
      setWorkstreamErr(String(e));
    }
  }

  const f = shared.sidebar;
  const activeBucket = ((): string => {
    if (!f.status && !f.assignee) return "all";
    if (f.assignee?.includes("@me") && !f.status) return "mine";
    if (f.assignee?.includes("@unassigned") && !f.status) return "unassigned";
    if (f.overdue) return "overdue";
    if (
      f.status?.length === 2 &&
      f.status.includes("in_progress") &&
      f.status.includes("in_review")
    )
      return "active";
    if (f.status?.length === 1 && !f.assignee) return f.status[0]!;
    return "";
  })();

  function bucket(next: Partial<typeof shared.sidebar>) {
    onActivate?.();
    setTasksSharedSidebar({ ...next });
  }

  return (
    <PlaceRail
      scope={
        <PlaceRailScope
          value={scopeValueOf(scope, repoRoot, projects)}
          onChange={(next) => {
            // Picking a project resets every narrowing the rail holds — the
            // sprint, the workstream, the goal, the crew. Each of those ids
            // belongs to the project you just left, and carrying one across
            // would filter the new board down to nothing with a row lit in
            // the rail explaining why.
            setTasksSharedCycleId(null);
            setTasksSharedModuleId(null);
            setTasksSharedGoal(null);
            setTasksSharedCrew(null);
            // Picking the project the app already has open means "no explicit
            // scope" — compared against the FOLDED root, because that is the
            // one the picker offered. Comparing against the raw checkout let a
            // worktree store a scope pointing at its own project and then read
            // as a different choice than it was.
            setProjectScope(
              next === scopeValueOf("", repoRoot, projects) ? "" : next,
            );
          }}
          projects={projects}
          all
          disabled={loading && projects.length === 0}
        />
      }
    >
      <PlaceRailGroup title="Your work" count={counts.all}>
        <PlaceRailRow
          label="All tasks"
          count={counts.all}
          glyph={<ListChecks size={13} className="shrink-0 text-text-4" />}
          active={activeBucket === "all"}
          onClick={() => bucket({})}
        />
        {currentHandle && (
          <PlaceRailRow
            label="My tasks"
            count={counts.mine}
            glyph={<User size={13} className="shrink-0 text-text-4" />}
            active={activeBucket === "mine"}
            onClick={() => bucket({ assignee: ["@me"] })}
          />
        )}
        {/* "Assigned to me" used to sit here: same count as "My tasks", same
            onClick, and an `active` test against a bucket id the resolver
            never returns — so clicking it lit the row above instead. */}
        <PlaceRailRow
          label="Unassigned"
          count={counts.unassigned}
          glyph={<CircleDashed size={13} className="shrink-0 text-text-4" />}
          active={activeBucket === "unassigned"}
          onClick={() => bucket({ assignee: ["@unassigned"] })}
        />
        <PlaceRailRow
          label="Active"
          count={counts.active}
          glyph={<Loader size={13} className="shrink-0 text-text-4" />}
          active={activeBucket === "active"}
          onClick={() => bucket({ status: ["in_progress", "in_review"] })}
        />
        <PlaceRailRow
          label="Overdue"
          count={counts.overdue}
          glyph={<AlarmClock size={13} className="shrink-0 text-text-4" />}
          // Real now. This row used to route to Active and hardcode
          // active={false}: you clicked "Overdue 3" and got the 51 in-progress
          // tasks, with nothing selected to tell you where you'd landed.
          // `overdue` is its own filter dimension because it needs a
          // due_date < today predicate no slug list can express.
          active={activeBucket === "overdue"}
          onClick={() => bucket({ overdue: true })}
        />
      </PlaceRailGroup>

      {/* The four statuses come from `TASK_COLUMNS` — the same list, in the
          same order, with the same labels the board's lanes and the list's
          groups use — and each wears the shared `TaskStateRing`. A status is
          one idea; it must not be drawn one way in the rail and another on
          the board. */}
      <PlaceRailGroup title="Status" count={counts.all}>
        {TASK_COLUMNS.map((col) => (
          <PlaceRailRow
            key={col.id}
            label={col.label}
            count={counts[col.id]}
            glyph={<TaskStateRing statusId={col.id} />}
            active={activeBucket === col.id}
            onClick={() => bucket({ status: [col.id] })}
          />
        ))}
      </PlaceRailGroup>

      {/* Sprints. The list, and the two acts on a sprint that used to live on
          the deleted Sprint lens — see tasks/SprintRailGroup. */}
      <SprintRailGroup
        repoRoot={single}
        cycles={cycles}
        tasks={tasks}
        selectedId={shared.cycleId}
        onSelect={(id) => {
          onActivate?.();
          setTasksSharedCycleId(id);
        }}
        onChanged={refresh}
      />

      {/* Workstreams — "Modules" in storage, which in a version-control app
          reads as a code module. This is a named chunk of work that outlives
          any one sprint, so it gets the word for that.

          The `+` is the only way to make one anywhere in the product: the
          store, the Tauri command and the task-detail picker were all built
          and shipped, and nothing ever called the writer, so this group sat
          on "No modules yet" forever with no door out of it. */}
      <PlaceRailGroup
        title="Workstreams"
        count={modules.length}
        empty={
          single
            ? "No workstreams yet. Group work that spans sprints."
            : "Workstreams belong to one project. Pick a project to see them."
        }
        actions={
          single ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setAddingWorkstream((v) => !v)}
              title="New workstream"
              aria-label="New workstream"
              className="text-text-4 hover:text-text-1"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
            </Button>
          ) : null
        }
      >
        {modules.map((m) => (
          <PlaceRailRow
            key={m.id}
            label={m.name}
            count={moduleCounts.get(m.id) ?? 0}
            glyph={
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-5"
                aria-hidden
              />
            }
            active={shared.moduleId === m.id}
            onClick={() => {
              onActivate?.();
              setTasksSharedModuleId(shared.moduleId === m.id ? null : m.id);
            }}
          />
        ))}
        {addingWorkstream && (
          <div className="px-2 pb-0.5 pt-1">
            <input
              autoFocus
              value={workstreamName}
              onChange={(e) => setWorkstreamName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createWorkstream();
                if (e.key === "Escape") {
                  setAddingWorkstream(false);
                  setWorkstreamName("");
                  setWorkstreamErr(null);
                }
              }}
              onBlur={() => {
                if (!workstreamName.trim()) setAddingWorkstream(false);
              }}
              placeholder="Name it, then press Enter"
              aria-label="New workstream name"
              className="w-full rounded-[4px] border-[0.5px] border-line-soft bg-bg-0 px-2 py-1 text-xs text-text-1 placeholder:text-text-5 focus:border-accent focus:outline-none"
            />
            {workstreamErr && (
              <div className="pt-1 text-2xs text-red">{workstreamErr}</div>
            )}
          </div>
        )}
      </PlaceRailGroup>

      {/* Goals, crews and past runs — the loop half of this place. They used
          to be a separate 340px column that only two of the four lenses stood
          up, so switching lens swapped your navigation for a different one
          holding different ideas about what "the work" is. It's one board: a
          crew node carries the id of the card it was projected from, so a goal
          slices the same tasks a sprint does, and picking one here narrows
          every lens. See tasks/WorkRailGroups. */}
      {/* No `onActivate`: the groups above narrow only what the board draws,
          so picking one has to bring the board forward. A goal or a crew
          narrows EVERY lens, so there is nothing to bring forward — you stay
          where you are and what you're reading gets smaller. */}
      <WorkRailGroups repoRoot={single} />
    </PlaceRail>
  );
}

/** Re-exported so the board can say what scope it is in without importing the
 *  store twice over. */
export { ALL_PROJECTS, isAllProjects };
export type { ReactNode };
