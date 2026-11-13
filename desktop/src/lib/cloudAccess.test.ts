import { describe, expect, test } from "bun:test";

import type { CloudAccess, CloudOrgMember, PlaceGroup } from "./api";
import {
  accessDetail,
  accessIntro,
  accessRows,
  groupHeading,
  groupTag,
  mayManageAccess,
  opensHere,
  seatLine,
  seatReach,
  seatsFull,
} from "./cloudAccess";

const member = (login: string, role: string): CloudOrgMember => ({
  user_id: `u-${login}`,
  github_login: login,
  role,
});

const access = (logins: string[], seats: number): CloudAccess => ({
  org_slug: "naridon",
  grants: logins.map((l) => ({ user_id: `u-${l}`, github_login: l, source: "manual" })),
  granted: logins.length,
  seat_count: seats,
  plan: "team",
});

const team = [member("zoe", "member"), member("mo", "owner"), member("ana", "member"), member("kai", "admin")];

describe("accessRows", () => {
  test("owners and admins are in by role and their switch is locked on", () => {
    const rows = accessRows(team, access([], 5), "owner");
    expect(rows.slice(0, 2).map((r) => [r.login, r.state, r.canToggle])).toEqual([
      ["kai", "always", false],
      ["mo", "always", false],
    ]);
    expect(accessDetail(rows[0])).toBe("Always, as an owner or admin");
  });

  test("a seat holder is on, everyone else off, and an admin may flip both", () => {
    const rows = accessRows(team, access(["zoe"], 5), "admin");
    const zoe = rows.find((r) => r.login === "zoe")!;
    const ana = rows.find((r) => r.login === "ana")!;
    expect([zoe.state, zoe.canToggle]).toEqual(["on", true]);
    expect([ana.state, ana.canToggle]).toEqual(["off", true]);
    expect(accessDetail(ana)).toBe("Can't use them yet");
  });

  test("a member sees the list but flips nothing — the server would refuse", () => {
    const rows = accessRows(team, access(["zoe"], 5), "member");
    expect(rows.every((r) => !r.canToggle)).toBe(true);
    expect(mayManageAccess("member")).toBe(false);
    expect(mayManageAccess(null)).toBe(false);
  });

  test("with every seat taken, a seat can still be taken back but not given", () => {
    const rows = accessRows(team, access(["zoe"], 1), "owner");
    const zoe = rows.find((r) => r.login === "zoe")!;
    const ana = rows.find((r) => r.login === "ana")!;
    expect(zoe.canToggle).toBe(true);
    expect([ana.canToggle, ana.note]).toEqual([false, "No seats left"]);
  });

  test("no access answer yet reads as nobody holding a seat, not everybody", () => {
    const rows = accessRows(team, null, "owner");
    expect(rows.filter((r) => r.state === "on")).toEqual([]);
  });
});

describe("seats", () => {
  test("a plan with no seat count is unmetered, never full", () => {
    expect(seatsFull(access(["a", "b", "c"], 0))).toBe(false);
    expect(seatLine(access(["a", "b", "c"], 0))).toBe("3 people have a seat · no seat limit on this plan");
  });

  test("the line counts used against bought", () => {
    expect(seatLine(access(["a"], 5))).toBe("1 of 5 seats in use");
    expect(seatLine(access(["a", "b"], 2))).toBe("All 2 seats are in use");
    expect(seatsFull(access(["a", "b"], 2))).toBe(true);
  });
});

describe("every-org list", () => {
  const org = (name: string | null, slug: string | null) => ({
    status: "ok",
    detail: "",
    slug,
    name,
    my_role: null,
  });
  const group = (kind: PlaceGroup["kind"], current: boolean, members: number | null): PlaceGroup => ({
    kind,
    current,
    members,
    org: kind === "laptop" ? org(null, null) : org("Naridon", "naridon"),
    places: [],
  });

  test("each row says whose it is", () => {
    expect(groupTag(group("personal", false, 1))).toBe("Personal");
    expect(groupTag(group("team", true, 4))).toBe("Naridon");
    expect(groupTag(group("laptop", false, null))).toBe("This laptop");
  });

  test("a team heading counts its people; a personal one says so", () => {
    expect(groupHeading(group("team", true, 4))).toBe("Naridon · 4 people");
    expect(groupHeading(group("personal", false, 1))).toBe("Personal · Naridon");
    expect(groupHeading(group("laptop", false, null))).toBe("Only on this laptop");
  });

  test("only the acting org and this laptop's own boxes open without a switch", () => {
    expect(opensHere(group("team", true, 4))).toBe(true);
    expect(opensHere(group("personal", false, 1))).toBe(false);
    expect(opensHere(group("laptop", false, null))).toBe(true);
  });
});

describe("the sentences over the seat list", () => {
  test("an owner or admin is told what a seat does; anyone else who to ask", () => {
    expect(accessIntro({ alone: false, manage: true })).toContain("Give anyone else a seat");
    const asking = accessIntro({ alone: false, manage: false });
    expect(asking).toContain("Ask one of them");
    expect(asking).not.toContain("Give anyone");
  });

  test("a personal account has nobody to hand a seat to, whatever its role", () => {
    for (const manage of [true, false]) {
      expect(accessIntro({ alone: true, manage })).toContain("personal account");
    }
  });

  test("under one machine, a seat is said to open all of them", () => {
    expect(seatReach("Naridon")).toBe("A seat opens every machine Naridon has, not just this one.");
    expect(seatReach("  ")).toContain("every machine the team has");
    expect(seatReach(null)).toContain("every machine the team has");
  });
});
