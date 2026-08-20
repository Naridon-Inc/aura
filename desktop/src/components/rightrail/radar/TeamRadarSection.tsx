// Team Radar — the awareness-plane band folded into the Source Control panel
// (gated by AURA_RADAR_ENABLED at the call site). Composes the reasoned
// Collisions alert layer over the ambient Activity feed, with a small toggle
// to fold in the weak callgraph-ripple (Possible) tier. Self-contained: it
// owns the poll hook and section open-state, so ChangesPanel just mounts it.
//
// Quiet is a REAL answer, not a missing feature. The engine only reports what
// happened in THIS project in the last day, so for one person on one machine
// quiet is the normal case — and a band that renders literally nothing is
// indistinguishable from broken ("where did Team Radar go?"). So when there is
// nothing on the radar it collapses to a single row — the title plus one line
// saying nobody has been in this project recently — instead of vanishing. That
// row sizes itself and never claims the panel's flexible height, so the file
// list above is still whole for a solo developer.

import { useEffect, useState } from "react";
import { useTeamRadar } from "./useTeamRadar";
import { CollisionsSection } from "./CollisionsSection";
import { ActivitySection } from "./ActivitySection";
import { ZonesSection, useZones } from "./ZonesSection";

type Props = {
  repoRoot: string;
  enabled: boolean;
  onOpenFile?: (path: string) => void;
  /** Fired whenever the band flips between its collapsed quiet row and the
   *  full stack. TRUE means "this needs the dock's share of the split"; the
   *  quiet row sizes itself, so it reports FALSE and the file list keeps the
   *  panel. Note this is NOT "am I rendering anything" — the quiet row draws
   *  and still reports false, which is the whole point. */
  onNeedsHeight?: (needsHeight: boolean) => void;
};

export function TeamRadarSection({
  repoRoot,
  enabled,
  onOpenFile,
  onNeedsHeight,
}: Props) {
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

  // Poll hooks above run every render; work out the height claim BEFORE any
  // early return so the effect that reports it obeys the rules of hooks. The
  // open claim composer counts as content — it's a real form to fill in, even
  // while the zone list behind it is empty.
  const hasContent =
    radar.events.length > 0 || radar.conflicts.length > 0 || zones.length > 0;
  const needsHeight = enabled && (hasContent || claimOpen);
  useEffect(() => {
    onNeedsHeight?.(needsHeight);
  }, [needsHeight, onNeedsHeight]);

  // Switched off by flag means the feature doesn't exist in this build, so
  // there's nothing to explain and nothing to draw — the rail stays exactly as
  // it was. That is a different thing from "on, and currently quiet", which is
  // the row below.
  if (!enabled) return null;

  if (!needsHeight) {
    return <QuietRadarRow onClaimZone={() => setClaimOpen(true)} />;
  }

  return (
    <div className="border-b border-line-soft">
      <div className="flex items-center gap-2 h-7 px-3 bg-bg-1/40">
        <span className="section-label">
          Team Radar
        </span>
        {radar.conflicts.length > 0 && (
          <span className="text-2xs text-text-4 tabular-nums">
            {radar.conflicts.length} clash
            {radar.conflicts.length === 1 ? "" : "es"}
          </span>
        )}
        <button
          type="button"
          onClick={() => setClaimOpen((v) => !v)}
          className={`ml-auto h-5 px-1.5 rounded text-2xs transition-colors ${
            claimOpen
              ? "text-text-1 bg-bg-2"
              : "text-text-4 hover:text-text-1 hover:bg-state-hover"
          }`}
          title="Claim a zone. Announce (or lock) the files you're working in"
        >
          + zone
        </button>
        <label
          className="flex items-center gap-1 text-2xs text-text-4 cursor-pointer select-none"
          title="Also show which other files a teammate's edit could touch"
        >
          <input
            type="checkbox"
            checked={radar.showRipples}
            onChange={(e) => radar.setShowRipples(e.target.checked)}
            className="w-3 h-3"
            style={{ accentColor: "var(--color-accent)" }}
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

// The collapsed state: the band's own title plus one plain line, and that's
// all. `shrink-0` with no flex-grow, so it costs a fixed ~46px and the file
// list above keeps everything else — an idle radar must never look like it's
// holding space hostage.
//
// The line does the explaining the old blank did not: "this project" says the
// feed is per-project, "in the last day" says it's a live window, and together
// they say the radar is working and simply has nothing to report — not that it
// disappeared. Same words, voice and treatment as ActivitySection's empty line;
// there is one empty-state style here, not two.
//
// Keeps the "+ zone" button, because claiming the files you're working in is
// exactly the thing you'd want to do BEFORE anyone else shows up — hiding it
// while the radar is quiet would put it behind the one condition that makes it
// useful. Pressing it opens the composer, which flips the band back to full.
function QuietRadarRow({ onClaimZone }: { onClaimZone: () => void }) {
  return (
    <div className="shrink-0 border-t border-line-soft">
      <div className="flex items-center gap-2 h-7 px-3 bg-bg-1/40">
        <span
          className="section-label"
          title="Shows who else is working in this project right now. The last day of activity, this project only."
        >
          Team Radar
        </span>
        <button
          type="button"
          onClick={onClaimZone}
          className="ml-auto h-5 px-1.5 rounded text-2xs text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
          title="Claim a zone. Announce (or lock) the files you're working in"
        >
          + zone
        </button>
      </div>
      <div className="px-3 pb-1.5 text-xs leading-snug text-text-4">
        Quiet. Nobody has touched this project in the last day.
      </div>
    </div>
  );
}
