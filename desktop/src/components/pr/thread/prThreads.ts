// Review threads on a pull request's diff: how comments fold into threads,
// the reactions a comment can carry, and the brief an agent gets when it is
// asked to fix what a reviewer said.

import type { PrComment, ReactionContent } from "../../../lib/api";

export type ThreadGroup = {
  root: PrComment;
  replies: PrComment[];
};

/** Line comments folded into threads, ordered by line; replies oldest first.
 *  A reply to a reply still lands under the thread's first comment. */
export function groupThreads(comments: PrComment[]): ThreadGroup[] {
  const byId = new Map<number, PrComment>();
  for (const c of comments) byId.set(c.id, c);
  const roots: PrComment[] = [];
  const repliesByRoot = new Map<number, PrComment[]>();
  for (const c of comments) {
    if (c.is_issue_comment) continue;
    if (c.line == null) continue;
    if (c.in_reply_to == null) {
      roots.push(c);
      continue;
    }
    let rootId = c.in_reply_to;
    let guard = 0;
    while (guard++ < 16) {
      const parent = byId.get(rootId);
      if (!parent || parent.in_reply_to == null) break;
      rootId = parent.in_reply_to;
    }
    const arr = repliesByRoot.get(rootId) ?? [];
    arr.push(c);
    repliesByRoot.set(rootId, arr);
  }
  roots.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return roots.map((root) => ({
    root,
    replies: (repliesByRoot.get(root.id) ?? []).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    ),
  }));
}

export const REACTIONS: { content: ReactionContent; emoji: string; label: string }[] = [
  { content: "THUMBS_UP", emoji: "\u{1F44D}", label: "+1" },
  { content: "THUMBS_DOWN", emoji: "\u{1F44E}", label: "-1" },
  { content: "LAUGH", emoji: "\u{1F604}", label: "laugh" },
  { content: "HOORAY", emoji: "\u{1F389}", label: "hooray" },
  { content: "CONFUSED", emoji: "\u{1F615}", label: "confused" },
  { content: "HEART", emoji: "\u{2764}\u{FE0F}", label: "heart" },
  { content: "ROCKET", emoji: "\u{1F680}", label: "rocket" },
  { content: "EYES", emoji: "\u{1F440}", label: "eyes" },
];

/** The brief for "Fix with agent": the file, the line, and what the reviewer
 *  said, so the agent opens already knowing what to address. */
export function buildCommentFixPrompt(root: PrComment): string {
  const where = !root.path
    ? "this pull request"
    : root.start_line && root.start_line !== root.line
      ? `${root.path} (lines ${root.start_line}–${root.line})`
      : root.line
        ? `${root.path} (line ${root.line})`
        : root.path;
  return [
    `Address this code-review comment in ${where}.`,
    "",
    "Comment:",
    root.body.trim(),
    "",
    "Open the file, make the fix, and briefly explain what you changed. If the comment is a question or isn't actionable, reply with your answer instead of editing.",
  ].join("\n");
}
