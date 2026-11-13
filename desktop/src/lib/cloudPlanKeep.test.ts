// The claim under test: the plan gate in front of every cloud page keeps a
// plan already known through a read that couldn't be made, and only an answer
// from the cloud changes what it shows.

import { describe, expect, it } from "bun:test";

import { keptPlan, PLAN_LOADING, type CloudPlanRead } from "./cloudPlanKeep";

const pro: CloudPlanRead = { state: "ready", plan: "Pro", cloudUrl: "https://cloud", trialDays: null };
const signedOut: CloudPlanRead = { state: "signed_out", plan: null, cloudUrl: null, trialDays: null };
const unread: CloudPlanRead = { state: "unread", plan: null, cloudUrl: null, trialDays: null, why: "HTTP 502" };

describe("keptPlan", () => {
  it("keeps a known plan when the sign-in check throws", () => {
    expect(keptPlan(pro, { read: signedOut, answered: false })).toBe(pro);
  });

  it("keeps a known plan when billing can't be read", () => {
    expect(keptPlan(pro, { read: unread, answered: false })).toBe(pro);
  });

  it("signs out when the cloud says the sign-in is gone", () => {
    expect(keptPlan(pro, { read: signedOut, answered: true })).toBe(signedOut);
  });

  it("shows the failure when no plan was known yet", () => {
    expect(keptPlan(PLAN_LOADING, { read: unread, answered: false })).toBe(unread);
  });

  it("takes a new plan the cloud answers with", () => {
    const teams: CloudPlanRead = { ...pro, plan: "Teams" };
    expect(keptPlan(pro, { read: teams, answered: true })).toBe(teams);
  });
});
