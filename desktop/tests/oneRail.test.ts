// One rail, both halves of Tasks.
//
//   bun test
//
// Tasks draws two things that were built as separate products: the backlog
// (cards in `.aura/tasks/`) and the loop graph the agents actually run. Mission
// Control used to carry its own sidebar for the second one — goals, crews, past
// runs — so the place had two rails depending on which lens you were reading,
// and picking a goal in one of them said nothing to the other.
//
// They were never separate. A loop node carries `board_task_id`: provenance
// back to the card it was projected from. That field is the whole join, and
// these tests defend it end to end — from "which nodes are in this goal" to
// "which cards does the board keep".
//
// The invariant: ONE selection in the rail narrows EVERY lens, and the two
// halves narrow to the same work. Four ways that can break, all pinned below.
//
// 1. A PARKED GOAL RESOLVING TO NOTHING. The graph is six buckets and there was
//    already a flatten helper that covered five of them — it drops `paused`. A
//    goal someone parked would have resolved to zero cards, so picking it would
//    empty the board and read as "this goal has no work" when the truth is "you
//    paused it". `allNodes` is its own six-bucket flatten for exactly this.
//
// 2. AN UNKNOWN SLUG READING AS "EVERYTHING". A rail pointing at a goal the
//    graph no longer has must narrow to nothing, not fall through to the whole
//    queue — the failure mode where a stale selection silently shows you every
//    goal's work under one goal's name.
//
// 3. COUNTS SURVIVING THE NARROWING. The situation line reads `counts`, the
//    lanes read the buckets. Filter one and not the other and the header says
//    "12 ready" over three cards.
//
// 4. TWO LIT ROWS MEANING "OR". Goal and crew are both narrowings and the rail
//    can light both; the loop views apply them in series, so the board has to
//    intersect. Union would make picking a second row show you MORE.

import { describe, expect, test } from "bun:test";

import type {
  GoalSummary,
  LoopTask,
  ReadyViewDto,
} from "../src/lib/api";
import {
  allNodes,
  boardTaskIdsForCrew,
  boardTaskIdsForGoal,
  crewOf,
  scopeViewToCrew,
  scopeViewToGoal,
} from "../src/components/commons/crew/crewControl";
import {
  clearTasksSharedFilters,
  getTasksSharedFilters,
  railBoardTaskIds,
  setTasksSharedCrew,
  setTasksSharedCycleId,
  setTasksSharedGoal,
  setTasksSharedModuleId,
  setTasksSharedSidebar,
  type TasksSharedFilters,
} from "../src/lib/tasksFilterStore";
import { readSrc } from "./support/code";

function node(
  id: string,
  extra: Partial<LoopTask> = {},
): LoopTask {
  return {
    id,
    title: id,
    input: "",
    task_kind: "code",
    depends_on: [],
    status: "pending",
    priority: "medium",
    tags: [],
    created_at: 0,
    updated_at: 0,
    ...extra,
  };
}

function goal(g: string, task_ids: string[], counts: Partial<GoalSummary> = {}): GoalSummary {
  return {
    goal: g,
    total: task_ids.length,
    ready: 0,
    working: 0,
    done: 0,
    paused: 0,
    blocked: 0,
    failed: 0,
    task_ids,
    ...counts,
  };
}

/** A graph with one node in every bucket, so anything that forgets a bucket
 *  loses a node you can name. Cards: r→c1, b→c2, w→c3, d→c4, p→c5, o→(none). */
function view(over: Partial<ReadyViewDto> = {}): ReadyViewDto {
  const base: ReadyViewDto = {
    ready: [node("r", { board_task_id: "c1", crew_id: "alpha" })],
    blocked: [
      { task: node("b", { board_task_id: "c2", crew_id: "alpha" }), unmet: ["r"] },
    ],
    working: [node("w", { board_task_id: "c3", crew_id: "beta" })],
    done: [node("d", { board_task_id: "c4", crew_id: "beta" })],
    paused: [node("p", { board_task_id: "c5", crew_id: "alpha" })],
    other: [node("o", { crew_id: "beta" })],
    counts: { ready: 1, blocked: 1, working: 1, done: 1, paused: 1, other: 1 },
    goals: [
      goal("ship-it", ["r", "b", "w", "d", "p", "o"], { ready: 1, working: 1, done: 1, paused: 1, blocked: 1 }),
      goal("parked", ["p"], { paused: 1 }),
      goal("graph-only", ["o"]),
    ],
    crews: [],
  };
  return { ...base, ...over };
}

describe("allNodes is the whole graph", () => {
  test("every bucket, each node once", () => {
    const ids = allNodes(view()).map((t) => t.id);
    expect(ids.sort()).toEqual(["b", "d", "o", "p", "r", "w"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("paused is in it. The bug the older flatten had", () => {
    expect(allNodes(view()).map((t) => t.id)).toContain("p");
  });

  test("blocked contributes its task, not its wrapper", () => {
    for (const t of allNodes(view())) {
      expect(typeof t.id).toBe("string");
      expect(t).not.toHaveProperty("unmet");
    }
  });
});

describe("goal → board cards", () => {
  test("a goal resolves to the cards its nodes came from", () => {
    expect(boardTaskIdsForGoal(view(), "ship-it")).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
    ]);
  });

  test("a wholly PARKED goal still resolves to its card", () => {
    expect(boardTaskIdsForGoal(view(), "parked")).toEqual(["c5"]);
  });

  test("nodes authored straight into the graph contribute nothing", () => {
    // Truthful empty: there is no card to narrow to, which callers must read
    // as "no card-level narrowing available" rather than "no cards match".
    expect(boardTaskIdsForGoal(view(), "graph-only")).toEqual([]);
  });

  test("an unknown goal resolves to nothing, never to everything", () => {
    expect(boardTaskIdsForGoal(view(), "no-such-goal")).toEqual([]);
  });

  test("several steps cut from one card name it once", () => {
    const v = view({
      ready: [
        node("r1", { board_task_id: "c1" }),
        node("r2", { board_task_id: "c1" }),
        node("r3", { board_task_id: "c9" }),
      ],
      blocked: [],
      working: [],
      done: [],
      paused: [],
      other: [],
      goals: [goal("split", ["r1", "r2", "r3"])],
    });
    expect(boardTaskIdsForGoal(v, "split")).toEqual(["c1", "c9"]);
  });
});

describe("crew → board cards", () => {
  test("a crew resolves to exactly the cards its Run would touch", () => {
    expect(boardTaskIdsForCrew(view(), "alpha")).toEqual(["c1", "c2", "c5"]);
    expect(boardTaskIdsForCrew(view(), "beta")).toEqual(["c3", "c4"]);
  });

  test("the partition is crewOf. An unassigned node is main's", () => {
    expect(crewOf(node("x"))).toBe("main");
    expect(crewOf(node("x", { crew_id: null }))).toBe("main");
    const v = view({
      ready: [node("m", { board_task_id: "cm" })],
      blocked: [],
      working: [],
      done: [],
      paused: [],
      other: [],
    });
    expect(boardTaskIdsForCrew(v, "main")).toEqual(["cm"]);
  });

  test("an unknown crew resolves to nothing", () => {
    expect(boardTaskIdsForCrew(view(), "ghost")).toEqual([]);
  });
});

describe("scopeViewToGoal", () => {
  test("keeps only the goal's members, bucket by bucket", () => {
    const scoped = scopeViewToGoal(view(), "parked");
    expect(scoped.paused.map((t) => t.id)).toEqual(["p"]);
    expect(scoped.ready).toEqual([]);
    expect(scoped.blocked).toEqual([]);
    expect(scoped.working).toEqual([]);
    expect(scoped.done).toEqual([]);
    expect(scoped.other).toEqual([]);
  });

  test("re-derives counts, so the header cannot outlive the lanes", () => {
    const scoped = scopeViewToGoal(view(), "parked");
    expect(scoped.counts).toEqual({
      ready: 0,
      blocked: 0,
      working: 0,
      done: 0,
      paused: 1,
      other: 0,
    });
  });

  test("an unknown slug narrows to nothing, not to everything", () => {
    const scoped = scopeViewToGoal(view(), "no-such-goal");
    expect(allNodes(scoped)).toEqual([]);
    expect(scoped.counts.ready).toBe(0);
  });

  test("null is 'every goal' and hands the view straight back", () => {
    const v = view();
    expect(scopeViewToGoal(v, null)).toBe(v);
  });

  test("leaves goals and crews alone. The rail keeps listing the rest", () => {
    const v = view();
    const scoped = scopeViewToGoal(v, "parked");
    expect(scoped.goals).toBe(v.goals);
    expect(scoped.crews).toBe(v.crews);
  });

  test("composes with the crew scope in series, either order", () => {
    const v = view();
    const a = scopeViewToGoal(scopeViewToCrew(v, "alpha"), "ship-it");
    const b = scopeViewToCrew(scopeViewToGoal(v, "ship-it"), "alpha");
    expect(allNodes(a).map((t) => t.id)).toEqual(allNodes(b).map((t) => t.id));
    expect(allNodes(a).map((t) => t.id).sort()).toEqual(["b", "p", "r"]);
  });
});

describe("railBoardTaskIds. What the board keeps", () => {
  const empty: TasksSharedFilters = {
    sidebar: {},
    cycleId: null,
    moduleId: null,
    goal: null,
    crew: null,
  };

  test("nothing picked means no loop narrowing at all", () => {
    // `null`, not an empty Set: an empty Set would hide every card.
    expect(railBoardTaskIds(empty)).toBeNull();
  });

  test("a goal alone narrows to the goal's cards", () => {
    const ids = railBoardTaskIds({
      ...empty,
      goal: { id: "ship-it", boardTaskIds: ["c1", "c2"] },
    });
    expect([...ids!].sort()).toEqual(["c1", "c2"]);
  });

  test("a crew alone narrows to the crew's cards", () => {
    const ids = railBoardTaskIds({
      ...empty,
      crew: { id: "alpha", boardTaskIds: ["c1", "c5"] },
    });
    expect([...ids!].sort()).toEqual(["c1", "c5"]);
  });

  test("both lit is AND. The second pick shows you LESS, never more", () => {
    const ids = railBoardTaskIds({
      ...empty,
      goal: { id: "ship-it", boardTaskIds: ["c1", "c2", "c3"] },
      crew: { id: "alpha", boardTaskIds: ["c2", "c3", "c9"] },
    });
    expect([...ids!].sort()).toEqual(["c2", "c3"]);
  });

  test("two picks that share nothing hide everything, honestly", () => {
    const ids = railBoardTaskIds({
      ...empty,
      goal: { id: "g", boardTaskIds: ["c1"] },
      crew: { id: "c", boardTaskIds: ["c2"] },
    });
    expect(ids!.size).toBe(0);
  });

  test("a graph-only pick is an empty Set, not null", () => {
    // Work with no card behind it: the board honestly shows nothing rather
    // than quietly ignoring the pick and showing all of it.
    const ids = railBoardTaskIds({
      ...empty,
      goal: { id: "graph-only", boardTaskIds: [] },
    });
    expect(ids).not.toBeNull();
    expect(ids!.size).toBe(0);
  });
});

describe("one rail for the whole place", () => {
  test("the place mounts it once, above the lens", async () => {
    const src = await readSrc("components/tasks/TasksPlace.tsx");
    // One `PlacePage`, one `TasksSidebar`, and the lens chosen INSIDE it — so
    // the rail is the same element either side of a lens change and keeps its
    // scroll, its open groups and its selection across one.
    expect(src).toContain("<PlacePage");
    expect(src).toContain("<TasksSidebar");
    expect(src).toContain("isCrewLens(lens)");
    expect(src).toContain("<CrewSurface");
    expect(src).toContain("<TasksBoard");
  });

  test("the host hands Tasks to the place, not to a surface", async () => {
    const app = await readSrc("App.tsx");
    expect(app).toContain("<TasksPlace");
    // Mounting either surface directly is how the crew lenses ended up with no
    // rail and their own panel instead.
    expect(app).not.toContain("<CrewSurface");
  });

  test("no lens draws a sidebar of its own", async () => {
    // The plan sidebar is gone — deleted, not hidden behind a toggle — and the
    // workspace that hosted it draws only the body now.
    expect(
      await Bun.file(
        `${import.meta.dir}/../src/components/commons/crew/CrewPlanSidebar.tsx`,
      ).exists(),
    ).toBe(false);

    const workspace = await readSrc("components/commons/crew/CrewWorkspace.tsx");
    expect(workspace).not.toContain("CrewPlanSidebar");
    expect(workspace).not.toContain("<aside");

    const surface = await readSrc("components/commons/crew/CrewSurface.tsx");
    expect(surface).not.toContain("CrewPlanSidebar");
    // …and no toggle for one, either. A rail you can hide per-lens is two
    // arrangements of the same place.
    expect(surface).not.toContain("planOpen");
  });

  test("the rail carries loops and goals, not just the backlog", async () => {
    // Tasks, loops and goals are one feature to a reader; the rail is where
    // that shows.
    const rail = await readSrc("components/workpanes/TasksSidebar.tsx");
    expect(rail).toContain("<WorkRailGroups");

    const groups = await readSrc("components/tasks/WorkRailGroups.tsx");
    for (const label of ["Goals", "Crews", "Recent runs"]) {
      expect(groups).toContain(label);
    }
    // The per-goal run controls the deleted sidebar owned came with it.
    for (const act of ["loopRunNative", "loopPause", "loopResume"]) {
      expect(groups).toContain(act);
    }
    // …as did spawning a crew, which was the only door for it.
    expect(groups).toContain("loopCrewSpawn");
  });

  test("the rail is PlaceRail's. No width of its own to fight the shell", async () => {
    const groups = await readSrc("components/tasks/WorkRailGroups.tsx");
    expect(groups).toContain("PlaceRailGroup");
    expect(groups).toContain("PlaceRailRow");
    // A hard-coded rail width here would survive the shell being made
    // resizable and quietly pin one group at the old size.
    expect(groups).not.toMatch(/\bw-\[\d+px\]/);
  });
});

describe("leaving the place drops the whole selection", () => {
  test("clear resets every narrowing, and only the narrowings", () => {
    setTasksSharedSidebar({ status: ["in_progress"] });
    setTasksSharedCycleId("cycle-1");
    setTasksSharedModuleId("mod-1");
    setTasksSharedGoal({ id: "ship-it", boardTaskIds: ["c1"] });
    setTasksSharedCrew({ id: "alpha", boardTaskIds: ["c1"] });

    clearTasksSharedFilters();

    const state = getTasksSharedFilters();
    expect(state).toEqual({
      sidebar: {},
      cycleId: null,
      moduleId: null,
      goal: null,
      crew: null,
      // `goalOfTask` is not a narrowing — it is which goal each card belongs
      // to, read off the loop graph so a row can wear its goal tag. Clearing
      // it on a button whose promise is "show me everything" would strip the
      // tag off every row until the rail's next poll. This test predates the
      // index and asserted a five-field object; it was failing on the shape,
      // not on the behaviour.
      goalOfTask: {},
    });
    expect(railBoardTaskIds(state)).toBeNull();
  });

  test("the place clears it, not the board. Switching lens must not", async () => {
    // `TasksBoard` used to clear on unmount, which was right when leaving the
    // board meant leaving Tasks. It now unmounts every time you press Plan, so
    // the lifecycle moved up to the component that owns the whole place.
    const board = await readSrc("components/TasksBoard.tsx");
    expect(board).not.toContain("clearTasksSharedFilters, []");

    const place = await readSrc("components/tasks/TasksPlace.tsx");
    expect(place).toContain("clearTasksSharedFilters");
  });
});
