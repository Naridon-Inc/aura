// The plan ladder on the Billing page: what each plan includes, in the words
// the public pricing page uses for what the server enforces, and what its
// button does for the org you're acting as.

import type { CloudPlan } from "../../../lib/cloudPlan";
import type { CloudPlanTier } from "../../ui/cloud-organization";

export type TierDoes = "checkout" | "portal" | "contact";

export type BillingFacts = {
  plan: CloudPlan | null;
  /** The org has a Stripe customer: it pays, or has paid. */
  hasBilling: boolean;
  seats: number | null;
  members: number | null;
  trialDays: number | null;
};

export const ENTERPRISE_CONTACT = "https://auravcs.com/enterprise";

const FEATURES: Record<CloudPlanTier["plan"], string[]> = {
  Pro: [
    "Cloud computer · ~60 h a month",
    "Your sessions and transcripts follow you between machines",
    "2,000 cloud syncs a month",
  ],
  Teams: [
    "Everything in Pro, for everyone",
    "Cloud computer · pooled hours per seat",
    "Live sync and Team Radar",
    "Org roles, seats and invites",
    "10,000 cloud syncs a month",
  ],
  Enterprise: ["Everything in Teams", "SSO, SAML and SCIM", "Self-hosted, or in your own VPC", "Unlimited syncs and an SLA"],
};

// The prices Stripe charges, worded as the public pricing page words them. A
// change to the Stripe price changes these with it.
const PRICES: Record<CloudPlanTier["plan"], { price: string; per?: string }> = {
  Pro: { price: "$10", per: "a month" },
  Teams: { price: "$15", per: "a seat a month" },
  Enterprise: { price: "Custom" },
};

const ORDER: CloudPlanTier["plan"][] = ["Pro", "Teams", "Enterprise"];

/** What pressing a tier's button does, and what it says. Null: no button. */
export function tierAction(tier: CloudPlanTier["plan"], facts: BillingFacts): { label: string; does: TierDoes } | null {
  const current = facts.plan === tier;
  if (tier === "Enterprise") return current ? null : { label: "Talk to us", does: "contact" };
  if (current) {
    // A trial is on the plan without paying for it: the card is what's missing.
    if (facts.trialDays !== null || !facts.hasBilling) return { label: "Add payment", does: "checkout" };
    return { label: "Manage plan", does: "portal" };
  }
  if (facts.plan === "Enterprise") return null;
  if (facts.hasBilling) return { label: "Change plan", does: "portal" };
  return { label: tier === "Pro" ? "Upgrade to Pro" : "Start Teams", does: "checkout" };
}

export function planTiers(facts: BillingFacts): CloudPlanTier[] {
  return ORDER.map((plan) => ({
    plan,
    ...PRICES[plan],
    features: FEATURES[plan],
    action: tierAction(plan, facts)?.label ?? null,
  }));
}

/** Seats a checkout asks for: everyone in the org on Teams, one person on Pro. */
export function checkoutSeats(tier: CloudPlanTier["plan"], facts: BillingFacts): number {
  if (tier !== "Teams") return 1;
  return Math.max(1, facts.members ?? 0, facts.seats ?? 0);
}

/** The Billing row's second line. */
export function billingSummary(facts: BillingFacts): string {
  if (!facts.plan) return "Reading your plan…";
  const parts: string[] = [facts.plan === "Free" ? "Free plan" : `${facts.plan} plan`];
  if (facts.trialDays !== null) parts.push(facts.trialDays === 1 ? "trial, 1 day left" : `trial, ${facts.trialDays} days left`);
  if (facts.seats && facts.plan !== "Free") parts.push(facts.seats === 1 ? "1 seat" : `${facts.seats} seats`);
  return parts.join(" · ");
}
