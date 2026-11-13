// A review comment sits inside the diff it is about, and the diff's own
// `.ui-file-diff code` rule draws a whole diff line: a flex row that keeps its
// whitespace, with 20px gutter spans. Without an opt-out, inline code in a
// comment's prose (`step98` at the start of a sentence) became a full-width
// row with the sentence pushed below it. The comment's markdown takes its look
// back; the suggested-change diff inside the same card keeps the line rule.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ui = join(import.meta.dir, "..", "src", "components", "ui");
const patterns = readFileSync(join(ui, "patterns.css"), "utf8");
const review = readFileSync(join(ui, "diff-review.css"), "utf8");
const transcript = readFileSync(join(ui, "transcript-content.tsx"), "utf8");

function rule(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  return css.slice(at, css.indexOf("}", at) + 1);
}

describe("code inside a comment's prose", () => {
  test("the diff's line rule is what the comment has to undo", () => {
    const line = rule(patterns, ".ui-file-diff code");
    expect(line).not.toBeNull();
    expect(line).toContain("display: flex");
    expect(line).toContain("white-space: pre");
  });

  test("the prose the comment renders is the shared message markdown", () => {
    expect(transcript).toContain("ui-message-markdown");
  });

  test("inline code stays inline and wraps with the sentence", () => {
    const inline = rule(review, ".ui-diff-review-body .ui-message-markdown :not(pre) > code");
    expect(inline).not.toBeNull();
    expect(inline).toContain("display: inline");
    expect(inline).toContain("white-space: normal");
  });

  test("a fenced block is a block again, and its highlighted spans keep their width", () => {
    expect(rule(review, ".ui-diff-review-body .ui-message-markdown pre > code")).toContain("display: block");
    expect(rule(review, ".ui-diff-review-body .ui-message-markdown code > span")).toContain("width: auto");
  });

  test("every opt-out is scoped to the markdown, so a suggested change's diff keeps its lines", () => {
    const optOuts = review.match(/^\.ui-diff-review-body[^{]*code[^{]*\{/gm) ?? [];
    expect(optOuts.length).toBe(3);
    for (const sel of optOuts) expect(sel).toContain(".ui-message-markdown");
  });
});
