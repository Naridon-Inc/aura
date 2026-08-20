import { describe, expect, test } from "bun:test";

import { standingPlan, standingTitle, standingWho } from "./SidebarFooter";

// The chip sits on screen in every section, so a wrong word here is a wrong
// word everywhere. These pin the one way it can lie: printing a plan at
// someone who is on no plan at all.

describe("what the plan chip is allowed to say", () => {
  test("signed out asks, and shows no badge to argue with", () => {
    const out = { signedIn: false, user: "mhask", tier: "free" };
    expect(standingWho(out)).toBe("Sign in");
    expect(standingPlan(out)).toBeNull();
  });

  test("the plan word is the cloud's, tidied not invented", () => {
    expect(standingPlan({ signedIn: true, user: "mhask", tier: "free" })).toBe(
      "Free",
    );
    expect(standingPlan({ signedIn: true, user: "mhask", tier: "PRO" })).toBe(
      "Pro",
    );
  });

  test("an unreadable plan means no badge, not a guessed one", () => {
    expect(standingPlan({ signedIn: true, user: "mhask", tier: null })).toBeNull();
    expect(standingPlan({ signedIn: true, user: "mhask", tier: "  " })).toBeNull();
  });

  test("the handle carries one @, however it was stored", () => {
    expect(standingWho({ signedIn: true, user: "mhask", tier: "free" })).toBe(
      "@mhask",
    );
    expect(standingWho({ signedIn: true, user: "@mhask", tier: "free" })).toBe(
      "@mhask",
    );
  });

  test("signed in with no name still says signed in", () => {
    expect(standingWho({ signedIn: true, user: null, tier: "free" })).toBe(
      "Signed in",
    );
    expect(standingWho({ signedIn: true, user: "  ", tier: null })).toBe(
      "Signed in",
    );
  });

  test("the hover text spells out what the two words compress", () => {
    expect(
      standingTitle({ signedIn: false, user: null, tier: null }, null),
    ).toBe("Sign in to Aura’s cloud");
    expect(
      standingTitle({ signedIn: true, user: "mhask", tier: "team" }, null),
    ).toBe("@mhask · Team plan");
    // No plan to name: say whose account it is and stop there.
    expect(
      standingTitle({ signedIn: true, user: "mhask", tier: null }, null),
    ).toBe("@mhask, your account");
  });

  test("a trial says how long is left. That is the whole point of saying it", () => {
    expect(
      standingTitle({ signedIn: true, user: "mhask", tier: "team" }, 5),
    ).toBe("@mhask · Team plan · trial, 5 days left");
    expect(
      standingTitle({ signedIn: true, user: "mhask", tier: "team" }, 1),
    ).toBe("@mhask · Team plan · trial, 1 day left");
    // Zero days left is not a trial any more, and "0 days left" is a taunt.
    expect(
      standingTitle({ signedIn: true, user: "mhask", tier: "team" }, 0),
    ).toBe("@mhask · Team plan");
  });
});
