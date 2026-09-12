// What the signed-in account may do to one cloud org roster row.
//
// A mirror of aura-cloud orgs.rs's authority model, so the desktop never
// offers a control the API would refuse: owner/admin manage the roster,
// `owner` itself is owner-only territory in both directions, and leaving is
// open to anyone. The one case the server still refuses — the last owner
// demoting or removing themselves — answers with a sentence the UI surfaces,
// instead of pre-computing owner counts here and drifting from the real gate.
// (The web console carries the identical mirror in teamHelpers.rowPowers.)

export interface RosterPowers {
  changeRole: boolean;
  offerOwner: boolean;
  remove: boolean;
}

export function rosterPowers(
  myRole: string | null,
  targetRole: string,
  isSelf: boolean,
): RosterPowers {
  const admin = myRole === "owner" || myRole === "admin";
  const touchable = myRole === "owner" || targetRole !== "owner";
  return {
    changeRole: admin && touchable,
    offerOwner: myRole === "owner",
    remove: isSelf || (admin && touchable),
  };
}

/** My own role, read off the roster by my GitHub login. Null when I can't be
 *  found — a state that offers nothing rather than guessing. */
export function myRosterRole(
  members: Array<{ github_login: string; role: string }>,
  myLogin: string | null | undefined,
): string | null {
  if (!myLogin) return null;
  const me = members.find(
    (m) => m.github_login.toLowerCase() === myLogin.toLowerCase(),
  );
  return me ? me.role.toLowerCase() : null;
}
