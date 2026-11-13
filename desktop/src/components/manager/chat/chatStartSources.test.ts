import { describe, expect, test } from "bun:test";
import type { ManagerSummary, NoteSummary } from "../../../lib/api";
import { planFileName, planPagesFrom, priorChatsFrom } from "./chatStartSources";

const chat = (id: string, objective: string, updated_at: number): ManagerSummary => ({
  id,
  objective,
  status: "idle" as ManagerSummary["status"],
  created_at: 0,
  updated_at,
  task_count: 0,
  done_count: 0,
  repo_root: "/r",
});

const note = (id: string, title: string, tags: string[], updated_at: string, archived_at?: string): NoteSummary => ({
  id,
  scope: "team" as NoteSummary["scope"],
  bucket: "",
  title,
  updated_at,
  tags,
  visibility: "shared",
  archived_at,
});

describe("what a new chat can start from", () => {
  test("earlier chats: not this one, not untitled, newest first", () => {
    const rows = [chat("cur", "", 9), chat("a", "Old", 1), chat("b", "New", 5), chat("c", "  ", 7)];
    expect(priorChatsFrom(rows, "cur").map((c) => c.id)).toEqual(["b", "a"]);
  });

  test("plans: pages tagged plan, not archived, newest first", () => {
    const rows = [
      note("p1", "First", ["plan"], "2026-11-01"),
      note("n", "Notes", [], "2026-11-09"),
      note("p2", "Second", ["plan"], "2026-11-05"),
      note("p3", "Gone", ["plan"], "2026-11-08", "2026-11-08"),
    ];
    expect(planPagesFrom(rows).map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  test("a plan attaches as a Markdown file named after it", () => {
    expect(planFileName(note("p", "Sessions: survive?", ["plan"], ""))).toBe("Sessions survive.md");
  });
});
