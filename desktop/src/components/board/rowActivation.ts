// Which clicks on a list row mean "open this".
//
// A row's title is a button, so clicking the words works. Everything else —
// the status tag, the goal and estimate chips, the assignee stack, the gaps
// between them — is more than half the row's width, and clicking any of it did
// nothing at all (AURA-270: "a row became visually selected, but a second
// click, double-click, context-click and Return all left the list unchanged").
// A row that highlights under the pointer and then ignores it reads as a
// surface that is broken, not as one with a small hit target.
//
// So the whole row opens the task, except where something else on the row has
// its own job to do: the title button, and the tag that sets the status.

/** The things on a row that own their own click. */
const INTERACTIVE = 'a,button,input,select,textarea,[role="button"],[role="menuitem"],[role="checkbox"]';

/** Minimal shape of what a click landed on — an element, in every real case. */
export interface ClickTarget {
  closest(selector: string): unknown;
}

/**
 * Should a click that landed on `target` open the row?
 *
 * No when it landed on a control — that control has already acted, and opening
 * the task on top of setting its status would be two things from one click.
 * Yes for everything else, including a chip that is only a label and the empty
 * space around it.
 */
export function rowClickOpens(target: unknown): boolean {
  if (!target || typeof (target as ClickTarget).closest !== "function") return true;
  return (target as ClickTarget).closest(INTERACTIVE) == null;
}
