import { describe, expect, test } from "bun:test";

import type { Task, TaskStep } from "./api";
import {
  currentStep,
  currentStepStory,
  stepProgress,
  stepProgressLabel,
} from "./taskSteps";

// The plan-derived values feed three surfaces (board card, detail checklist,
// crew node story). The one rule that must never break: a task with no plan
// reports *nothing*, not "0 of 0". These cases pin that plus the "what's
// happening now" sentence the crew graph tells.

const plan = (...steps: TaskStep[]): Pick<Task, "steps"> => ({ steps });

describe("stepProgress", () => {
  test("no plan is no answer, not zero of zero", () => {
    expect(stepProgress({ steps: [] })).toBeNull();
    expect(stepProgress({ steps: undefined })).toBeNull();
    expect(stepProgressLabel({ steps: [] })).toBeNull();
  });

  test("counts ticked over total", () => {
    const t = plan(
      { text: "a", done: true },
      { text: "b", done: true },
      { text: "c", done: false },
    );
    expect(stepProgress(t)).toEqual({ done: 2, total: 3 });
    expect(stepProgressLabel(t)).toBe("2 of 3");
  });

  test("a fresh plan is zero of N, not null", () => {
    const t = plan({ text: "a", done: false }, { text: "b", done: false });
    expect(stepProgressLabel(t)).toBe("0 of 2");
  });
});

describe("currentStep / currentStepStory", () => {
  test("the current step is the first one not ticked", () => {
    const t = plan(
      { text: "scaffold the module", done: true },
      { text: "wire the model picker to the place", done: false },
      { text: "add the cost meter", done: false },
    );
    expect(currentStep(t)).toEqual({
      number: 2,
      total: 3,
      text: "wire the model picker to the place",
    });
    expect(currentStepStory(t)).toBe(
      "Step 2 of 3 — wire the model picker to the place",
    );
  });

  test("position is honest even when a later step was ticked first", () => {
    const t = plan(
      { text: "one", done: false },
      { text: "two", done: true },
    );
    expect(currentStep(t)?.number).toBe(1);
  });

  test("a fully-ticked plan has no current step and no story", () => {
    const t = plan({ text: "one", done: true }, { text: "two", done: true });
    expect(currentStep(t)).toBeNull();
    expect(currentStepStory(t)).toBeNull();
  });

  test("no plan has no story to tell", () => {
    expect(currentStepStory({ steps: [] })).toBeNull();
  });

  test("a blank step text drops the em-dash tail", () => {
    const t = plan({ text: "   ", done: false });
    expect(currentStepStory(t)).toBe("Step 1 of 1");
  });
});
