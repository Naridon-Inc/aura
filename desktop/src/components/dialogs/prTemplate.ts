// The skeleton the Create-PR description box starts from.
//
// An empty textarea asks the author to remember what a good description is,
// and at the end of a long branch nobody does: the PRs that came out of this
// composer were a title and nothing else, so a reviewer opening one had to
// read the diff to learn what it was for. The headings below are the three
// questions they actually ask — what is this, what did you touch, what does
// it close — and a heading you have to delete is a far better prompt than a
// placeholder you can ignore.
//
// It is a constant in its own module so there is one copy of the text. The
// dialog seeds from it, the test asserts against it, and neither can drift.

/** Pre-filled body for a new pull request. The HTML comments are hints: they
 *  are visible while you type and invisible once GitHub renders the page, so
 *  an author who answers around them leaves nothing to clean up. */
export const PR_BODY_TEMPLATE = `## Summary

<!-- Brief description of what this PR does and why. -->

## Changes

-

## Related Issues

<!-- Link related issues: Fixes #123, Closes #456 -->`;

/** What the description box should hold when a compose request arrives.
 *
 *  Two rules, and the second is the one that is easy to get wrong. A body
 *  someone already wrote — a draft the composer is resuming, or text a
 *  generator handed us — is returned untouched, because the template is an
 *  offer and not a correction. And once the template has been offered,
 *  `seeded` says so: an empty box is then an empty box on purpose, so
 *  clearing the template makes it stay cleared instead of growing back under
 *  the cursor. */
export function seedPrBody(
  provided: string | null | undefined,
  seeded = false,
): string {
  const body = provided ?? "";
  if (seeded) return body;
  return body.trim() ? body : PR_BODY_TEMPLATE;
}
