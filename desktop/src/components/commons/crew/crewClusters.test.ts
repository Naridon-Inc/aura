import { describe, expect, test } from "bun:test";

import type { LoopTask, ReadyViewDto } from "../../../lib/api";
import { computeCrewGraphLayout } from "./crewGraphLayout";

// A crew-filed task used to land in the "Unsorted / Loose tasks" pile — the
// screenshot Mo objected to. Now a task that belongs to a named crew groups
// under that crew's band instead. The default "main" crew is not a home
// (it means "no crew set"), so those still fall to Unsorted.

function loose(over: Partial<LoopTask> & { id: string }): LoopTask {
  return {
    title: over.id,
    input: "",
    task_kind: "task",
    depends_on: [], // edge-less → loose (no goal/objective/parent either)
    status: "ready",
    priority: "none",
    tags: [],
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function view(ready: LoopTask[]): ReadyViewDto {
  return {
    ready,
    blocked: [],
    working: [],
    done: [],
    paused: [],
    other: [],
    counts: { ready: ready.length, blocked: 0, working: 0, done: 0, paused: 0, other: 0 },
    goals: [],
    crews: [],
  };
}

function clustersOf(v: ReadyViewDto) {
  return computeCrewGraphLayout(v).clusters;
}

describe("loose-task clustering by crew", () => {
  test("a task in a named crew gets a crew band, not Unsorted", () => {
    const clusters = clustersOf(view([loose({ id: "n1", crew_id: "perf" })]));
    const crew = clusters.find((c) => c.kind === "crew");
    expect(crew).toBeTruthy();
    expect(crew?.title).toBe("perf crew");
    expect(clusters.some((c) => c.kind === "unsorted")).toBe(false);
  });

  test("the default 'main' crew is not a home — stays Unsorted", () => {
    const clusters = clustersOf(view([loose({ id: "n1", crew_id: "main" })]));
    expect(clusters.some((c) => c.kind === "crew")).toBe(false);
    expect(clusters.some((c) => c.kind === "unsorted")).toBe(true);
  });

  test("no crew set at all stays Unsorted", () => {
    const clusters = clustersOf(view([loose({ id: "n1", crew_id: null })]));
    expect(clusters.some((c) => c.kind === "crew")).toBe(false);
    expect(clusters.some((c) => c.kind === "unsorted")).toBe(true);
  });

  test("two crews make two separate bands", () => {
    const clusters = clustersOf(
      view([
        loose({ id: "n1", crew_id: "perf" }),
        loose({ id: "n2", crew_id: "docs" }),
      ]),
    );
    const crewTitles = clusters.filter((c) => c.kind === "crew").map((c) => c.title).sort();
    expect(crewTitles).toEqual(["docs crew", "perf crew"]);
  });
});
