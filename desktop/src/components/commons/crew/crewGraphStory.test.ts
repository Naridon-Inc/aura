import { describe, expect, test } from "bun:test";

import type { LoopTask, TaskStep } from "../../../lib/api";
import { storyFor, type Labeled } from "./crewGraphLayout";

// The sentence a working node tells. Before this, every busy box read "An agent
// is building this now" — the copy Mo screenshotted and objected to. A node
// joined to its board plan (by `board_task_id`) must instead say which step it
// is on; a node with no plan keeps the generic sentence.

const GENERIC = "An agent is building this now";

function working(over: Partial<LoopTask> & { id: string }): Labeled {
  return {
    status: "working",
    task: {
      title: over.id,
      input: "",
      task_kind: "task",
      depends_on: [],
      status: "working",
      priority: "none",
      tags: [],
      created_at: 0,
      updated_at: 0,
      ...over,
    },
  };
}

const noById = new Map<string, Labeled>();

describe("a working node's story", () => {
  test("names the real step from its board plan", () => {
    const l = working({ id: "n1", board_task_id: "b1" });
    const steps = new Map<string, TaskStep[]>([
      [
        "b1",
        [
          { text: "scaffold the module", done: true },
          { text: "wire the model picker to the place", done: false },
          { text: "add the cost meter", done: false },
        ],
      ],
    ]);
    expect(storyFor(l, noById, false, steps)).toBe(
      "Step 2 of 3 — wire the model picker to the place",
    );
  });

  test("falls back to the generic sentence with no board plan behind the id", () => {
    const l = working({ id: "n1", board_task_id: "b1" });
    expect(storyFor(l, noById, false, new Map())).toBe(GENERIC);
  });

  test("falls back when the node isn't joined to a board card at all", () => {
    const l = working({ id: "n1", board_task_id: null });
    const steps = new Map<string, TaskStep[]>([
      ["b1", [{ text: "something", done: false }]],
    ]);
    expect(storyFor(l, noById, false, steps)).toBe(GENERIC);
  });

  test("falls back when the plan is fully ticked — nothing left to be on", () => {
    const l = working({ id: "n1", board_task_id: "b1" });
    const steps = new Map<string, TaskStep[]>([
      ["b1", [{ text: "done thing", done: true }]],
    ]);
    expect(storyFor(l, noById, false, steps)).toBe(GENERIC);
  });

  test("falls back when no board-steps map is supplied at all", () => {
    const l = working({ id: "n1", board_task_id: "b1" });
    expect(storyFor(l, noById, false)).toBe(GENERIC);
  });
});
