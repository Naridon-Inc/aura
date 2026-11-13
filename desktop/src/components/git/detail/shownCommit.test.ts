import { describe, expect, test } from "bun:test";
import { parseGitDate, parseShownCommit } from "./shownCommit";

const SHOWN = [
  "commit 3e1c9a0b7d2f4e6a8c0b1d3f5e7a9c2b4d6f8e0a",
  "Author: Dana Reyes <dana@example.net>",
  "Date:   Mon Nov 9 14:02:11 2026 +0100",
  "",
  "    fix(sync): retry the push when the server says 429",
  "",
  "    Waits 1s, 2s, 4s and stops after five tries.",
  "",
  " aura-cli/src/sync.rs | 3 ++-",
  " docs/retry.md        | 1 +",
  " 2 files changed, 3 insertions(+), 1 deletion(-)",
  "",
  "diff --git a/aura-cli/src/sync.rs b/aura-cli/src/sync.rs",
  "index 1111111..2222222 100644",
  "--- a/aura-cli/src/sync.rs",
  "+++ b/aura-cli/src/sync.rs",
  "@@ -1,3 +1,4 @@",
  " fn push() {",
  "-    send()",
  "+    for attempt in 0..5 {",
  "+        send()",
  " }",
  "diff --git a/docs/retry.md b/docs/retry.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/docs/retry.md",
  "@@ -0,0 +1 @@",
  "+# Retry",
  "",
].join("\n");

describe("parseShownCommit", () => {
  test("reads who, when, what it says, and every file with its own patch", () => {
    const s = parseShownCommit(SHOWN);
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.sha).toBe("3e1c9a0b7d2f4e6a8c0b1d3f5e7a9c2b4d6f8e0a");
    expect(s.author).toBe("Dana Reyes");
    expect(s.time).toBe(Date.UTC(2026, 10, 9, 13, 2, 11) / 1000);
    expect(s.message).toBe(
      "fix(sync): retry the push when the server says 429\n\nWaits 1s, 2s, 4s and stops after five tries.",
    );
    expect(s.files).toEqual([
      { path: "aura-cli/src/sync.rs", status: "M", added: 2, deleted: 1 },
      { path: "docs/retry.md", status: "A", added: 1, deleted: 0 },
    ]);
    expect(s.patches["aura-cli/src/sync.rs"].startsWith("diff --git a/aura-cli/src/sync.rs")).toBe(true);
    expect(s.patches["aura-cli/src/sync.rs"]).not.toContain("docs/retry.md");
    expect(s.patches["docs/retry.md"]).toContain("+# Retry");
  });

  test("header lines inside a patch are not counted as changed lines", () => {
    const s = parseShownCommit(SHOWN);
    // `--- a/…` and `+++ b/…` sit before the first hunk.
    expect(s?.files[0].deleted).toBe(1);
  });

  test("git's complaint about an unknown version is not a version", () => {
    expect(parseShownCommit("fatal: bad object deadbeef\n")).toBeNull();
    expect(parseShownCommit("")).toBeNull();
  });

  test("a deleted file reads as removed", () => {
    const s = parseShownCommit(
      "commit abcdef1\nAuthor: A <a@example.net>\nDate:   Tue Jan 6 09:00:00 2026 -0500\n\n    drop old\n\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n",
    );
    expect(s?.files).toEqual([{ path: "old.txt", status: "D", added: 0, deleted: 2 }]);
    expect(s?.time).toBe(Date.UTC(2026, 0, 6, 14, 0, 0) / 1000);
  });
});

describe("parseGitDate", () => {
  test("an unreadable date is zero, not a wrong date", () => {
    expect(parseGitDate("yesterday")).toBe(0);
    expect(parseGitDate("Mon Foo 9 14:02:11 2026 +0000")).toBe(0);
  });
});
