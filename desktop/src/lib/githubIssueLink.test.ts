// Linking a GitHub issue: the picker's recent and searched rows, and the
// markdown file the agent receives for the picked issue.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GithubIssue } from "./api";
import {
  ISSUE_ROW_LIMIT,
  ghNeedsLogin,
  githubIssueFile,
  githubIssueMarkdown,
  issueNumberFromQuery,
  recentIssues,
  searchIssues,
} from "./githubIssueLink";

const SRC = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const issue = (number: number, title: string, extra: Partial<GithubIssue> = {}): GithubIssue => ({
  number,
  title,
  body: "",
  state: "OPEN",
  author: "octo",
  labels: [],
  url: `https://github.com/acme/app/issues/${number}`,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  ...extra,
});

describe("github issue link", () => {
  test("recent issues are the most recently updated, capped", () => {
    const rows = [
      issue(1, "old", { updated_at: "2026-10-01T00:00:00Z" }),
      issue(2, "new", { updated_at: "2026-11-09T00:00:00Z" }),
      issue(3, "mid", { updated_at: "2026-11-05T00:00:00Z" }),
    ];
    expect(recentIssues(rows).map((r) => r.number)).toEqual([2, 3, 1]);
    const many = Array.from({ length: 80 }, (_, i) => issue(i + 1, `t${i}`));
    expect(recentIssues(many)).toHaveLength(ISSUE_ROW_LIMIT);
    expect(searchIssues(rows, "  ").map((r) => r.number)).toEqual([2, 3, 1]);
  });

  test("a query matches every word across title, body and labels; a number leads", () => {
    const rows = [
      issue(7, "Crash on login", { body: "stack trace attached", updated_at: "2026-11-02T00:00:00Z" }),
      issue(12, "Dark mode colours", { labels: ["ui"], updated_at: "2026-11-03T00:00:00Z" }),
      issue(70, "Login is slow", { updated_at: "2026-11-04T00:00:00Z" }),
    ];
    expect(searchIssues(rows, "login").map((r) => r.number)).toEqual([70, 7]);
    expect(searchIssues(rows, "crash trace").map((r) => r.number)).toEqual([7]);
    expect(searchIssues(rows, "UI dark").map((r) => r.number)).toEqual([12]);
    // "#7" names issue 7; issue 70 holds no "#7" text so only 7 comes back.
    expect(searchIssues(rows, "#7").map((r) => r.number)).toEqual([7]);
    expect(searchIssues(rows, "nothing here")).toEqual([]);
    expect(issueNumberFromQuery("12")).toBe(12);
    expect(issueNumberFromQuery("https://github.com/acme/app/issues/70?x")).toBe(70);
    expect(issueNumberFromQuery("12 crash")).toBeUndefined();
  });

  test("the picked issue becomes a [GITHUB]-<n>.md file in the shape the agent reads", async () => {
    const picked = issue(42, "Keyboard shortcuts", {
      labels: ["ui", "good first issue"],
      body: "Add ⌘K.",
    });
    expect(githubIssueMarkdown(picked)).toBe(
      "# #42: Keyboard shortcuts\n\n" +
        "**GitHub URL:** https://github.com/acme/app/issues/42\n\n" +
        "**Status:** Open\n" +
        "**Labels:** ui, good first issue\n" +
        "\n## Description\n\nAdd ⌘K.\n",
    );
    expect(githubIssueMarkdown(issue(5, "Bare", { state: "CLOSED" }))).toBe(
      "# #5: Bare\n\n**GitHub URL:** https://github.com/acme/app/issues/5\n\n**Status:** Closed\n",
    );
    const file = githubIssueFile(picked);
    expect(file.name).toBe("[GITHUB]-42.md");
    expect(file.type.startsWith("text/markdown")).toBe(true);
    expect(await file.text()).toBe(githubIssueMarkdown(picked));
  });

  test("a missing or signed-out gh shows the sign-in row, other errors show as text", () => {
    expect(ghNeedsLogin("To get started with GitHub CLI, please run:  gh auth login")).toBe(true);
    expect(ghNeedsLogin("gh CLI not found — install from https://cli.github.com/ then run `gh auth login`")).toBe(true);
    expect(ghNeedsLogin("none of the git remotes configured for this repository point to a known GitHub host")).toBe(false);
  });

  test("the main chat composer opens the dialog from the add menu and ⌘I and attaches the file", () => {
    const host = read("components/manager/ManagerComposer.tsx");
    expect(host).toContain("onIssue={issueLink.toggle}");
    expect(host).toContain("<IssueLinkDialog {...issueLink.dialog} />");
    expect(host).toContain("onAttach: (file) => ingestFileRef.current(file),");
    const hook = read("components/manager/useIssueLink.ts");
    expect(hook).toContain("api\n      .githubIssueList(repoRoot)");
    expect(hook).toContain("if (issue) onAttach(githubIssueFile(issue));");
    expect(hook).toMatch(/window\.addEventListener\("keydown", onKey\)/);
    const dialog = read("components/ui/issue-link-dialog.tsx");
    for (const text of [
      'placeholder="Search issues..."',
      '"Searching issues..." : "Loading your issues..."',
      '"Search results" : "Recent issues"',
      '"No issues found" : "No open issues found"',
      'Run "gh auth login" to connect GitHub',
      "<EnterHint>Link</EnterHint>",
      "<EnterHint>Dismiss</EnterHint>",
      "shouldFilter: false, loop: true",
    ]) {
      expect(dialog).toContain(text);
    }
    const css = read("components/ui/issue-link-dialog.css");
    expect(css).toMatch(/\.ui-issue-link-dialog,\s*\.ui-dialog-content\.ui-command-dialog\.ui-link-workspaces-dialog \{[^}]*top:\s*calc\(50% - 250px\)[^}]*max-width:\s*var\(--ui-search-dialog-width, 576px\)[^}]*max-height:\s*500px[^}]*border-radius:\s*6px[^}]*background:\s*var\(--ui-sidebar-background\)/);
    expect(css).toMatch(/\.ui-issue-link-input \{[^}]*height:\s*48px[^}]*font:\s*16px\/24px/);
    expect(css).toMatch(/\.ui-issue-link-row \{[^}]*padding:\s*12px 8px/);
    expect(css).toMatch(/\.ui-issue-link-number \{[^}]*min-width:\s*64px[^}]*font:\s*12px\/16px var\(--font-mono\)/);
    expect(css).toMatch(/\.ui-issue-link-hint \{[^}]*opacity:\s*0/);
  });
});
