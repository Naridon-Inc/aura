// Linking a GitHub issue into a chat: which open issues the picker lists,
// how a typed query narrows them, and the markdown file the picked issue
// becomes so the agent reads it as context.

import type { GithubIssue } from "./api";

/** How many rows the picker shows, recent or searched. */
export const ISSUE_ROW_LIMIT = 50;

/** "#12", "12" or an issue URL names issue 12. */
export function issueNumberFromQuery(query: string): number | undefined {
  const q = query.trim();
  const match = q.match(/^#?(\d{1,9})$/) ?? q.match(/\/issues\/(\d{1,9})(?:[/?#]|$)/);
  return match ? Number(match[1]) : undefined;
}

function byUpdated(a: GithubIssue, b: GithubIssue): number {
  return Date.parse(b.updated_at || "") - Date.parse(a.updated_at || "") || b.number - a.number;
}

/** The open issues touched most recently, newest first. */
export function recentIssues(issues: GithubIssue[]): GithubIssue[] {
  return [...issues].sort(byUpdated).slice(0, ISSUE_ROW_LIMIT);
}

/** Issues matching `query`: the issue a number or URL names comes first,
 *  then every issue whose title, body or labels hold all the query's words. */
export function searchIssues(issues: GithubIssue[], query: string): GithubIssue[] {
  const q = query.trim().toLowerCase();
  if (!q) return recentIssues(issues);
  const number = issueNumberFromQuery(q);
  const words = q.split(/\s+/).filter(Boolean);
  const named = number === undefined ? [] : issues.filter((issue) => issue.number === number);
  const matched = issues
    .filter((issue) => {
      const text = `${issue.title}\n${issue.body}\n${issue.labels.join(" ")}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort(byUpdated);
  const seen = new Set<number>();
  return [...named, ...matched]
    .filter((issue) => !seen.has(issue.number) && seen.add(issue.number))
    .slice(0, ISSUE_ROW_LIMIT);
}

/** `gh` reports state as "OPEN" / "CLOSED". */
export function issueIsOpen(issue: Pick<GithubIssue, "state">): boolean {
  return issue.state.toLowerCase() === "open";
}

/** The issue as the markdown the agent reads. */
export function githubIssueMarkdown(issue: GithubIssue): string {
  let text = `# #${issue.number}: ${issue.title}\n\n`;
  text += `**GitHub URL:** ${issue.url}\n\n`;
  text += `**Status:** ${issueIsOpen(issue) ? "Open" : "Closed"}\n`;
  if (issue.labels.length > 0) text += `**Labels:** ${issue.labels.join(", ")}\n`;
  if (issue.body) text += `\n## Description\n\n${issue.body}\n`;
  return text;
}

export function githubIssueFileName(issue: Pick<GithubIssue, "number">): string {
  return `[GITHUB]-${issue.number}.md`;
}

/** The issue as a file the composer attaches like any other text file. */
export function githubIssueFile(issue: GithubIssue): File {
  return new File([githubIssueMarkdown(issue)], githubIssueFileName(issue), {
    type: "text/markdown",
  });
}

/** True when the error means `gh` is missing or signed out, which the picker
 *  answers with its sign-in row instead of an error. */
export function ghNeedsLogin(error: string): boolean {
  return /gh auth login|not logged in|gh CLI not found/i.test(error);
}
