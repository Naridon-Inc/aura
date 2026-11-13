// Settings → Billing: the org's plan, its ladder, and the way to pay. Upgrades
// open Stripe's checkout in the browser; an org that already pays goes to the
// billing portal for any change. The plan is read again when the window comes
// back, so a finished checkout shows up without a restart.

import { useCallback, useEffect, useState } from "react";
import { CreditCard } from "lucide-react";

import { api, type CloudBillingStatus } from "../../../lib/api";
import { billingCheckout, billingPortal } from "../../../lib/cloudAdmin";
import { upgradeUrl } from "../../../lib/cloudPlan";
import { messageOf, onOrgChanged } from "../../../lib/cloudOrgs";
import { openExternal } from "../../../lib/openExternal";
import { refreshCloudPlan, useCloudPlan } from "../../../lib/useCloudPlan";
import { Button } from "../../ui/button";
import { CloudPlanSettings, type CloudPlanTier } from "../../ui/cloud-organization";
import { SettingsRow } from "../../ui/settings-row";
import { ErrorNote } from "../../ui/state";
import { SignedOutCloud } from "./SignedOutCloud";
import { billingSummary, checkoutSeats, ENTERPRISE_CONTACT, planTiers, tierAction, type BillingFacts } from "./planTiers";
import "../../ui/cloud-patterns.css";

function useBillingStatus(): { status: CloudBillingStatus | null; reload: () => void } {
  const [status, setStatus] = useState<CloudBillingStatus | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    api
      .cloudBillingStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [nonce]);
  useEffect(() => onOrgChanged(reload), [reload]);
  return { status, reload };
}

export function BillingPage({ onSignIn }: { onSignIn: () => void }) {
  const read = useCloudPlan();
  const { status, reload } = useBillingStatus();
  const [busy, setBusy] = useState<CloudPlanTier["plan"] | "portal" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Back from the browser: the checkout may have finished.
  useEffect(() => {
    const again = () => {
      void refreshCloudPlan(true);
      reload();
    };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [reload]);

  if (read.state === "signed_out") return <SignedOutCloud what="see your plan and pay for it" onSignIn={onSignIn} />;

  const facts: BillingFacts = {
    plan: read.plan,
    hasBilling: !!status?.has_billing,
    seats: status?.seat_count ?? null,
    members: status?.member_count ?? null,
    trialDays: read.trialDays,
  };
  const returnTo = upgradeUrl(read.cloudUrl) ?? read.cloudUrl ?? "";

  const run = async (what: CloudPlanTier["plan"] | "portal", link: () => Promise<string>) => {
    setBusy(what);
    setError(null);
    try {
      await openExternal(await link());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  const select = (tier: CloudPlanTier["plan"]) => {
    const action = tierAction(tier, facts);
    if (!action) return;
    if (action.does === "contact") return void openExternal(ENTERPRISE_CONTACT);
    if (action.does === "portal") return void run(tier, () => billingPortal(returnTo));
    const plan = tier === "Teams" ? "team" : "pro";
    return void run(tier, () => billingCheckout(plan, checkoutSeats(tier, facts), returnTo));
  };

  return (
    <CloudPlanSettings
      plan={read.plan}
      summary={read.state === "unread" ? read.why : billingSummary(facts)}
      note="Payment happens in your browser, on Stripe. Come back here and the plan updates."
      tiers={planTiers(facts)}
      busy={busy === "portal" ? null : busy}
      onSelect={select}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {facts.hasBilling && (
        <SettingsRow
          title="Payment and invoices"
          description="Card, invoices and cancelling live in the billing portal."
          control={
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run("portal", () => billingPortal(returnTo))}>
              <CreditCard />
              Manage billing
            </Button>
          }
        />
      )}
    </CloudPlanSettings>
  );
}
