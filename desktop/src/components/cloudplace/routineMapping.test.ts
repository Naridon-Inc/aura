import { describe, expect, test } from "bun:test";

import type { CloudRoutineRow } from "../../lib/cloudWorkspacesApi";
import { routineFromRow, routineToNew } from "./routineMapping";

const row = (over: Partial<CloudRoutineRow> = {}): CloudRoutineRow => ({
  id: "r1",
  name: "Daily standup",
  repo: "acme/api",
  agent: null,
  model: "claude-sonnet",
  effort: "High",
  prompt: "Summarize",
  enabled: true,
  webhook_configured: false,
  triggers: [{ id: "t1", kind: "schedule", config: { days: [1, 2, 3, 4, 5], at: "09:00", tz: "UTC" } }],
  run_count: 3,
  last_fired_at: null,
  created_at: "2026-11-01T00:00:00Z",
  ...over,
});

describe("routineFromRow", () => {
  test("weekday schedule reads as Every weekday", () => {
    const r = routineFromRow(row(), Date.now());
    expect(r.triggers[0]).toMatchObject({ type: "Scheduled", schedule: "Every weekday", time: "09:00" });
    expect(r.runCount).toBe(3);
    expect(r.runs).toEqual([]);
  });
  test("a schedule the editor can't word keeps its days", () => {
    const r = routineFromRow(
      row({ triggers: [{ id: "t", kind: "schedule", config: { days: [6, 7], at: "10:00" } }] }),
      Date.now(),
    );
    expect(r.triggers[0]).toMatchObject({ schedule: "Custom", time: "10:00 on days 6,7" });
  });
  test("webhook trigger survives, unknown kinds are dropped", () => {
    const r = routineFromRow(
      row({ triggers: [{ id: "w", kind: "webhook", config: {} }, { id: "x", kind: "github", config: {} }] }),
      Date.now(),
    );
    expect(r.triggers.map((t) => t.type)).toEqual(["Webhook"]);
  });
});

describe("routineToNew", () => {
  test("schedules become ISO days in the given zone", () => {
    const draft = routineFromRow(row(), Date.now());
    const out = routineToNew({ ...draft, name: "  Standup ", triggers: [
      { id: "a", type: "Scheduled", schedule: "Every day", time: "08:30", event: "", filter: "" },
      { id: "b", type: "Webhook", schedule: "", time: "", event: "", filter: "" },
    ] });
    expect(out.name).toBe("Standup");
    expect(out.triggers).toEqual([
      { kind: "schedule", config: { days: [1, 2, 3, 4, 5, 6, 7], at: "08:30", tz: "UTC" } },
      { kind: "webhook", config: {} },
    ]);
    expect(out.repo).toBe("acme/api");
    expect(out.effort).toBe("High");
  });
});
