// Who may use an org's machines, read as rows a person can act on.
//
// The server owns the rule (aura-cloud places::entitlements): a member may open
// the org's machines when they are an owner or admin, or when they hold a cloud
// seat and the plan covers shared machines. Owners and admins are never held to
// a seat. Making, connecting and taking machines away is admin work, full stop.
//
// This file mirrors that rule for drawing — it decides which switch is on,
// which is locked and why — and never for enforcing it. Every change still goes
// to the server, which answers with its own sentence when it says no.

import type { CloudAccess, CloudOrgMember, PlaceGroup } from "./api";

/** One person on the "Who can use" list. */
export interface AccessRow {
  userId: string;
  login: string;
  name: string;
  avatar: string | null;
  role: string;
  /** `always` — owner or admin, in by role, no seat needed.
   *  `on` — holds a seat.
   *  `off` — a member without one. */
  state: "always" | "on" | "off";
  /** Whether the person looking may flip this row's switch. */
  canToggle: boolean;
  /** Why the switch is locked, when it is. */
  note: string | null;
}

const ADMIN_ROLES = new Set(["owner", "admin"]);

/** Owners and admins manage the org's machines and who may use them. */
export function mayManageAccess(myRole: string | null | undefined): boolean {
  return !!myRole && ADMIN_ROLES.has(myRole.toLowerCase());
}

/** No seats left to give. A plan with no seat count is not metered. */
export function seatsFull(access: CloudAccess | null): boolean {
  if (!access || access.seat_count <= 0) return false;
  return access.granted >= access.seat_count;
}

/** The roster as switches: admins first and locked on, then everyone else by
 *  name. A seat held by someone the roster no longer lists (left the org) is
 *  left off — the server already refuses them at the door. */
export function accessRows(
  members: CloudOrgMember[],
  access: CloudAccess | null,
  myRole: string | null | undefined,
): AccessRow[] {
  const held = new Set((access?.grants ?? []).map((g) => g.user_id));
  const manage = mayManageAccess(myRole);
  const full = seatsFull(access);
  const rows = members.map((m): AccessRow => {
    const role = m.role.toLowerCase();
    const base = {
      userId: m.user_id,
      login: m.github_login,
      name: m.display_name?.trim() || m.github_login,
      avatar: m.github_avatar ?? null,
      role,
    };
    if (ADMIN_ROLES.has(role)) {
      return { ...base, state: "always", canToggle: false, note: "Always, as an owner or admin" };
    }
    if (held.has(m.user_id)) {
      return { ...base, state: "on", canToggle: manage, note: null };
    }
    if (manage && full) {
      return { ...base, state: "off", canToggle: false, note: "No seats left" };
    }
    return { ...base, state: "off", canToggle: manage, note: null };
  });
  const rank = (r: AccessRow) => (r.state === "always" ? 0 : 1);
  return rows.sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** One line on how many seats are in use. */
export function seatLine(access: CloudAccess | null): string {
  if (!access) return "";
  const n = access.granted;
  const people = n === 1 ? "1 person has a seat" : `${n} people have a seat`;
  if (access.seat_count <= 0) return `${people} · no seat limit on this plan`;
  if (n >= access.seat_count) return `All ${access.seat_count} seats are in use`;
  return `${n} of ${access.seat_count} seats in use`;
}

/** The one sentence over the seat list: what a seat does, or who to ask for
 *  one. `alone` is a personal account — an org of one, nobody to hand a seat
 *  to; `manage` is an owner or admin, whose switches they are. */
export function accessIntro({ alone, manage }: { alone: boolean; manage: boolean }): string {
  if (alone) {
    return "This is your personal account, so its machines are yours alone. To share one, make it in a team.";
  }
  return manage
    ? "Owners and admins always can. Give anyone else a seat and they can open every machine the team has."
    : "Owners and admins decide who gets a seat. Ask one of them to be let in.";
}

/** Said under one machine's settings, where the list could read as being
 *  about that machine alone: a seat is for every machine the org has. */
export function seatReach(orgName: string | null | undefined): string {
  const org = orgName?.trim();
  return `A seat opens every machine ${org ? `${org} has` : "the team has"}, not just this one.`;
}

/** What the switch row says under the name. */
export function accessDetail(row: AccessRow): string {
  if (row.note) return row.note;
  return row.state === "on" ? "Can use the team's machines" : "Can't use them yet";
}

/** The chip a machine wears on the every-org list: whose it is. */
export function groupTag(group: Pick<PlaceGroup, "kind" | "org">): string {
  if (group.kind === "laptop") return "This laptop";
  if (group.kind === "personal") return "Personal";
  return group.org.name?.trim() || group.org.slug || "Team";
}

/** The heading over a group: which account, and how many people share it. */
export function groupHeading(group: PlaceGroup): string {
  if (group.kind === "laptop") return "Only on this laptop";
  const name = group.org.name?.trim() || group.org.slug || "Team";
  if (group.kind === "personal") return `Personal · ${name}`;
  return group.members && group.members > 1 ? `${name} · ${group.members} people` : name;
}

/** Whether a row in this group opens without switching orgs first. A box only
 *  this laptop knows belongs to no org, so it opens from anywhere. */
export function opensHere(group: Pick<PlaceGroup, "kind" | "current">): boolean {
  return group.kind === "laptop" || group.current;
}
