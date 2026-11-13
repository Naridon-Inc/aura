// Which plan the cloud place shows after a read, decided without the app.
//
// Every cloud page sits behind the plan gate, so a plan the app forgets — or
// a single failed read — repaints the whole page: the gate's "Reading your
// organization's plan…" on every visit, or "Sign in to Aura's cloud" because
// the sign-in check threw once while renewing. A read that couldn't be made
// keeps the plan already known; only an answer replaces it.

import type { CloudPlan } from "./cloudPlan";

export type CloudPlanRead =
  | { state: "loading"; plan: null; cloudUrl: string | null; trialDays: null }
  | { state: "signed_out"; plan: null; cloudUrl: string | null; trialDays: null }
  | { state: "unread"; plan: null; cloudUrl: string | null; trialDays: null; why: string }
  | { state: "ready"; plan: CloudPlan; cloudUrl: string | null; trialDays: number | null };

export const PLAN_LOADING: CloudPlanRead = { state: "loading", plan: null, cloudUrl: null, trialDays: null };

/** What a read came back with. `answered` is false when the read itself
 *  failed (a throw, a billing error) rather than the cloud saying so. */
export type PlanOutcome = { read: CloudPlanRead; answered: boolean };

/** The plan to show after a read: an answer replaces what was shown; a
 *  failed read keeps a plan already known and says nothing new. */
export function keptPlan(prev: CloudPlanRead, outcome: PlanOutcome): CloudPlanRead {
  return outcome.answered || prev.state !== "ready" ? outcome.read : prev;
}
