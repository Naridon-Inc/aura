// The pull request's description on the Checks tab is GitHub markdown. Drawn
// as plain text it read as `## ⚠ Issues to resolve` and `**1504 commits**`;
// it is drawn the way GitHub draws it.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PrDescription } from "./PrDocument";

const BODY = [
  "## ⚠ Issues to resolve",
  "",
  "1. **Merging this PR changes nothing on `main`**, so merge it or close it.",
  "2. See [the run](https://github.com/o/r/actions/runs/1).",
  "",
  "| Check | State |",
  "| --- | --- |",
  "| build | passed |",
].join("\n");

const draw = (body: string) =>
  renderToStaticMarkup(<PrDescription body={body} onSaveBody={() => {}} action={null} />);

describe("the pull request's description", () => {
  test("reads as markdown, not as its source", () => {
    const html = draw(BODY);
    expect(html).toContain("<h2>⚠ Issues to resolve</h2>");
    expect(html).toContain("<strong>Merging this PR changes nothing on <code>main</code></strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<table>");
    expect(html).not.toContain("## ");
    expect(html).not.toContain("**");
  });

  test("a link in it opens where it points", () => {
    const html = draw(BODY);
    expect(html).toContain('href="https://github.com/o/r/actions/runs/1"');
    expect(html).toContain('target="_blank"');
  });

  test("raw HTML in it is left out, not run", () => {
    const html = draw("Before <script>alert(1)</script> after");
    expect(html).not.toContain("<script>");
  });
});
