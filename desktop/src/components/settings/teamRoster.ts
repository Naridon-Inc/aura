// What the Team roster is counting, said out loud.
//
// AURA-265: the desktop Team pane read `6 members · 1 admin` while the
// production Console's Team surface reported 9, during the same audit. Both
// numbers were right and they count different populations — `team_load`
// derives the roster from *this project's* git history plus live presence
// (`cmd_team.rs::sync_with_git`), while the Console lists the members of your
// Aura organization. Nothing on screen said which, so two true numbers read
// as a contradiction, and the pane sits under a scope tab labelled
// "Organization", which invites exactly the wrong reading.
//
// So: name the population. `members` is the word that collides; "people who
// have worked in <project>" cannot be mistaken for a seat count.

/** The count line above the roster. */
export function rosterCountLine(total: number, admins: number): string {
  const people = `${total} ${total === 1 ? "person" : "people"}`;
  if (admins <= 0) return people;
  return `${people} · ${admins} admin${admins === 1 ? "" : "s"}`;
}

/** The quiet line under it, which is the whole fix: it says where these names
 *  came from, so a different number somewhere else stops being a disagreement.
 *
 *  `orgName` is passed only when this machine is signed in to Aura Cloud —
 *  that is precisely when the reader has a second number in front of them and
 *  needs to know why it differs. Signed out, the shorter sentence is the whole
 *  story and the longer one would raise a question nobody asked. */
export function rosterSourceNote(
  projectLabel: string | null | undefined,
  orgName?: string | null,
): string {
  const where = projectLabel?.trim() ? `in ${projectLabel.trim()}` : "in this project";
  const base = `Everyone who has worked ${where}, from its own history.`;
  const org = orgName?.trim();
  return org
    ? `${base} ${org} can have more members than this — they appear here once they commit.`
    : base;
}
