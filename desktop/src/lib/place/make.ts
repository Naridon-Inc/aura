// Having Aura make the place, decided here rather than in the wizard.
//
// The other door — connect a machine you already own — is a form: you know the
// address, you type it. This one is a *decision*, and the decisions are the
// parts that must not live inside a component: whether to show the door at all,
// whether the name is one the board will take, and what to say about who will
// be able to open the thing once it exists. A component can be looked at; only
// a function can be tested.
//
// Everything here is pure. The backend owns every fact — `place_make_offer`
// answers who you are and what may be made, and the server owns the gate that
// actually decides. What is left up here is what a screen does with those
// answers, and none of it reaches anything.

import type { MadePlace, PlaceEntitled, PlaceMakeOffer, PlaceRow } from "../api";

/** The roles that may have Aura make a machine.
 *
 *  The same pair the desktop's `place_make::authority` reads and the same pair
 *  `db::is_org_admin` reads on the server. Spelled here only to decide whether
 *  to DRAW the door — nothing about this list is a gate, and a member who got
 *  past it by editing a role string in memory still meets a 403 at the row. */
const ADMIN_ROLES = ["owner", "admin"];

/** Whether the "have Aura make one" door belongs on screen for this person.
 *
 *  Read off the roster the places list already loaded, so showing the door
 *  costs no extra request. A role we could not read is NOT an admin: an offer
 *  drawn on a maybe ends in a refusal after a machine has been made, and the
 *  cost of being wrong the other way is one person not seeing a button they
 *  could have found from the wizard anyway. */
export function mayHaveOneMade(myRole: string | null | undefined): boolean {
  const role = (myRole ?? "").trim().toLowerCase();
  return ADMIN_ROLES.includes(role);
}

/** What the picker should start on: the suggested size, or the first offered.
 *
 *  The fallback matters. A backend that sent sizes with none marked suggested
 *  would otherwise leave the picker on nothing, and a wizard whose primary
 *  button is disabled with no field to fill in is a dead end. */
export function suggestedSize(offer: PlaceMakeOffer): string {
  return (offer.sizes.find((s) => s.suggested) ?? offer.sizes[0])?.id ?? "";
}

/** Why this name cannot be used yet, or null when it can.
 *
 *  Checked against the places already on screen, which is where a clash is
 *  visible: the board matches machines by name, so two places called the same
 *  thing in one org are already indistinguishable in every other surface. The
 *  server refuses it too — this only means somebody finds out before a machine
 *  has been made rather than after. */
export function nameProblem(name: string, places: PlaceRow[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null; // Not a problem, just not finished.
  if (trimmed.length > 60) {
    return "That name is too long. Something short enough to read in a list.";
  }
  const taken = places.some(
    (p) => p.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return taken ? "You already have a place called that. Pick another name." : null;
}

/** Whether the make button does anything. */
export function canSubmit(
  offer: PlaceMakeOffer | null,
  name: string,
  size: string,
  places: PlaceRow[],
): boolean {
  if (!offer?.can_make) return false;
  if (!name.trim() || !size) return false;
  return nameProblem(name, places) === null;
}

/** Who will be able to open it, in one line.
 *
 *  Three sentences for three states, because they send a person to three
 *  different places. "We could not ask" must never be drawn as "nobody has
 *  access" — the first is a network having a bad minute and the second is a
 *  team that needs seats handing out. */
export function entitledLine(entitled: PlaceEntitled | null): string {
  if (!entitled || entitled.status !== "ok") {
    return "Aura couldn't check who on your team can open cloud places right now.";
  }
  const n = entitled.members.length;
  if (n === 0) {
    return "Only owners and admins can open cloud places in this team so far. Give someone cloud access and they'll see this one too.";
  }
  const names = entitled.members.map((m) => `@${m}`);
  const listed =
    n <= 3
      ? joinNames(names)
      : `${joinNames(names.slice(0, 2))} and ${n - 2} others`;
  const seats = entitled.seats > 0 ? ` (${n} of ${entitled.seats} seats)` : "";
  return `${listed} will be able to open it${seats}.`;
}

/** An Oxford-comma-free list of at most a few names. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What to say once it exists.
 *
 *  The `note` wins when there is one: it describes something that went wrong
 *  after the place was already real, and burying that under a success line is
 *  how somebody ends up wondering why their new machine is not in the list. */
export function madeLine(made: MadePlace): string {
  if (made.note.trim()) return made.note.trim();
  return `${made.name} is ready, and it's on your team's board.`;
}

/** Whether the surface can offer to open the new place straight away.
 *
 *  Only when this laptop got a book row for it. Without one there is no address
 *  here to dial, and a button that opened a blank host would be worse than no
 *  button — the place is still on the board, and the places list is where it is
 *  picked up from. */
export function canOpenItNow(made: MadePlace): boolean {
  return made.machine_id.trim().length > 0;
}

/** Whether asking again could change the answer.
 *
 *  Only `unknown_role` can: that is a roster read that did not come back, and
 *  the next one might. Everything else is a settled fact about this install or
 *  this person — a retry on "you are not an admin" spins and lands on the same
 *  sentence, which reads as a bug rather than as an answer.
 *
 *  The refusals this returns false for are not dead ends. The other door is
 *  always open, and connecting a box you already own is a real thing to do
 *  instead — that offer is unconditional, which is why it is not decided here. */
export function worthRetrying(reason: string): boolean {
  return reason === "unknown_role";
}
