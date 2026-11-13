import { describe, expect, test } from "bun:test";

import { taskCreateChips } from "./taskCreateChips";
import { draftFrom, draftToCreate } from "./taskDraft";

const blank = () => draftFrom(null, undefined, "ashiq");

describe("taskCreateChips", () => {
  test("a blank task has nothing hidden to show", () => {
    expect(taskCreateChips(blank())).toEqual([]);
  });

  test("status and owners have their own pickers, so they never chip", () => {
    const d = draftFrom(null, { status: "in_progress", assignee_ids: ["lena"] }, "ashiq");
    expect(taskCreateChips(d)).toEqual([]);
  });

  test("a template's preset shows as one chip per field it set", () => {
    const d = draftFrom(
      null,
      { priority: "high", labels: ["incident", "postmortem"], estimate: 4 },
      "ashiq",
    );
    expect(taskCreateChips(d).map((c) => c.label)).toEqual([
      "High priority",
      "incident",
      "postmortem",
      "4 pts",
    ]);
  });

  test("an agent chip names the agent, an unknown one by its id", () => {
    expect(taskCreateChips({ ...blank(), agent: "claude" })[0].label).toBe("Agent: Claude");
    expect(taskCreateChips({ ...blank(), agent: "kimi" })[0].label).toBe("Agent: kimi");
  });

  test("taking a chip off returns just that field to a blank task's value", () => {
    const d = draftFrom(
      null,
      { priority: "low", labels: ["epic", "q4"], is_epic: true, agent_assignee: "codex" },
      "ashiq",
    );
    const chips = taskCreateChips(d);
    const off = (key: string) => ({ ...d, ...chips.find((c) => c.key === key)!.clear });

    expect(off("priority").priority).toBe("medium");
    expect(off("epic").isEpic).toBe(false);
    expect(off("agent").agent).toBe("");
    expect(off("label:epic").labels).toBe("q4");
    // The other fields stay as the template set them.
    expect(off("label:epic").priority).toBe("low");
  });

  test("whatever is still chipped is what gets filed", () => {
    const d = draftFrom(null, { priority: "urgent", labels: ["bug"] }, "ashiq");
    const chip = taskCreateChips(d).find((c) => c.key === "label:bug")!;
    const filed = draftToCreate({ ...d, ...chip.clear, title: " Fix it " }, "ashiq");
    expect(filed.title).toBe("Fix it");
    expect(filed.priority).toBe("urgent");
    expect(filed.labels).toEqual([]);
    expect(filed.assignee_ids).toEqual(["ashiq"]);
  });
});
