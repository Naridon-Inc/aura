import { describe, expect, test } from "bun:test";

import { defaultFileMode, isPreviewablePath, previewFormatOf } from "./filePreviewFormat";

describe("file preview formats", () => {
  test("names each previewable format, ignoring case", () => {
    expect(previewFormatOf("/r/README.MD")).toBe("markdown");
    expect(previewFormatOf("/r/docs/page.mdx")).toBe("markdown");
    expect(previewFormatOf("/r/notes.markdown")).toBe("markdown");
    expect(previewFormatOf("/r/index.htm")).toBe("html");
    expect(previewFormatOf("/r/logo.svg")).toBe("svg");
    expect(previewFormatOf("/r/data.csv")).toBe("csv");
    expect(previewFormatOf("/r/package.json")).toBe("json");
    expect(previewFormatOf("/r/events.ndjson")).toBe("jsonl");
    expect(previewFormatOf("/r/src/main.ts")).toBeNull();
    expect(isPreviewablePath("/r/src/main.ts")).toBe(false);
  });

  test("documents open on the preview, data and code on the text", () => {
    expect(defaultFileMode("/r/README.md")).toBe("preview");
    expect(defaultFileMode("/r/table.csv")).toBe("preview");
    expect(defaultFileMode("/r/logo.svg")).toBe("preview");
    expect(defaultFileMode("/r/package.json")).toBe("edit");
    expect(defaultFileMode("/r/log.jsonl")).toBe("edit");
    expect(defaultFileMode("/r/main.rs")).toBe("edit");
  });
});
