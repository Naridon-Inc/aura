import { describe, expect, test } from "bun:test";

import { PR_BODY_TEMPLATE, seedPrBody } from "./prTemplate";

describe("PR_BODY_TEMPLATE", () => {
  test("asks the three questions a reviewer opens a PR with", () => {
    expect(PR_BODY_TEMPLATE).toContain("## Summary");
    expect(PR_BODY_TEMPLATE).toContain("## Changes");
    expect(PR_BODY_TEMPLATE).toContain("## Related Issues");
  });

  test("starts at the first heading, because the title has its own field", () => {
    expect(PR_BODY_TEMPLATE.startsWith("## Summary")).toBe(true);
  });

  test("keeps its hints as HTML comments, which GitHub renders as nothing", () => {
    expect(PR_BODY_TEMPLATE).toContain(
      "<!-- Brief description of what this PR does and why. -->",
    );
    expect(PR_BODY_TEMPLATE).toContain(
      "<!-- Link related issues: Fixes #123, Closes #456 -->",
    );
  });
});

describe("seedPrBody", () => {
  test("an empty box gets the template", () => {
    expect(seedPrBody("")).toBe(PR_BODY_TEMPLATE);
    expect(seedPrBody(null)).toBe(PR_BODY_TEMPLATE);
    expect(seedPrBody(undefined)).toBe(PR_BODY_TEMPLATE);
  });

  test("a box holding only whitespace is empty, and gets the template", () => {
    expect(seedPrBody("   \n\t\n ")).toBe(PR_BODY_TEMPLATE);
  });

  test("a description someone already wrote is left exactly as it is", () => {
    const draft = "Half a sentence about the retry change";
    expect(seedPrBody(draft)).toBe(draft);
  });

  test("a generated description replaces the template instead of joining it", () => {
    // What an agent that read the diff hands over. It has to arrive whole:
    // appending it to the skeleton would leave two Summary headings and an
    // empty bullet in the middle of the real one.
    const generated = [
      "## Summary",
      "",
      "Adds the source-only explainer production system and the episode archive.",
      "",
      "## Changes",
      "",
      "- New `explainer/` pipeline that renders an episode from its sources",
      "- Archive index so a published episode keeps its citations",
    ].join("\n");
    expect(seedPrBody(generated)).toBe(generated);
    expect(seedPrBody(generated)).not.toContain("<!-- Brief description");
  });

  test("a box the author emptied stays empty — the template is not offered twice", () => {
    expect(seedPrBody("", true)).toBe("");
    expect(seedPrBody("   ", true)).toBe("   ");
    expect(seedPrBody(null, true)).toBe("");
  });

  test("resuming a draft returns the draft, not the template", () => {
    const draft = "## Summary\n\nWhat I had typed before the dialog closed.";
    expect(seedPrBody(draft, true)).toBe(draft);
  });
});
