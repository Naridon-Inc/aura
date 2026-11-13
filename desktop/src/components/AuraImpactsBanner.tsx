// Sidebar notice shown while the workspace has unresolved cross-branch
// impact alerts. The Impacts sidebar tab is
// the proper review surface; this banner is the *don't miss it* signal
// so the user can't accidentally code over a function someone broke
// on another branch.
//
// Reads the same `auraReadImpacts` source as ImpactsPane / NavRail
// badge but with a slower 30s cadence — chrome-level polls shouldn't
// double the existing 4s tick(). The App-level tick() also caches
// the list and feeds the NavRail count, so this banner could be
// re-pointed at that prop later if the cost of two pollers becomes
// a concern. For now: independent + slow + best-effort.

import { useEffect, useState } from "react";
import { type ImpactAlert } from "../lib/api";
import { useDocumentVisibility } from "../lib/useDocumentVisibility";
import { relativeAgeFromSecs } from "../lib/relativeTime";
import { fetchImpacts } from "../lib/ambientCache";
import { ShellNotice, type ShellNoticeTone } from "./ui/shell-notice";

type Props = {
  repoRoot: string;
  /** App.tsx hands in `setActiveSidebarTab("impacts")` so the banner
   *  can pivot the user into the full review surface. */
  onOpenImpacts: () => void;
  /** Session-scoped dismissed-id set lives in App.tsx — survives a
   *  banner re-mount but resets on app restart so a forgotten alert
   *  resurfaces next session until it's actually resolved. */
  dismissedIds: Set<string>;
  onDismiss: (id: string) => void;
};

export function AuraImpactsBanner({
  repoRoot,
  onOpenImpacts,
  dismissedIds,
  onDismiss,
}: Props) {
  const [alerts, setAlerts] = useState<ImpactAlert[]>([]);
  const visible = useDocumentVisibility();

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const list = await fetchImpacts(repoRoot);
        if (!cancelled) setAlerts(list);
      } catch {
        /* ignore — banner is best-effort */
      }
    }
    tick();
    if (!visible) return;
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible]);

  // Filter unresolved + non-dismissed, then rank by severity so the
  // worst row drives the strip color and headline.
  const live = alerts.filter((a) => !a.resolved && !dismissedIds.has(a.id));
  if (live.length === 0) return null;
  const ranked = [...live].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  const top = ranked[0];
  const more = ranked.length - 1;

  return (
    <ShellNotice
      tone={severityTone(top.severity)}
      action={{
        label: more > 0 ? `Open all ${ranked.length}` : "Open",
        onClick: onOpenImpacts,
        title:
          more > 0
            ? `${more} more unresolved alert${more === 1 ? "" : "s"}`
            : undefined,
      }}
      onDismiss={() => onDismiss(top.id)}
      dismissLabel="Dismiss this alert for the session"
    >
      <strong>{top.function || "(unknown)"}</strong> ·{" "}
      {top.message || "impact alert"} · {relAge(top.timestamp)}
    </ShellNotice>
  );
}

function severityRank(s: string): number {
  switch (s) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

// Low severity is the "worth knowing, nothing to do" case, so it stays
// unmarked — a mark is reserved for the two tiers that actually want the user
// to stop and look.
function severityTone(s: string): ShellNoticeTone {
  if (s === "critical" || s === "high") return "error";
  if (s === "medium") return "attention";
  return "neutral";
}

function relAge(unixSecs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(unixSecs, { style: "compact" });
}
