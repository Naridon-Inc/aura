// Team Radar — the awareness-plane band folded into the Source Control panel
// (gated by AURA_RADAR_ENABLED at the call site). Composes the reasoned
// Collisions alert layer over the ambient Activity feed, with a small toggle
// to fold in the weak callgraph-ripple (Possible) tier. Self-contained: it
// owns the poll hook and section open-state, so ChangesPanel just mounts it.
//
// Stays quiet by construction — when there's nothing on the radar the whole
// band renders nothing, so the panel is unchanged for a solo developer.

import { useState } from "react";
import { useTeamRadar } from "./useTeamRadar";
import { CollisionsSection } from "./CollisionsSection";
import { ActivitySection } from "./ActivitySection";
import { ZonesSection, useZones } from "./ZonesSection";

type Props = {
  repoRoot: string;
  enabled: boolean;
  onOpenFile?: (path: string) => void;
};

export function TeamRadarSection({ repoRoot, enabled, onOpenFile }: Props) {
  const radar = useTeamRadar(repoRoot, enabled);
  const { zones, refresh: refreshZones } = useZones(repoRoot, enabled);
  const [open, setOpen] = useState({
    collisions: true,
    zones: true,
    activity: false,
  });
  // Claim-composer visibility lives here so the band's "+ zone" header
  // button can open it even while the zone list is empty (CategorySection
  // auto-hides at count 0, so the composer can't live inside it).
  const [claimOpen, setClaimOpen] = useState(false);

  if (!enabled) return null;
  const hasContent =
    radar.events.length > 0 || radar.conflicts.length > 0 || zones.length > 0;
  if (!hasContent && !claimOpen) return null;

  return (
    <div className="border-b border-line-soft">
      <div className="flex items-center gap-2 h-7 px-3 bg-bg-1/40">
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-text-3">
          Team Radar
        </span>
        {radar.conflicts.length > 0 && (
          <span className="text-[10px] text-text-4 tabular-nums">
            {radar.conflicts.length} clash
            {radar.conflicts.length === 1 ? "" : "es"}
          </span>
        )}
        <button
          type="button"
          onClick={() => setClaimOpen((v) => !v)}
          className={`ml-auto h-5 px-1.5 rounded text-[10px] transition-colors ${
            claimOpen
              ? "text-text-1 bg-bg-2"
              : "text-text-4 hover:text-text-1 hover:bg-bg-hover"
          }`}
          title="Claim a zone — announce (or lock) the files you're working in"
        >
          + zone
        </button>
        <label
          className="flex items-center gap-1 text-[10px] text-text-4 cursor-pointer select-none"
          title="Also show which other files a teammate's edit could touch"
        >
          <input
            type="checkbox"
            checked={radar.showRipples}
            onChange={(e) => radar.setShowRipples(e.target.checked)}
            className="accent-[var(--color-accent-blue,#6aa5ff)] w-3 h-3"
          />
          ripple effects
        </label>
      </div>

      <CollisionsSection
        conflicts={radar.conflicts}
        isOpen={open.collisions}
        onToggle={() => setOpen((o) => ({ ...o, collisions: !o.collisions }))}
        onOpenFile={onOpenFile}
      />
      <ZonesSection
        repoRoot={repoRoot}
        zones={zones}
        refresh={refreshZones}
        claimOpen={claimOpen}
        onCloseClaim={() => setClaimOpen(false)}
        isOpen={open.zones}
        onToggle={() => setOpen((o) => ({ ...o, zones: !o.zones }))}
      />
      <ActivitySection
        events={radar.events}
        isOpen={open.activity}
        onToggle={() => setOpen((o) => ({ ...o, activity: !o.activity }))}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}
