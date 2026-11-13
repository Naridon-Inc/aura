// "Zones" — the ownership layer of the Team Radar (AURA-20). A zone is a
// soft claim over file patterns ("I'm working in src/auth/, heads up") that
// can harden into a block where the team opts in. Rules live as one JSON
// file each under .aura/sentinel/zones/, written by sentinel sessions, MCP
// agents, and now the desktop. This section lists active zones, lets the
// user claim new ones, flip warn ⇄ block, and release stale ones — all
// advisory-plane metadata, never code bytes.

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { api, type ZoneRule } from "../../../lib/api";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";
import { peekCache, writeCache } from "../../../lib/resourceCache";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ErrorNote } from "../../ui/state";
import { StatusChip } from "../../ui/statusChip";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";
import { CategorySection } from "../CategorySection";
import { agoFromTs, nameLooksLikeAgent } from "./radarFormat";
import { ActorMark } from "./ActorMark";
import "../../ui/details-pulls.css";
import "../../ui/zones.css";

const POLL_MS = 10000;

/** Cache the zone list per repo so the radar band's ownership layer repaints
 *  instantly on remount instead of cold-loading empty. Same resourceCache the
 *  radar feed uses. */
function zonesCacheKey(repoRoot: string): string {
  return `radar:zones:${repoRoot}`;
}
/** Desktop-claimed zones carry this session id (cmd_zones.rs stamps it);
 *  same constant Tabs.tsx uses to decide a zone is self-owned. */
const SELF_SESSION = "aura-shell";


/** Shared zone poll for the radar band. Lives here (not useTeamRadar) so
 *  the zone list refreshes immediately after claim/release mutations
 *  without waiting out the radar's own cadence. */
export function useZones(repoRoot: string, enabled: boolean) {
  const [zones, setZones] = useState<ZoneRule[]>(
    () => peekCache<ZoneRule[]>(zonesCacheKey(repoRoot)) ?? [],
  );
  const visible = useDocumentVisibility();
  const refresh = useCallback(async () => {
    if (!repoRoot || !enabled) return;
    // Stale-while-revalidate: seed already painted the cached list; fetch and
    // update, but a failed poll keeps the last-known zones rather than blanking.
    const key = zonesCacheKey(repoRoot);
    const cached = peekCache<ZoneRule[]>(key);
    if (cached) setZones(cached);
    try {
      const list = await api.zoneList(repoRoot);
      writeCache(key, list);
      setZones(list);
    } catch {
      if (!cached) setZones([]);
    }
  }, [repoRoot, enabled]);
  useEffect(() => {
    if (!repoRoot || !enabled) return;
    void refresh();
    if (!visible) return;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh, visible, repoRoot, enabled]);
  return { zones, refresh };
}

function isBlock(z: ZoneRule): boolean {
  return z.mode.toLowerCase() === "block";
}

function ownerLabel(z: ZoneRule): string {
  if (z.session_id === SELF_SESSION) return "you";
  return z.session_id.slice(0, 10) || z.zone_id.slice(0, 8);
}

type Props = {
  repoRoot: string;
  zones: ZoneRule[];
  refresh: () => Promise<void>;
  /** Claim composer visibility — owned by TeamRadarSection so its header
   *  "+ zone" button can open it even when the zone list is empty. */
  claimOpen: boolean;
  onCloseClaim: () => void;
  isOpen: boolean;
  onToggle: () => void;
};

export function ZonesSection({
  repoRoot,
  zones,
  refresh,
  claimOpen,
  onCloseClaim,
  isOpen,
  onToggle,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(id);
  }, [error]);

  const run = useCallback(
    async (op: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        await op();
        await refresh();
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // Soft-claim → hard-lock (and back): re-claim the same patterns under the
  // new mode, then release the old rule. Claim-first keeps the patterns
  // covered for the whole transition.
  const changeMode = useCallback(
    (z: ZoneRule, mode: "warn" | "block") =>
      run(async () => {
        await api.zoneClaim(repoRoot, z.patterns, mode, z.label ?? undefined);
        await api.zoneRelease(repoRoot, z.zone_id);
      }),
    [repoRoot, run],
  );

  const release = useCallback(
    (z: ZoneRule) => run(() => api.zoneRelease(repoRoot, z.zone_id)),
    [repoRoot, run],
  );

  return (
    <>
      {claimOpen && (
        <ZoneClaimComposer
          busy={busy}
          onClaim={(patterns, mode, label) =>
            void run(() => api.zoneClaim(repoRoot, patterns, mode, label)).then(
              (ok) => {
                if (ok) onCloseClaim();
              },
            )
          }
          onCancel={onCloseClaim}
        />
      )}
      {error && <ErrorNote className="ui-zones-error">{error}</ErrorNote>}
      <CategorySection
        title="Zones"
        count={zones.length}
        isOpen={isOpen}
        onToggle={onToggle}
      >
        {zones.map((z) => {
          const block = isBlock(z);
          const mine = z.session_id === SELF_SESSION;
          return (
            // The details panel's two-line row: what is claimed and how hard
            // on the first line, who and why under it. Warn reads in the
            // "likely" amber and block in the "direct" red, so severity
            // reads the same across collisions and zones.
            <div
              key={z.zone_id}
              className="ui-details-pull ui-zone-row"
              title={`${z.zone_id} · claimed by ${
                mine ? "this desktop" : z.session_id
              }\n${z.patterns.join("\n")}`}
            >
              <div>
                <ActorMark
                  actor={z.session_id}
                  isAgent={nameLooksLikeAgent(z.session_id)}
                  size={16}
                />
                <span className="ui-details-pull-title ui-zone-patterns">
                  {z.patterns.join(", ")}
                </span>
                <StatusChip tone={block ? "red" : "amber"} dense>
                  {block ? "locked" : "announced"}
                </StatusChip>
              </div>
              <div className="ui-details-pull-meta ui-zone-meta">
                <span>
                  {ownerLabel(z)}
                  {z.label ? ` · ${z.label}` : ""}
                  {z.mtime > 0 ? ` · ${agoFromTs(z.mtime * 1000)}` : ""}
                </span>
              </div>
              <span className="ui-zone-actions">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => changeMode(z, block ? "warn" : "block")}
                  title={
                    block
                      ? "Unlock. Back to announced; colliding edits get flagged, not rejected"
                      : "Lock. Colliding edits are actively rejected"
                  }
                >
                  {block ? "unlock" : "lock"}
                </Button>
                <Button
                  variant="ghost"
                  size="iconXs"
                  disabled={busy}
                  onClick={() => release(z)}
                  aria-label="Release zone"
                  title={`Release zone${mine ? "" : ` (claimed by ${z.session_id})`}`}
                >
                  <X />
                </Button>
              </span>
            </div>
          );
        })}
      </CategorySection>
    </>
  );
}

function ZoneClaimComposer({
  busy,
  onClaim,
  onCancel,
}: {
  busy: boolean;
  onClaim: (
    patterns: string[],
    mode: "warn" | "block",
    label?: string,
  ) => void;
  onCancel: () => void;
}) {
  const [patterns, setPatterns] = useState("");
  const [mode, setMode] = useState<"warn" | "block">("warn");
  const [label, setLabel] = useState("");

  const parsed = patterns
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const submit = () => {
    if (parsed.length === 0 || busy) return;
    onClaim(parsed, mode, label.trim() || undefined);
  };

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="ui-zones-claim">
      <Input
        size="small"
        value={patterns}
        onChange={(e) => setPatterns(e.target.value)}
        onKeyDown={keys}
        placeholder="src/auth/, src/middleware/auth.ts"
        aria-label="Files or folders to claim, comma-separated"
        autoFocus
        className="ui-zones-claim-patterns"
      />
      <Input
        size="small"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={keys}
        placeholder="why (optional). Auth refactor"
        aria-label="Why you're claiming them"
      />
      <div className="ui-zones-claim-bar">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          aria-label="How hard the claim is"
          value={mode}
          onValueChange={(v) => {
            if (v === "warn" || v === "block") setMode(v);
          }}
        >
          <ToggleGroupItem
            value="warn"
            title="Announce. A heads-up; colliding edits get flagged"
          >
            announced
          </ToggleGroupItem>
          <ToggleGroupItem
            value="block"
            data-tone="block"
            title="Lock. Colliding edits are rejected"
          >
            locked
          </ToggleGroupItem>
        </ToggleGroup>
        <Button
          size="xs"
          onClick={submit}
          disabled={parsed.length === 0 || busy}
          className="ui-zones-claim-submit"
        >
          Claim
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
