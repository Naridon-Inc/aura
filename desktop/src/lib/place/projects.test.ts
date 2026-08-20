import { describe, expect, it } from "bun:test";

import type { PlaceProjects } from "../api";
import {
  UNREAD,
  isUnnarrowed,
  projectsNotice,
  whyNotOffered,
  withheldProjects,
} from "./projects";

function answer(over: Partial<PlaceProjects> = {}): PlaceProjects {
  return { ...UNREAD, ...over };
}

describe("what to say above the list", () => {
  it("says nothing about a personal box offering its own projects", () => {
    // The normal case, and the one where a notice would be noise: nothing was
    // filtered, so there is nothing to explain.
    expect(projectsNotice(answer())).toBeNull();
    expect(projectsNotice(answer({ notice: "   " }))).toBeNull();
  });

  it("passes the backend's own sentence through rather than rewriting it", () => {
    // Two spellings of "why is this list short" is how the app ends up telling
    // somebody one thing in a tooltip and another in a panel.
    const found = answer({
      narrowed: true,
      notice: "1 other project on this machine isn't Naridon's, so it isn't listed here.",
    });
    expect(projectsNotice(found)).toBe(
      "1 other project on this machine isn't Naridon's, so it isn't listed here.",
    );
  });

  it("tells a clean filter apart from a list that could not be narrowed", () => {
    // Opposite facts. One says the list is SHORTER than the machine, the other
    // says it is WIDER than you asked for, and only the second is a reason to
    // try again.
    const filtered = answer({ narrowed: true, notice: "2 other projects…" });
    const offline = answer({
      narrowed: false,
      notice: "Showing every project on this machine — Connection refused",
    });
    expect(isUnnarrowed(filtered)).toBe(false);
    expect(isUnnarrowed(offline)).toBe(true);
  });

  it("does not call an unread place unnarrowed", () => {
    // Nothing has been asked yet. A warning here would fire on every mount.
    expect(isUnnarrowed(UNREAD)).toBe(false);
    expect(projectsNotice(UNREAD)).toBeNull();
  });
});

describe("why a project somebody expected isn't there", () => {
  const found = answer({
    narrowed: true,
    org: "naridon",
    org_name: "Naridon",
    projects: [
      { path: "/srv/alpha", name: "alpha", remote: null, branch: "main", dirty: 0 },
    ],
    withheld: [
      {
        path: "/srv/notes",
        name: "notes",
        reason: "mhask/notes belongs to mhask team, not Naridon.",
      },
    ],
    notice: "1 other project on this machine isn't Naridon's, so it isn't listed here.",
  });

  it("answers for a project the place holds and does not offer", () => {
    expect(whyNotOffered(found, "notes")).toBe(
      "mhask/notes belongs to mhask team, not Naridon.",
    );
  });

  it("answers by path as well as by name", () => {
    // The picker knows what somebody typed; the workspace composer knows the
    // path it was looking for. Both have to be able to ask.
    expect(whyNotOffered(found, "/srv/notes")).toContain("mhask team");
  });

  it("is null for a project that is on offer", () => {
    // Otherwise every caller would have to check the offered list first, and
    // one of them would forget.
    expect(whyNotOffered(found, "alpha")).toBeNull();
  });

  it("is null for a project the place never mentioned", () => {
    // "Not on this machine" and "on it but not yours" are different answers,
    // and only the second one is this function's to give.
    expect(whyNotOffered(found, "something-else")).toBeNull();
    expect(whyNotOffered(found, "  ")).toBeNull();
  });
});

describe("the held-back list", () => {
  it("is stable, so two reads of one box do not reshuffle it", () => {
    const found = answer({
      narrowed: true,
      withheld: [
        { path: "/srv/zeta", name: "zeta", reason: "not yours" },
        { path: "/srv/beta", name: "beta", reason: "not yours" },
      ],
    });
    expect(withheldProjects(found).map((w) => w.name)).toEqual(["beta", "zeta"]);
  });

  it("does not mutate the answer it was handed", () => {
    // It is state on a hook, and sorting it in place would reorder the list
    // under whoever else is reading it.
    const found = answer({
      withheld: [
        { path: "/srv/zeta", name: "zeta", reason: "not yours" },
        { path: "/srv/beta", name: "beta", reason: "not yours" },
      ],
    });
    withheldProjects(found);
    expect(found.withheld.map((w) => w.name)).toEqual(["zeta", "beta"]);
  });
});
