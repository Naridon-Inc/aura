import { useEffect, useState } from "react";

import { api } from "../../../lib/api";
import { openExternal } from "../../../lib/openExternal";
import { useAccountStanding } from "../../nav/useAccountStanding";
import { AppNavigationPlan } from "../../ui/app-navigation";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsError, SettingsGroup } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";

// The top of the Account page: what this computer calls you, the
// workspace you act as and its plan, and whether you're signed in. All
// three read the same sources the sidebar's account row does, so the two
// can never disagree.

export function AccountOverview({ repoRoot }: { repoRoot: string }) {
  const account = useAccountStanding(repoRoot);
  return (
    <SettingsGroup>
      <DisplayNameRow />
      <SettingsRow
        title="Workspace"
        description={account.name}
        control={
          // The plan word only when the billing read said so; a signed-out
          // or unreadable account shows no badge rather than a guess.
          account.plan && (
            <span title={account.title}>
              <AppNavigationPlan>{account.plan}</AppNavigationPlan>
            </span>
          )
        }
      />
      {account.payment && (
        // A failed payment. The plan may still be on (grace period) or paused;
        // either way the fix is the same, on the web console's billing card.
        <SettingsRow
          title={account.payment.paused ? "Payment overdue" : "Payment didn't go through"}
          description={
            account.billingUrl
              ? account.payment.message
              : `${account.payment.message} Billing for this server is managed on its web console.`
          }
          control={
            account.billingUrl && (
              <Button size="sm" onClick={() => void openExternal(account.billingUrl)}>
                Update payment method
              </Button>
            )
          }
        />
      )}
      <SettingsRow
        title="Aura Cloud"
        description={
          account.connected
            ? `Signed in as ${account.who}.`
            : "Sign in to work with your team and use your Aura Cloud organization."
        }
        control={
          account.connected ? (
            <Button size="sm" variant="outline" onClick={() => void account.signOut()}>
              Sign out
            </Button>
          ) : (
            <Button size="sm" onClick={account.openSignIn}>
              Sign in
            </Button>
          )
        }
      />
    </SettingsGroup>
  );
}

/** This computer's name for you. Saved when you leave the box or press
 *  Enter; the backend keeps the old name when the box is left blank. */
function DisplayNameRow() {
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .deviceIdentity()
      .then((identity) => {
        if (!alive) return;
        setSaved(identity.display_name ?? "");
        setDraft(identity.display_name ?? "");
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);
  const commit = async () => {
    const next = draft.trim();
    if (!next || next === saved) {
      setDraft(saved);
      return;
    }
    try {
      const identity = await api.deviceUpdate(next);
      setSaved(identity.display_name);
      setDraft(identity.display_name);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <SettingsRow
      title="Display name"
      description="How you appear to teammates in Aura."
      htmlFor="setting-display-name"
      help={error && <SettingsError>{error}</SettingsError>}
      control={
        <Input
          id="setting-display-name"
          aria-label="Display name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape" && draft !== saved) {
              // The edit is cancelled here; Settings stays open. With
              // nothing to cancel, Escape closes Settings as usual.
              event.preventDefault();
              setDraft(saved);
            }
          }}
        />
      }
    />
  );
}
