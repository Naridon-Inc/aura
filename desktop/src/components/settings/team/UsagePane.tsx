import { useEffect, useState } from "react";

import { api, type BillingUsageByMember } from "../../../lib/api";
import { fetchBillingUsage, invalidateBillingUsage } from "../../../lib/billingCache";
import { compactNumber } from "../../../lib/compactNumber";
import { formatCost } from "../../../lib/money";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsEmpty } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/table";

// Settings → Team → Usage: per-member token spend from the cloud
// `/api/v1/billing/usage/by_member` endpoint (an admin sees everyone, a member
// sees themselves — enforced server-side).

const right = { textAlign: "right" } as const;

export function TeamUsagePane() {
  const [data, setData] = useState<BillingUsageByMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether this machine is signed in to Aura Cloud — which is not the same
   *  question as whether a spend figure came back. Both come off the same
   *  credential (`cloud_token`), so a missing one is knowable here rather
   *  than inferred from a failed request. Null means the check itself failed. */
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const auth = api
      .cloudAuthStatus()
      .then((st) => {
        if (alive) setSignedIn(st?.connected === true);
      })
      .catch(() => {
        if (alive) setSignedIn(null);
      });
    const spend = fetchBillingUsage()
      .then((r) => {
        if (alive) {
          setData(r);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) {
          setData(null);
          setError(String(e?.message ?? e));
        }
      });
    void Promise.all([auth, spend]).then(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = () => {
    // The read is shared with Overview and Cost & usage and held for a
    // minute; a Try again that returns the same cached answer isn't one.
    invalidateBillingUsage();
    setAttempt((n) => n + 1);
  };

  if (loading) {
    return (
      <p className="ui-settings-status" role="status">
        <AsciiSpinner /> Loading token spend…
      </p>
    );
  }

  // Signed out is not a failure. What fixes it is a button, not the name of
  // a field in a file on this disk or a menu path to walk.
  if (error && signedIn === false) {
    return (
      <SettingsRow
        title="Sign in to see what your team is spending"
        description={
          <>
            Aura Cloud totals what every agent your team runs costs, by person, month by month.
            Or run <code>aura usage</code> in a terminal for this machine’s own totals.
          </>
        }
        control={
          <Button
            size="sm"
            onClick={() => window.dispatchEvent(new CustomEvent("aura:open-signin"))}
          >
            Sign in
          </Button>
        }
      />
    );
  }

  if (error) {
    return (
      <SettingsRow
        role="alert"
        title="Couldn’t load token spend"
        description={
          <>
            {signedIn === null
              ? "Aura couldn’t reach the cloud, or check whether you’re signed in to it."
              : "You’re signed in, so this is the cloud not answering rather than anything you need to set up."}{" "}
            <code>{error}</code>
          </>
        }
        control={
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        }
      />
    );
  }

  const members = data?.members ?? [];
  const scope = data?.scope ?? "self";
  const month = data?.month ?? "—";
  const total = data?.total_cost_usd ?? 0;

  return (
    <>
      <SettingsRow
        title={`Token spend · ${month}`}
        description={`${scope === "org" ? "All members" : "Your usage"}. Captured per call from the cloud model proxy; members who run their own keys outside the proxy don’t show up here.`}
        control={<code>{formatCost(total)}</code>}
      />
      {members.length === 0 ? (
        <SettingsEmpty>
          No model activity recorded for {month} yet. As soon as an agent in this organization
          calls a model through the Aura proxy, its tokens land here.
        </SettingsEmpty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead style={right}>In</TableHead>
              <TableHead style={right}>Out</TableHead>
              <TableHead style={right}>USD</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.developer_id}>
                <TableCell>
                  {m.display_name || m.github_login}
                  {m.display_name && <> · @{m.github_login}</>}
                </TableCell>
                <TableCell style={right}>
                  <code>{compactNumber(m.tokens_in)}</code>
                </TableCell>
                <TableCell style={right}>
                  <code>{compactNumber(m.tokens_out)}</code>
                </TableCell>
                <TableCell style={right}>
                  <code>{formatCost(m.cost_usd)}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
