import { useCallback, useEffect, useState } from "react";
import { api, type CloudAuthStatus } from "../../lib/api";
import { useEffectiveHandle } from "../../lib/identityHandle";
import { onOrgChanged } from "../../lib/cloudOrgs";
import { upgradeUrl } from "../../lib/cloudPlan";
import { paymentNoticeOf, type PaymentNotice } from "../../lib/cloudPayment";
import {
  standingPlan,
  standingTitle,
  standingWho,
  type AccountStanding,
} from "./accountStanding";

export interface AccountView {
  connected: boolean;
  /** One letter for the avatar. */
  letter: string;
  /** The account row's name: the organization when signed in, else the device's name. */
  name: string;
  /** "@handle" or "Sign in". */
  who: string;
  /** The org line under the name in the menu header. */
  orgLine: string;
  /** Plan word when a billing read succeeded; never inferred. */
  plan: string | null;
  /** Hover text for the plan badge. */
  title: string;
  /** A failed payment the member should fix; null when payments are fine. */
  payment: PaymentNotice | null;
  /** Where the payment method is updated: the web console, on the public
   *  cloud only. */
  billingUrl: string | null;
  signOut: () => Promise<void>;
  openSignIn: () => void;
}

/** Everything the sidebar says about the account, from what the cloud actually told us. */
export function useAccountStanding(repoRoot: string): AccountView {
  const [status, setStatus] = useState<CloudAuthStatus | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [trialDays, setTrialDays] = useState<number | null>(null);
  const [payment, setPayment] = useState<PaymentNotice | null>(null);
  const [localName, setLocalName] = useState<string | null>(null);
  const handle = useEffectiveHandle(repoRoot);

  const refresh = useCallback(async () => {
    let next: CloudAuthStatus;
    try {
      next = await api.cloudAuthStatus();
    } catch {
      next = { connected: false, cloud_url: "" };
    }
    setStatus(next);
    if (!next.connected) {
      setTier(null);
      setTrialDays(null);
      setPayment(null);
      return;
    }
    try {
      const billing = await api.cloudBillingStatus();
      if (!billing.error) {
        setTier(billing.effective_plan ?? billing.plan ?? null);
        setTrialDays(billing.trial_active ? billing.trial_days_remaining ?? null : null);
        setPayment(paymentNoticeOf(billing));
      }
    } catch {
      // A token on disk doesn't guarantee a readable plan; say nothing.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    const offOrg = onOrgChanged(onChange);
    window.addEventListener("aura:cloud-auth-changed", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      offOrg();
      window.removeEventListener("aura:cloud-auth-changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [refresh]);

  useEffect(() => {
    let live = true;
    api
      .deviceIdentity()
      .then((identity) => {
        if (live) setLocalName(identity.display_name?.trim() || null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const connected = !!status?.connected;
  const standing: AccountStanding = {
    signedIn: connected,
    user: (handle ?? "").trim() || status?.user || null,
    tier,
  };
  const orgWord = status?.org_name?.trim() || status?.org_slug?.trim() || "";
  const person = status?.user || localName || "";
  const name = connected ? orgWord || person || "My workspace" : person || "My workspace";

  const signOut = useCallback(async () => {
    try {
      await api.cloudAuthLogout();
    } catch {
      // Already signed out; the refresh below says so.
    }
    await refresh();
    window.dispatchEvent(new CustomEvent("aura:cloud-auth-changed"));
  }, [refresh]);

  return {
    connected,
    letter: (name.trim()[0] ?? "·").toUpperCase(),
    name,
    who: standingWho(standing),
    orgLine: connected ? (orgWord ? `${orgWord} · Aura Cloud` : "Aura Cloud") : "Sign in to sync",
    plan: standingPlan(standing),
    title: payment?.message ?? standingTitle(standing, trialDays),
    payment: connected ? payment : null,
    billingUrl: upgradeUrl(status?.cloud_url),
    signOut,
    openSignIn: () => window.dispatchEvent(new CustomEvent("aura:open-signin")),
  };
}
