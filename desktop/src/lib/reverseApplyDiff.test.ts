// What these pin: walking a patch backwards over the current file gives back
// exactly the text git diffed against — including the last-line newline — and
// refuses (null) rather than inventing a "before" when the patch and the file
// don't describe each other.

import { describe, expect, test } from "bun:test";

import { reverseApplyDiff } from "./reverseApplyDiff";

const ORIGINAL = [
  "import { sleep } from './sleep';",
  "",
  "export function retry(times: number) {",
  "  const wait = 100;",
  "  return wait;",
  "}",
  "",
  "export const MAX = 3;",
  "",
].join("\n");

const CURRENT = [
  "import { sleep } from './sleep';",
  "",
  "export function retry(times: number) {",
  "  const wait = 100 * Math.pow(2, times);",
  "  const jitter = Math.random() * 50;",
  "  return wait + jitter;",
  "}",
  "",
  "export const MAX = 5;",
  "",
].join("\n");

const DIFF = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "index 1111111..2222222 100644",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1,8 +1,9 @@",
  " import { sleep } from './sleep';",
  " ",
  " export function retry(times: number) {",
  "-  const wait = 100;",
  "-  return wait;",
  "+  const wait = 100 * Math.pow(2, times);",
  "+  const jitter = Math.random() * 50;",
  "+  return wait + jitter;",
  " }",
  " ",
  "-export const MAX = 3;",
  "+export const MAX = 5;",
  "",
].join("\n");

describe("reverseApplyDiff", () => {
  test("rebuilds the original from the current text and the patch", () => {
    expect(reverseApplyDiff(DIFF, CURRENT)).toBe(ORIGINAL);
  });

  test("handles two hunks with untouched lines between them", () => {
    const current = ["a", "B", "c", "d", "e", "f", "G", ""].join("\n");
    const diff = [
      "--- a/x",
      "+++ b/x",
      "@@ -2,1 +2,1 @@",
      "-b",
      "+B",
      "@@ -7,1 +7,1 @@",
      "-g",
      "+G",
      "",
    ].join("\n");
    expect(reverseApplyDiff(diff, current)).toBe(
      ["a", "b", "c", "d", "e", "f", "g", ""].join("\n"),
    );
  });

  test("an empty patch means nothing changed", () => {
    expect(reverseApplyDiff("", CURRENT)).toBe(CURRENT);
  });

  test("a brand-new file has an empty original", () => {
    const current = "one\ntwo\n";
    const diff = [
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");
    expect(reverseApplyDiff(diff, current)).toBe("");
  });

  test("puts the final newline back when only the new side dropped it", () => {
    const current = "a\nb";
    const diff = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+b",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(reverseApplyDiff(diff, current)).toBe("a\nb\n");
  });

  test("leaves the final newline off when the old side lacked it", () => {
    const current = "a\nb\n";
    const diff = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+b",
      "",
    ].join("\n");
    expect(reverseApplyDiff(diff, current)).toBe("a\nb");
  });

  test("refuses when the patch does not describe this text", () => {
    const drifted = CURRENT.replace("Math.pow(2, times)", "Math.pow(3, times)");
    expect(reverseApplyDiff(DIFF, drifted)).toBeNull();
  });

  test("refuses when a hunk starts past the end of the file", () => {
    const diff = ["--- a/x", "+++ b/x", "@@ -40,1 +40,1 @@", "-old", "+new", ""].join("\n");
    expect(reverseApplyDiff(diff, "only\n")).toBeNull();
  });
});
