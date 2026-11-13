// Run with: bun test src/components/ui/document-preview.test.tsx
//
// A file's rendered side: the table a CSV becomes, the tree JSON becomes, a
// page that can't run anything, and the plain sentences shown instead when
// a file can't be drawn.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CsvPreview, HtmlPreview, JsonPreview, SvgPreview } from "./document-preview";
import { jsonTreeChildren } from "./json-tree";

describe("the CSV preview", () => {
  test("draws a header row and body rows", () => {
    const html = renderToStaticMarkup(<CsvPreview content={"name,age\nAda,36\n"} />);
    expect(html).toContain('<th class="ui-table-head" scope="col">name</th>');
    expect(html).toContain('<td class="ui-table-cell">Ada</td>');
    expect(html).not.toContain("Showing the first");
  });

  test("says when rows were cut", () => {
    const content = ["h", ...Array.from({ length: 250 }, (_, i) => String(i))].join("\n");
    expect(renderToStaticMarkup(<CsvPreview content={content} />)).toContain(
      "Showing the first 200 rows.",
    );
  });

  test("an empty file and a broken one say so", () => {
    expect(renderToStaticMarkup(<CsvPreview content="" />)).toContain("Empty CSV");
    expect(renderToStaticMarkup(<CsvPreview content={'a"b'} />)).toContain(
      "Could not preview this CSV. Open the file locally or switch to Edit to check its formatting.",
    );
  });
});

describe("the JSON preview", () => {
  test("lists a non-empty object's keys at the top", () => {
    const html = renderToStaticMarkup(
      <JsonPreview content={'{"name":"aura","tags":["a","b"],"ok":true}'} format="json" />,
    );
    expect(html).not.toContain("ui-json-root\"><ul></ul>");
    expect(html).toContain("<span>name:</span>");
    expect(html).toContain('aria-label="tags:" aria-expanded="true"');
    expect(html).toContain('data-type="String">&quot;aura&quot;');
    expect(html).toContain('data-type="Boolean">true');
    expect(html).toContain("2 items");
  });

  test("draws a link in a string as a link", () => {
    const html = renderToStaticMarkup(
      <JsonPreview content={'{"home":"https://example.com/x"}'} format="json" />,
    );
    expect(html).toContain('<a href="https://example.com/x" class="ui-json-link">');
  });

  test("shows why a file can't be drawn", () => {
    expect(renderToStaticMarkup(<JsonPreview content="{" format="json" />)).toContain(
      'role="status">Invalid JSON. Open the file as text to check its formatting.',
    );
  });

  test("folds the middle of a long list into ranges", () => {
    const list = Array.from({ length: 120 }, (_, i) => i);
    const items = jsonTreeChildren("Array", list, 50);
    expect(items.slice(0, 46).every((it) => "key" in it)).toBe(true);
    expect(items.filter((it) => "to" in it)).toEqual([
      { from: 46, to: 95 },
      { from: 96, to: 115 },
    ]);
    expect(items.slice(-4).map((it) => ("key" in it ? it.key : null))).toEqual([116, 117, 118, 119]);
  });
});

describe("pages and drawings", () => {
  test("an HTML page runs nothing", () => {
    const html = renderToStaticMarkup(<HtmlPreview html="<b>hi</b>" path="site/index.html" />);
    expect(html).toContain('title="HTML preview for site/index.html"');
    expect(html).toContain('sandbox=""');
  });

  test("an SVG is drawn as a picture of its source", () => {
    const html = renderToStaticMarkup(<SvgPreview content="<svg/>" />);
    expect(html).toContain('src="data:image/svg+xml,%3Csvg%2F%3E"');
    expect(html).toContain('alt="SVG preview"');
  });
});
