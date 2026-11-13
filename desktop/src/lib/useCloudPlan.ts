// The cloud place's plan, read from billing status and kept current across
// sign-in and organization switches.
//
// One plan for the whole window: the sidebar, the page gate and the plan
// buttons all show the same read, ask the server once between them, and find
// it already known when the cloud is opened again — so a cloud page no longer
// opens on "Reading your organization's plan…" each time. A read that fails
// keeps the plan already known (cloudPlanKeep). Another account or
// organization starts again from loading.

import { useEffect, useSyncExternalStore } from "react";

import { api } from "./api";
import { cloudPlanOf } from "./cloudPlan";
import { keptPlan, PLAN_LOADING, type CloudPlanRead, type PlanOutcome } from "./cloudPlanKeep";
import { accountEpoch, onAccountScopeChanged } from "./resourceCache";

export type { CloudPlanRead } from "./cloudPlanKeep";

/** A plan read this recently is shown without asking again on open. */
const FRESH_MS = 60_000;

let held: CloudPlanRead = PLAN_LOADING;
let readAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: CloudPlanRead) {
  if (next === held) return;
  held = next;
  for (const l of listeners) l();
}

async function readPlan(): Promise<PlanOutcome> {
  let cloudUrl: string | null = null;
  try {
    const auth = await api.cloudAuthStatus();
    cloudUrl = auth.cloud_url || null;
    if (!auth.connected) {
      return { answered: true, read: { state: "signed_out", plan: null, cloudUrl, trialDays: null } };
    }
  } catch {
    return { answered: false, read: { state: "signed_out", plan: null, cloudUrl, trialDays: null } };
  }
  try {
    const billing = await api.cloudBillingStatus();
    const plan = billing.error ? null : cloudPlanOf(billing.effective_plan ?? billing.plan);
    if (!plan) {
      return {
        answered: !billing.error,
        read: {
          state: "unread",
          plan: null,
          cloudUrl,
          trialDays: null,
          why: billing.error ?? "The cloud didn’t say which plan this organization is on.",
        },
      };
    }
    return {
      answered: true,
      read: {
        state: "ready",
        plan,
        cloudUrl,
        trialDays: billing.trial_active ? billing.trial_days_remaining ?? null : null,
      },
    };
  } catch (e) {
    return {
      answered: false,
      read: {
        state: "unread",
        plan: null,
        cloudUrl,
        trialDays: null,
        why: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

/** Read the plan again. Callers asking while a read is out share it, unless
 *  `force`d by someone who just changed what the answer would be. */
export function refreshCloudPlan(force = false): Promise<void> {
  if (inflight && !force) return inflight;
  const epoch = accountEpoch();
  const started: Promise<void> = readPlan()
    .then((outcome) => {
      // Asked as an account that is no longer the one in use.
      if (accountEpoch() !== epoch) return;
      readAt = Date.now();
      publish(keptPlan(held, outcome));
    })
    .finally(() => {
      if (inflight === started) inflight = null;
    });
  inflight = started;
  return started;
}

onAccountScopeChanged(() => {
  inflight = null;
  readAt = 0;
  publish(PLAN_LOADING);
  if (listeners.size > 0) void refreshCloudPlan(true);
});

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The plan as last read, for code outside React. */
export const cloudPlanNow = (): CloudPlanRead => held;
const readAgain = () => void refreshCloudPlan(true);

export function useCloudPlan(): CloudPlanRead & { refresh: () => void } {
  const read = useSyncExternalStore(subscribe, cloudPlanNow, cloudPlanNow);
  useEffect(() => {
    if (Date.now() - readAt >= FRESH_MS) void refreshCloudPlan();
  }, []);
  return { ...read, refresh: readAgain };
}
