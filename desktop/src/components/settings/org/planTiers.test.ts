import { describe, expect, it } from "bun:test";
import { billingSummary, checkoutSeats, planTiers, tierAction, type BillingFacts } from "./planTiers";

const facts = (over: Partial<BillingFacts>): BillingFacts => ({
  plan: "Free",
  hasBilling: false,
  seats: null,
  members: 3,
  trialDays: null,
  ...over,
});

describe("plan tiers", () => {
  it("sells Pro and Teams to a free org, and Enterprise by talking", () => {
    expect(planTiers(facts({})).map((t) => t.action)).toEqual(["Upgrade to Pro", "Start Teams", "Talk to us"]);
    expect(tierAction("Teams", facts({}))?.does).toBe("checkout");
    expect(tierAction("Enterprise", facts({}))?.does).toBe("contact");
  });

  it("prices each plan the way Stripe charges it", () => {
    expect(planTiers(facts({})).map((t) => [t.price, t.per])).toEqual([
      ["$10", "a month"],
      ["$15", "a seat a month"],
      ["Custom", undefined],
    ]);
  });

  it("says the cloud computer comes with Pro and Teams, and nothing else is sold", () => {
    const [pro, teams] = planTiers(facts({}));
    expect(pro.features).toContain("Cloud computer · ~60 h a month");
    expect(teams.features).toContain("Cloud computer · pooled hours per seat");
    expect(planTiers(facts({})).flatMap((t) => t.features).join(" ")).not.toContain("$35");
  });

  it("asks a trial for a card on the plan it is trying", () => {
    expect(tierAction("Teams", facts({ plan: "Teams", trialDays: 9 }))).toEqual({ label: "Add payment", does: "checkout" });
  });

  it("sends a paying org to the portal for any change", () => {
    const paying = facts({ plan: "Pro", hasBilling: true, seats: 1 });
    expect(tierAction("Pro", paying)).toEqual({ label: "Manage plan", does: "portal" });
    expect(tierAction("Teams", paying)).toEqual({ label: "Change plan", does: "portal" });
  });

  it("offers an enterprise org no self-serve buttons", () => {
    const ent = facts({ plan: "Enterprise", hasBilling: true });
    expect(planTiers(ent).map((t) => t.action)).toEqual([null, null, null]);
  });

  it("buys a seat for everyone on Teams, one on Pro", () => {
    expect(checkoutSeats("Teams", facts({ members: 4, seats: 2 }))).toBe(4);
    expect(checkoutSeats("Teams", facts({ members: null, seats: null }))).toBe(1);
    expect(checkoutSeats("Pro", facts({ members: 4 }))).toBe(1);
  });

  it("says the plan, the trial and the seats", () => {
    expect(billingSummary(facts({ plan: null }))).toBe("Reading your plan…");
    expect(billingSummary(facts({}))).toBe("Free plan");
    expect(billingSummary(facts({ plan: "Teams", trialDays: 1, seats: 3 }))).toBe("Teams plan · trial, 1 day left · 3 seats");
  });
});
