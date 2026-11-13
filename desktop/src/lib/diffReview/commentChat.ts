// A review comment handed to the chat.
//
// The comment goes into the composer as a small markdown attachment, through
// the same path chat chips use (composerAttachments). Its file name is fixed
// per comment, so the composer's list of waiting files tells whether this
// comment is already in it — which is what turns "Add to chat" into "Remove
// from chat".

import {
  attachToComposer,
  composerAttachmentKey,
  detachFromComposer,
  latestComposerSession,
} from "../composerAttachments";
import { commentRangeLabel, markReviewed, type ReviewComment } from "./reviewComments";

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** `review-retry.ts-L12-15-ab12cd.md` */
export function commentFileName(c: ReviewComment): string {
  const lines = c.endLineNumber ? `L${c.lineNumber}-${c.endLineNumber}` : `L${c.lineNumber}`;
  const safe = baseName(c.filePath).replace(/[^A-Za-z0-9._-]+/g, "_");
  return `review-${safe}-${lines}-${c.id.slice(-6)}.md`;
}

/** What the agent reads: where the comment sits, the lines it is about, and
 *  the comment itself. */
export function commentMarkdown(c: ReviewComment): string {
  const where = commentRangeLabel(c) ?? `Line ${c.lineNumber}`;
  const side = c.side === "deletions" ? "the old version (removed lines)" : "the new version";
  const out = [`Review comment on \`${c.filePath}\` — ${where}, in ${side}.`, ""];
  if (c.suggestionBaseCode) {
    out.push("The lines:", "", "```", c.suggestionBaseCode, "```", "");
  }
  out.push(c.body.trim(), "");
  return out.join("\n");
}

export function commentFile(c: ReviewComment): File {
  return new File([commentMarkdown(c)], commentFileName(c), { type: "text/markdown" });
}

/** The chat a diff hands its comments to: the composer that came up last. */
export function commentChatTarget(): string | null {
  return latestComposerSession();
}

export function isCommentInComposer(sessionId: string, c: ReviewComment): boolean {
  return composerAttachmentKey(sessionId).split("\n").includes(commentFileName(c));
}

export function addCommentToChat(sessionId: string, c: ReviewComment): boolean {
  if (isCommentInComposer(sessionId, c)) return true;
  return attachToComposer(sessionId, commentFile(c));
}

export function removeCommentFromChat(sessionId: string, c: ReviewComment): boolean {
  return detachFromComposer(sessionId, commentFileName(c));
}

/** A chat message went out with these files attached: every comment among
 *  them has now been handed to the agent, so it is reviewed and leaves the
 *  diff. Returns how many comments that was. */
export function markSentComments(fileNames: Array<string | null | undefined>): number {
  const sent = new Set(fileNames.filter((n): n is string => !!n && n.startsWith("review-")));
  if (sent.size === 0) return 0;
  return markReviewed((c) => sent.has(commentFileName(c)));
}
