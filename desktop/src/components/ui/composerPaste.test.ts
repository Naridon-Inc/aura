import { describe, expect, test } from "bun:test";
import { isLongPaste, longPasteFile } from "./composerPaste";

describe("long paste", () => {
  test("goes in as a file past 90 lines or 5,000 characters", () => {
    expect(isLongPaste("")).toBe(false);
    expect(isLongPaste("one line")).toBe(false);
    expect(isLongPaste(Array(90).fill("x").join("\n"))).toBe(false);
    expect(isLongPaste(Array(91).fill("x").join("\n"))).toBe(true);
    expect(isLongPaste("y".repeat(5000))).toBe(false);
    expect(isLongPaste("y".repeat(5001))).toBe(true);
  });

  test("the file is plain text named for when it was pasted, with every line", async () => {
    const text = Array(120).fill("line").join("\n");
    const file = longPasteFile(text, 1_700_000_000_000);
    expect(file.name).toBe(`pasted_text_${(1_700_000_000_000).toString(36)}.txt`);
    // The host keeps text attachments by their text/ type.
    expect(file.type.startsWith("text/plain")).toBe(true);
    expect(await file.text()).toBe(text);
  });
});
