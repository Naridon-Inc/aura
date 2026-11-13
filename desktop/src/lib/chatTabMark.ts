// Which mark an Aura chat's tab wears, read off what the tab is called.
//
// A chat opens before anyone knows what it is about: the opener calls it
// "New chat" (or the plain "Aura" when reopened without a subject), and only
// once the first message is summarised does the tab learn its real title. The
// mark follows the same arc. A chat still waiting for its subject wears an
// outline bubble; once named it wears Aura's mark, or the pull-request mark if
// what it turned out to be about is a review — the same moment the name
// reveals itself, so the tab changes what it IS in one beat, not two.

/** What the opener or a fallback calls a chat before it has a subject.
 *  Lower-cased for comparison. */
const PLACEHOLDER_TITLES = new Set(["new chat", "aura", "manager", "conversation", "chat"]);

/** A subject about reviewing work: "Review the billing PR", "Reviewing
 *  changes", "PR #93 feedback". Word-bounded so "preview" is not a review. */
const REVIEW_TITLE = /\b(?:review(?:s|ed|ing)?|pull request|pr\s*#?\d+)\b/i;

export type ChatTabMarkKind = "pending" | "review" | "named";

export function chatTabMarkKind(label: string): ChatTabMarkKind {
  const title = (label ?? "").trim();
  if (!title || PLACEHOLDER_TITLES.has(title.toLowerCase())) return "pending";
  if (REVIEW_TITLE.test(title)) return "review";
  return "named";
}
