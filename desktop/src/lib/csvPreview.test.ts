import { describe, expect, test } from "bun:test";

import { parseCsvPreview } from "./csvPreview";

const ready = (text: string) => {
  const r = parseCsvPreview(text);
  if (r.status !== "ready") throw new Error(`expected ready, got ${r.status}`);
  return r;
};

describe("parseCsvPreview", () => {
  test("splits rows and fields, LF or CRLF", () => {
    expect(ready("a,b\n1,2\n").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(ready("a,b\r\n1,2").rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  test("keeps commas, newlines and doubled quotes inside quotes", () => {
    expect(ready('name,note\n"Lee, Ann","said ""hi""\nthen left"\n').rows).toEqual([
      ["name", "note"],
      ["Lee, Ann", 'said "hi"\nthen left'],
    ]);
  });

  test("drops a leading byte-order mark", () => {
    expect(ready("﻿a,b").rows).toEqual([["a", "b"]]);
  });

  test("an empty file has no rows", () => {
    expect(ready("").rows).toEqual([]);
  });

  test("keeps a trailing empty quoted field", () => {
    expect(ready('a,""').rows).toEqual([["a", ""]]);
  });

  test("a stray quote or an unclosed one is invalid", () => {
    expect(parseCsvPreview('a,b"c').status).toBe("invalid");
    expect(parseCsvPreview('"a"b').status).toBe("invalid");
    expect(parseCsvPreview('"open,field').status).toBe("invalid");
  });

  test("cuts to the header and 200 rows", () => {
    const text = ["h", ...Array.from({ length: 300 }, (_, i) => String(i))].join("\n");
    const r = ready(text);
    expect(r.rows.length).toBe(201);
    expect(r.rowsTruncated).toBe(true);
    expect(r.rows[200]).toEqual(["199"]);
  });

  test("cuts to 50 columns", () => {
    const r = ready(Array.from({ length: 60 }, (_, i) => `c${i}`).join(","));
    expect(r.rows[0].length).toBe(50);
    expect(r.columnsTruncated).toBe(true);
    expect(r.rowsTruncated).toBe(false);
  });

  test("refuses a file over 1 MB", () => {
    expect(parseCsvPreview("a".repeat(1024 * 1024 + 1)).status).toBe("too-large");
    // Measured in bytes as well as characters.
    expect(parseCsvPreview("é".repeat(600 * 1024)).status).toBe("too-large");
  });
});
