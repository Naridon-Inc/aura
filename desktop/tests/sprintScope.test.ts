// The sprint survives; the dashboard about it does not.
//
//   bun test
//
// The Sprint lens was a second product wearing a lens's clothes — a burndown
// chart, a capacity rollup, a velocity sparkline, an at-risk heuristic — none of
// which is a way of LOOKING at the work, which is what every other cell on that
// strip offered. It went. But it also owned the only two doors in the product
// for starting a sprint and completing one, and those had to survive the
// deletion, so the arithmetic behind them moved here and the doors moved to the
// rail's Sprints group beside the sprints themselves.
//
// The invariant these defend is a unit one. "Complete sprint" tells you what you
// are about to freeze — delivered, carried, velocity — and a sprint can be
// measured in story points or in items. If those three numbers ever disagree
// about which unit they're in, the panel reads "8 delivered, 3 carried" over a
// sprint where 8 is points and 3 is cards, and you freeze a velocity that means
// nothing. `usePoints` is decided once, and everything downstream reads it.
//
// The rule is deliberately all-or-nothing: points only when EVERY member
// carries a positive estimate. Half-estimated sprints summed in points quietly
// under-report by however much wasn't estimated — the most expensive kind of
// wrong, because the number still looks like a number.

import { describe, expect, test } from "bun:test";

import type { Cycle, Task } from "../src/lib/api";
import {
  carryTargets,
  cycleAsSprint,
  isCompleted,
  planningBacklog,
  sprintScope,
} from "../src/lib/sprintScope";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: "backlog",
    priority: "medium",
    labels: [],
    created_at: 0,
    updated_at: 0,
    ...over,
  } as Task;
}

function cycle(id: string, over: Partial<Cycle> = {}): Cycle {
  return {
    id,
    name: id,
    status: "active",
    created_at: 0,
    updated_at: 0,
    ...over,
  } as Cycle;
}

describe("what a sprint is holding", () => {
  test("counts only its own non-epic members", () => {
    const rows = [
      task("a", { cycle_id: "s1" }),
      task("b", { cycle_id: "s1", status: "done" }),
      task("epic", { cycle_id: "s1", is_epic: true }),
      task("elsewhere", { cycle_id: "s2" }),
      task("loose"),
    ];
    const scope = sprintScope(rows, "s1");
    // The epic is a container for tasks — counting both double-counts the work.
    expect(scope.totalCount).toBe(2);
    expect(scope.doneCount).toBe(1);
    expect(scope.carriedCount).toBe(1);
  });

  test("total is always delivered plus carried", () => {
    const rows = [
      task("a", { cycle_id: "s1", status: "done" }),
      task("b", { cycle_id: "s1", status: "in_progress" }),
      task("c", { cycle_id: "s1", status: "in_review" }),
      task("d", { cycle_id: "s1", status: "backlog" }),
    ];
    const scope = sprintScope(rows, "s1");
    expect(scope.doneCount + scope.carriedCount).toBe(scope.totalCount);
    // Anything not finished is carried — "in review" is not delivered.
    expect(scope.carriedCount).toBe(3);
  });

  test("an empty sprint is zero everything, not a divide-by-zero", () => {
    expect(sprintScope([], "s1")).toEqual({
      totalCount: 0,
      doneCount: 0,
      totalPoints: 0,
      donePoints: 0,
      usePoints: false,
      carriedCount: 0,
      velocity: 0,
    });
  });
});

describe("points or items. Decided once", () => {
  test("points only when EVERY member is estimated", () => {
    const all = [
      task("a", { cycle_id: "s1", estimate: 3, status: "done" }),
      task("b", { cycle_id: "s1", estimate: 5 }),
    ];
    const some = [
      task("a", { cycle_id: "s1", estimate: 3, status: "done" }),
      task("b", { cycle_id: "s1" }),
    ];
    expect(sprintScope(all, "s1").usePoints).toBe(true);
    expect(sprintScope(some, "s1").usePoints).toBe(false);
  });

  test("a zero estimate is not an estimate", () => {
    // Zero is the shape of "nobody filled this in", so it must not tip a
    // sprint into a points reading that then silently under-counts.
    const rows = [
      task("a", { cycle_id: "s1", estimate: 3 }),
      task("b", { cycle_id: "s1", estimate: 0 }),
    ];
    expect(sprintScope(rows, "s1").usePoints).toBe(false);
  });

  test("an empty sprint is never a points sprint", () => {
    expect(sprintScope([], "s1").usePoints).toBe(false);
  });

  test("an unestimated epic cannot spoil an estimated sprint", () => {
    // Epics are excluded from the membership, so they are excluded from the
    // judgement too — otherwise one container would flip the whole unit.
    const rows = [
      task("a", { cycle_id: "s1", estimate: 3, status: "done" }),
      task("b", { cycle_id: "s1", estimate: 5 }),
      task("epic", { cycle_id: "s1", is_epic: true }),
    ];
    expect(sprintScope(rows, "s1").usePoints).toBe(true);
  });

  test("velocity follows the unit. Points when estimated, items when not", () => {
    const estimated = sprintScope(
      [
        task("a", { cycle_id: "s1", estimate: 3, status: "done" }),
        task("b", { cycle_id: "s1", estimate: 5, status: "done" }),
        task("c", { cycle_id: "s1", estimate: 2 }),
      ],
      "s1",
    );
    expect(estimated.usePoints).toBe(true);
    expect(estimated.donePoints).toBe(8);
    expect(estimated.totalPoints).toBe(10);
    expect(estimated.velocity).toBe(8);

    const unestimated = sprintScope(
      [
        task("a", { cycle_id: "s1", status: "done" }),
        task("b", { cycle_id: "s1", status: "done" }),
        task("c", { cycle_id: "s1" }),
      ],
      "s1",
    );
    expect(unestimated.usePoints).toBe(false);
    expect(unestimated.velocity).toBe(2);
  });

  test("a partly-estimated sprint freezes ITEMS, never a short point count", () => {
    const scope = sprintScope(
      [
        task("a", { cycle_id: "s1", estimate: 3, status: "done" }),
        task("b", { cycle_id: "s1", status: "done" }),
      ],
      "s1",
    );
    expect(scope.usePoints).toBe(false);
    // 3 would be the lie: two cards delivered, only one of them counted.
    expect(scope.velocity).toBe(2);
  });
});

describe("a completed sprint is closed for good", () => {
  test("either the status or a frozen velocity says so", () => {
    expect(isCompleted(cycle("s", { status: "completed" }))).toBe(true);
    expect(isCompleted(cycle("s", { status: "active", velocity: 8 }))).toBe(true);
    // A zero velocity is still a recorded outcome — a sprint that delivered
    // nothing has still been completed.
    expect(isCompleted(cycle("s", { status: "active", velocity: 0 }))).toBe(true);
    expect(isCompleted(cycle("s", { status: "active" }))).toBe(false);
    expect(isCompleted(cycle("s", { status: "active", velocity: null }))).toBe(
      false,
    );
  });

  test("carry targets exclude the closing sprint and every finished one", () => {
    const cycles = [
      cycle("closing"),
      cycle("open"),
      cycle("finished", { status: "completed" }),
      cycle("frozen", { velocity: 12 }),
    ];
    expect(carryTargets(cycles, "closing").map((s) => s.id)).toEqual(["open"]);
  });

  test("nowhere to carry to is an empty list, not a throw", () => {
    expect(carryTargets([cycle("closing")], "closing")).toEqual([]);
  });
});

describe("the two shapes callers speak", () => {
  test("a cycle projects to the sprint the wizard and panel expect", () => {
    const sprint = cycleAsSprint(
      cycle("s1", {
        name: "Sprint 4",
        start_date: "2026-07-01",
        end_date: "2026-07-14",
        goal: "Ship the rail",
        status: "active",
      }),
    );
    expect(sprint).toEqual({
      id: "s1",
      name: "Sprint 4",
      start: "2026-07-01",
      end: "2026-07-14",
      goal: "Ship the rail",
      active: true,
      velocity: null,
      created_at: 0,
      updated_at: 0,
    });
  });

  test("only an active cycle projects as active", () => {
    expect(cycleAsSprint(cycle("s", { status: "completed" })).active).toBe(false);
    expect(cycleAsSprint(cycle("s", { status: "planned" })).active).toBe(false);
  });
});

describe("what a new sprint can be planned out of", () => {
  test("unfinished, non-epic work that isn't already in a sprint", () => {
    const rows = [
      task("free"),
      task("taken", { cycle_id: "s1" }),
      task("finished", { status: "done" }),
      task("epic", { is_epic: true }),
      task("also-free", { status: "in_progress" }),
    ];
    expect(planningBacklog(rows).map((t) => t.id)).toEqual(["free", "also-free"]);
  });
});
