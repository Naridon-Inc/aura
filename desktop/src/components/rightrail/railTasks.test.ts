// Run with: bun test src/components/rightrail/railTasks.test.ts
import { describe, expect, test } from "bun:test";

import type { Task, TaskState } from "../../lib/api";
import { appliedWrite, railGroup, railItems, statusWrite } from "./railTasks";

const STATES: TaskState[] = [
  { id: "backlog", name: "Backlog", group: "backlog", color: "#94a3b8", position: 100 },
  { id: "todo", name: "Todo", group: "unstarted", color: "#cbd5e1", position: 200 },
  { id: "doing", name: "Doing", group: "started", color: "#f59e0b", position: 300 },
  { id: "qa", name: "Ready for QA", group: "started", color: "#a855f7", position: 350 },
  { id: "shipped", name: "Shipped", group: "completed", color: "#22c55e", position: 450 },
  { id: "done", name: "Done", group: "completed", color: "#22c55e", position: 400 },
  { id: "dropped", name: "Dropped", group: "cancelled", color: "#ef4444", position: 500 },
] as TaskState[];
const BY_ID = new Map(STATES.map((s) => [s.id, s]));

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    sequence_id: 1,
    title: `Task ${id}`,
    description: "",
    status: "backlog",
    state_id: "backlog",
    priority: "none",
    assignee_ids: [],
    labels: [],
    label_ids: [],
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...over,
  } as Task;
}

describe("which group a row is in", () => {
  test("a custom state is read through the catalog", () => {
    expect(railGroup(task("a", { state_id: "qa", status: "backlog" }), BY_ID)).toBe("started");
  });

  test("the state wins over a stale status mirror", () => {
    expect(railGroup(task("a", { state_id: "done", status: "in_progress" }), BY_ID)).toBe("completed");
  });

  test("a built-in state id is understood without the catalog", () => {
    expect(railGroup(task("a", { state_id: "started" }), new Map())).toBe("started");
  });

  test("a row with no state is read from its status", () => {
    expect(railGroup(task("a", { state_id: "", status: "in_review" }), BY_ID)).toBe("started");
    expect(railGroup(task("a", { state_id: "", status: "done" }), BY_ID)).toBe("completed");
    expect(railGroup(task("a", { state_id: "", status: "backlog" }), BY_ID)).toBe("backlog");
  });
});

describe("the list", () => {
  test("leaves out archived and cancelled rows", () => {
    const items = railItems(
      [
        task("open"),
        task("archived", { archived_at: "2026-11-02T00:00:00Z" }),
        task("dropped", { state_id: "dropped" }),
      ],
      BY_ID,
    );
    expect(items.map((i) => i.id)).toEqual(["open"]);
  });

  test("puts work under way first, then not started, then done, newest first", () => {
    const items = railItems(
      [
        task("done-old", { state_id: "done", updated_at: "2026-11-01T00:00:00Z" }),
        task("todo", { state_id: "todo", updated_at: "2026-11-03T00:00:00Z" }),
        task("done-new", { state_id: "shipped", updated_at: "2026-11-05T00:00:00Z" }),
        task("doing", { state_id: "doing", updated_at: "2026-11-02T00:00:00Z" }),
        task("backlog", { updated_at: "2026-11-04T00:00:00Z" }),
      ],
      BY_ID,
    );
    expect(items.map((i) => [i.id, i.status])).toEqual([
      ["doing", "in_progress"],
      ["backlog", "pending"],
      ["todo", "pending"],
      ["done-new", "completed"],
      ["done-old", "completed"],
    ]);
  });

  test("names the agent before the person, and shows the description's first line", () => {
    const [item] = railItems(
      [
        task("a", {
          agent_assignee: "claude",
          assignee: "sam",
          description: "\n## Why\nThe panel is where tasks live now.\nMore detail.",
        }),
      ],
      BY_ID,
    );
    expect(item?.owner).toBe("claude");
    expect(item?.description).toBe("Why");
  });

  test("a row with nobody on it and no description has neither", () => {
    const [item] = railItems([task("a")], BY_ID);
    expect(item?.owner).toBeUndefined();
    expect(item?.description).toBeUndefined();
  });
});

describe("what a tick writes", () => {
  test("done goes to the first done column by position", () => {
    expect(statusWrite("a", "completed", STATES)).toEqual({ id: "a", state_id: "done" });
  });

  test("undone goes to the first to-do column", () => {
    expect(statusWrite("a", "pending", STATES)).toEqual({ id: "a", state_id: "todo" });
  });

  test("undone falls back to the backlog when the board has no to-do column", () => {
    const noTodo = STATES.filter((s) => s.group !== "unstarted");
    expect(statusWrite("a", "pending", noTodo)).toEqual({ id: "a", state_id: "backlog" });
  });

  test("a board whose catalog has not loaded writes the status mirror", () => {
    expect(statusWrite("a", "completed", [])).toEqual({ id: "a", status: "done" });
    expect(statusWrite("a", "pending", [])).toEqual({ id: "a", status: "backlog" });
    expect(statusWrite("a", "in_progress", [])).toEqual({ id: "a", status: "in_progress" });
  });
});

describe("the row before the write comes back", () => {
  test("moves with a state write", () => {
    const next = appliedWrite(task("a", { state_id: "doing", status: "in_progress" }), { id: "a", state_id: "done" }, STATES);
    expect(next.state_id).toBe("done");
    expect(next.status).toBe("done");
    expect(railGroup(next, BY_ID)).toBe("completed");
  });

  test("moves with a status-only write instead of staying in its old state", () => {
    const next = appliedWrite(task("a", { state_id: "doing", status: "in_progress" }), { id: "a", status: "done" }, []);
    expect(railGroup(next, new Map())).toBe("completed");
  });
});
