// Global top strip rendered above WorkSurface when the workspace has
// unresolved cross-branch impact alerts. The Impacts sidebar tab is
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
import { api, type ImpactAlert } from "../lib/api";
import { useDocumentVisibility } from "../lib/useDocumentVisibility";

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
        const list = await api.auraReadImpacts(repoRoot);
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

  const tone = severityTone(top.severity);

  return (
    <div
      className="flex items-center gap-2 h-7 px-3 text-[11.5px] border-b"
      style={{ background: tone.bg, borderColor: tone.border, color: tone.text }}
      role="status"
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: tone.dot }}
      />
      <span className="font-mono truncate">
        {top.function || "(unknown)"}
      </span>
      <span className="text-text-3 truncate flex-1">
        — {top.message || "impact alert"}
      </span>
      {more > 0 && (
        <button
          type="button"
          onClick={onOpenImpacts}
          className="text-[10.5px] px-1.5 py-0.5 rounded font-medium"
          style={{
            background: "color-mix(in oklab, currentColor 14%, transparent)",
          }}
          title={`${more} more unresolved alert${more === 1 ? "" : "s"}`}
        >
          +{more} more
        </button>
      )}
      <span className="text-text-4 tabular-nums text-[10.5px]">
        {relAge(top.timestamp)}
      </span>
      <button
        type="button"
        onClick={onOpenImpacts}
        className="text-[10.5px] px-2 py-0.5 rounded font-medium hover:opacity-80"
        style={{
          background: "color-mix(in oklab, currentColor 14%, transparent)",
        }}
      >
        open
      </button>
      <button
        type="button"
        onClick={() => onDismiss(top.id)}
        className="text-[12px] w-5 h-5 rounded hover:bg-bg-2 transition-colors text-text-4 hover:text-text-1"
        title="Dismiss this alert for the session"
      >
        ✕
      </button>
    </div>
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

function severityTone(s: string): {
  bg: string;
  border: string;
  text: string;
  dot: string;
} {
  if (s === "critical" || s === "high") {
    return {
      bg: "color-mix(in oklab, var(--color-red) 12%, transparent)",
      border: "color-mix(in oklab, var(--color-red) 35%, transparent)",
      text: "var(--color-red)",
      dot: "var(--color-red)",
    };
  }
  if (s === "medium") {
    return {
      bg: "color-mix(in oklab, var(--color-amber, #d4a017) 12%, transparent)",
      border: "color-mix(in oklab, var(--color-amber, #d4a017) 35%, transparent)",
      text: "var(--color-amber, #d4a017)",
      dot: "var(--color-amber, #d4a017)",
    };
  }
  return {
    bg: "color-mix(in oklab, var(--color-blue, #4a8cff) 10%, transparent)",
    border: "color-mix(in oklab, var(--color-blue, #4a8cff) 30%, transparent)",
    text: "var(--color-text-2)",
    dot: "var(--color-blue, #4a8cff)",
  };
}

function relAge(unixSecs: number): string {
  const ageS = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (ageS < 60) return `${ageS}s`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m`;
  if (ageS < 86400) return `${Math.floor(ageS / 3600)}h`;
  return `${Math.floor(ageS / 86400)}d`;
}
