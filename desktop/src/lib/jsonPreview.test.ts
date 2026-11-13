import { describe, expect, test } from "bun:test";

import { parseJsonPreview } from "./jsonPreview";

describe("parseJsonPreview", () => {
  test("parses a JSON document", () => {
    expect(parseJsonPreview('{"a":[1,true,null]}', "json")).toEqual({
      status: "ready",
      data: { a: [1, true, null] },
    });
  });

  test("reads JSON Lines as a list, skipping blank lines", () => {
    expect(parseJsonPreview('{"a":1}\n\n{"a":2}\n', "jsonl")).toEqual({
      status: "ready",
      data: [{ a: 1 }, { a: 2 }],
    });
  });

  test("says what is wrong with a file that doesn't parse", () => {
    expect(parseJsonPreview("{nope", "json")).toEqual({
      status: "error",
      message: "Invalid JSON. Open the file as text to check its formatting.",
    });
    expect(parseJsonPreview('{"a":1}\n\n{bad}', "jsonl")).toEqual({
      status: "error",
      message: "Invalid JSON on line 3. Open the file as text to check its formatting.",
    });
  });

  test("refuses a file over 5 MB", () => {
    const r = parseJsonPreview(" ".repeat(5 * 1024 * 1024 + 1), "json");
    expect(r).toEqual({
      status: "error",
      message: "JSON preview is limited to 5 MB. Open the file as text to view it.",
    });
  });

  test("refuses JSON Lines over 100,000 lines", () => {
    const r = parseJsonPreview("1\n".repeat(100_001) + "1", "jsonl");
    expect(r).toEqual({
      status: "error",
      message:
        "JSON Lines preview is limited to 100,000 lines. Open the file as text to view it.",
    });
  });
});
