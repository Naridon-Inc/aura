import { describe, expect, test } from "bun:test";

import {
  CONFLICT_INSTRUCTIONS_HEADING,
  EMPTY_INSTRUCTIONS,
  PR_INSTRUCTIONS_HEADING,
  REVIEW_INSTRUCTIONS_HEADING,
  appendConflictInstructions,
  appendPrInstructions,
  appendReviewInstructions,
  instructionsFromSettings,
  withRepoInstructions,
} from "./repoInstructions";

describe("instructionsFromSettings", () => {
  test("reads the three fields and trims them", () => {
    const got = instructionsFromSettings({
      reviewInstructions: "  Check the migration folder.  ",
      prInstructions: "Link the Linear ticket.\n",
      conflictInstructions: null,
    });
    expect(got).toEqual({
      review: "Check the migration folder.",
      pr: "Link the Linear ticket.",
      conflicts: "",
    });
  });

  test("an older backend payload with no fields is all-empty", () => {
    expect(instructionsFromSettings({ setup: null, copyFiles: [] })).toEqual(
      EMPTY_INSTRUCTIONS,
    );
    expect(instructionsFromSettings(null)).toEqual(EMPTY_INSTRUCTIONS);
  });
});

describe("withRepoInstructions", () => {
  test("appends a heading plus the text after a blank line", () => {
    const out = withRepoInstructions("Open a PR.\n", "Use squash.", "Rules:");
    expect(out).toBe("Open a PR.\n\nRules:\nUse squash.");
  });

  test("blank text leaves the prompt exactly as it was", () => {
    expect(withRepoInstructions("Open a PR.\n", "   ", "Rules:")).toBe("Open a PR.\n");
    expect(withRepoInstructions("Open a PR.", null, "Rules:")).toBe("Open a PR.");
    expect(withRepoInstructions("Open a PR.", undefined, "Rules:")).toBe("Open a PR.");
  });
});

describe("prompt-specific appenders", () => {
  const instr = {
    review: "Flag any SQL without a prepared statement.",
    pr: "Title format: [AREA] summary.",
    conflicts: "Prefer ours for generated files under gen/.",
  };

  test("each appender picks its own field and heading", () => {
    expect(appendPrInstructions("P", instr)).toBe(
      `P\n\n${PR_INSTRUCTIONS_HEADING}\n${instr.pr}`,
    );
    expect(appendReviewInstructions("R", instr)).toBe(
      `R\n\n${REVIEW_INSTRUCTIONS_HEADING}\n${instr.review}`,
    );
    expect(appendConflictInstructions("C", instr)).toBe(
      `C\n\n${CONFLICT_INSTRUCTIONS_HEADING}\n${instr.conflicts}`,
    );
  });

  test("no instructions at all is a no-op for every appender", () => {
    expect(appendPrInstructions("P", null)).toBe("P");
    expect(appendReviewInstructions("R", undefined)).toBe("R");
    expect(appendConflictInstructions("C", EMPTY_INSTRUCTIONS)).toBe("C");
  });
});
