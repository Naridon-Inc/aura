// The claim under test: the desktop roster menu offers exactly what the
// server would permit — the same mirror the web console pins in its own
// rowPowers test, so the two surfaces cannot drift apart silently.

import { describe, expect, it } from "bun:test";

import { myRosterRole, rosterPowers } from "./orgRosterPowers";

describe("rosterPowers", () => {
  it("an owner manages everyone, including other owners", () => {
    expect(rosterPowers("owner", "member", false)).toEqual({
      changeRole: true,
      offerOwner: true,
      remove: true,
    });
    expect(rosterPowers("owner", "owner", false).changeRole).toBe(true);
  });

  it("an admin manages members but never owners, and is never offered owner", () => {
    const onMember = rosterPowers("admin", "member", false);
    expect(onMember.changeRole).toBe(true);
    expect(onMember.offerOwner).toBe(false);
    const onOwner = rosterPowers("admin", "owner", false);
    expect(onOwner.changeRole).toBe(false);
    expect(onOwner.remove).toBe(false);
  });

  it("a plain member manages nobody but may leave", () => {
    const p = rosterPowers("member", "member", false);
    expect(p.changeRole).toBe(false);
    expect(p.remove).toBe(false);
    expect(rosterPowers("member", "member", true).remove).toBe(true);
  });

  it("an unresolved role offers nothing rather than guessing", () => {
    const p = rosterPowers(null, "member", false);
    expect(p.changeRole).toBe(false);
    expect(p.remove).toBe(false);
  });
});

describe("myRosterRole", () => {
  const roster = [
    { github_login: "MHask", role: "Owner" },
    { github_login: "ana", role: "member" },
  ];

  it("finds me case-insensitively and lowercases the role", () => {
    expect(myRosterRole(roster, "mhask")).toBe("owner");
  });

  it("answers null for a login the roster has never heard of, or none at all", () => {
    expect(myRosterRole(roster, "stranger")).toBeNull();
    expect(myRosterRole(roster, null)).toBeNull();
  });
});
