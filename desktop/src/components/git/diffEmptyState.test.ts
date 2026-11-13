import { describe, expect, test } from "bun:test";

import { diffEmptyState } from "./diffEmptyState";

const head = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";

describe("diffEmptyState", () => {
  test("a binary file has nothing to draw", () => {
    const diff = "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n";
    expect(diffEmptyState(diff, false)).toBe("binary");
  });

  test("an indentation-only change is empty only while whitespace is hidden", () => {
    const diff = `${head}@@ -1,2 +1,2 @@\n-if (x) {\n-  go();\n+if (x) {\n+    go();\n`;
    expect(diffEmptyState(diff, true)).toBe("whitespace");
    expect(diffEmptyState(diff, false)).toBeNull();
  });

  test("a real edit is never empty", () => {
    const diff = `${head}@@ -1 +1 @@\n-retry(3)\n+retry(5)\n`;
    expect(diffEmptyState(diff, true)).toBeNull();
  });

  test("a line moved between hunks still counts as a change", () => {
    const diff = `${head}@@ -1,2 +1,1 @@\n-moved();\n keep();\n@@ -9,1 +8,2 @@\n end();\n+moved();\n`;
    expect(diffEmptyState(diff, true)).toBeNull();
  });
});
