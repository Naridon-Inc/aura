// Why the team feed looks the way it does — and what it is allowed to say
// about that.
//
// The feed is empty far more often than it is full, so the empty state is the
// screen most people meet first. It used to open with
//
//     You're all set
//     As you and your teammates work, every AI change lands here…
//
// and it said that in three different situations, only one of which was true.
// It said it while the sign-in check was still in flight — before the app knew
// whether you were signed in at all — and if you weren't, the real answer is
// the opposite: your activity never leaves this computer until you sign in.
// With no project open the check never ran at all, so "You're all set" was not
// a flash, it was permanent.
//
// The state machine below was already correct about all of this. The copy
// beside it named three of its five cases and let the rest fall through to the
// reassuring default. Both halves live here now, and the copy is a total fold
// — every state has to answer for itself.

/** Why the feed is empty, from real signals only — never guessed.
 *   • no_project  — nothing is open, so there is no team to have activity.
 *   • checking    — the sign-in / live-sync read hasn't come back yet.
 *   • signed_out  — not signed in, so the ledger stays on this machine and a
 *                   teammate's activity cannot reach the feed (by design).
 *   • sync_off    — signed in, but live sync isn't on for this project yet.
 *   • waiting     — signed in + syncing, and nobody has done anything yet.
 *   • working     — more than one person's activity is flowing. */
export type TeamSyncState =
  | "no_project"
  | "checking"
  | "signed_out"
  | "sync_off"
  | "waiting"
  | "working";

/** Every state, so a fold over them can be checked for totality rather than
 *  trusted. Adding a case here without answering for it fails the tests. */
export const TEAM_SYNC_STATES: readonly TeamSyncState[] = [
  "no_project",
  "checking",
  "signed_out",
  "sync_off",
  "waiting",
  "working",
];

export function deriveTeamSyncState(opts: {
  hasProject: boolean;
  signedIn: boolean | null;
  syncEnabled: boolean | null;
  distinctDevelopers: number;
}): TeamSyncState {
  const { hasProject, signedIn, syncEnabled, distinctDevelopers } = opts;
  if (!hasProject) return "no_project";
  // `null` on either signal means the settings read hasn't landed. Both are
  // written by the same probe, but reading both keeps this honest if that
  // ever changes: not-yet-read is its own answer, never "no".
  if (signedIn === null || syncEnabled === null) return "checking";
  // The login gate (the durable fix): without an Aura sign-in the ledger never
  // leaves this computer, so a teammate's activity simply can't be here. That
  // is the intended privacy default, not a fault to alarm about.
  if (!signedIn) return "signed_out";
  if (!syncEnabled) return "sync_off";
  return distinctDevelopers > 1 ? "working" : "waiting";
}

/** Which real, wired action the empty state offers. Both open flows that
 *  already ship; there is no third, and never a placeholder. */
export type TeamEmptyCta = "signin" | "sync" | null;

/** What the empty feed may say, per state.
 *
 *  `tone: "waiting"` means we haven't finished reading yet — the caller draws
 *  the app's block loader with `body` as its label instead of a headline, so a
 *  pending read never renders as an answer. */
export function teamEmptyCopy(state: TeamSyncState): {
  title: string;
  body: string;
  cta: TeamEmptyCta;
  tone: "waiting" | "known";
} {
  switch (state) {
    case "no_project":
      return {
        title: "No project open",
        body: "Open a project and this is where you'll see who on your team changed what, and why.",
        cta: null,
        tone: "known",
      };
    case "checking":
      return {
        title: "",
        body: "Checking how this project is set up…",
        cta: null,
        tone: "waiting",
      };
    case "signed_out":
      return {
        title: "See your team's activity",
        body: "Sign in to Aura and every teammate's AI changes show up here, who changed what, and why. Until you do, your activity stays on this computer only.",
        cta: "signin",
        tone: "known",
      };
    case "sync_off":
      return {
        title: "Turn on team activity",
        body: "You're signed in. Turn on live sync for this project and your team's AI changes will flow in here as everyone works.",
        cta: "sync",
        tone: "known",
      };
    case "waiting":
      return {
        title: "Nothing from your team yet",
        body: "You're signed in and live sync is on. As your teammates make AI changes, they'll land here, who made them, why, and whether Aura sealed each one as a genuine record.",
        cta: null,
        tone: "known",
      };
    case "working":
      // Unreachable as things stand: this state needs more than one person's
      // activity, and the empty state only draws when there is none. It gets
      // an answer anyway, because "unreachable" is a fact about today's
      // callers and the fold has to be total either way.
      return {
        title: "Nothing to show right now",
        body: "Your team's changes are syncing, but there's nothing in this window. Refresh at the top right if you were expecting something.",
        cta: null,
        tone: "known",
      };
  }
}
