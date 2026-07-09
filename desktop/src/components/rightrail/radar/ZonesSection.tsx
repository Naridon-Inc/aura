// "Zones" — the ownership layer of the Team Radar (AURA-20). A zone is a
// soft claim over file patterns ("I'm working in src/auth/, heads up") that
// can harden into a block where the team opts in. Rules live as one JSON
// file each under .aura/sentinel/zones/, written by sentinel sessions, MCP
// agents, and now the desktop. This section lists active zones, lets the
// user claim new ones, flip warn ⇄ block, and release stale ones — all
// advisory-plane metadata, never code bytes.

import { useCallback, useEffect, useState } from "react";
import { api, type ZoneRule } from "../../../lib/api";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";
import { Input } from "../../ui/input";
import { CategorySection } from "../CategorySection";
import { agoFromTs } from "./radarFormat";

const POLL_MS = 10000;
/** Desktop-claimed zones carry this session id (cmd_zones.rs stamps it);
 *  same constant Tabs.tsx uses to decide a zone is self-owned. */
const SELF_SESSION = "aura-shell";

// Status hues only — warn shares the "likely" amber, block the "direct"
// red, so severity reads identically across collisions and zones.
const WARN_COLOR = "#e0a96d";
const BLOCK_COLOR = "#e5484d";

/** Shared zone poll for the radar band. Lives here (not useTeamRadar) so
 *  the zone list refreshes immediately after claim/release mutations
 *  without waiting out the radar's own cadence. */
export function useZones(repoRoot: string, enabled: boolean) {
  const [zones, setZones] = useState<ZoneRule[]>([]);
  const visible = useDocumentVisibility();
  const refresh = useCallback(async () => {
    if (!repoRoot || !enabled) return;
    try {
      setZones(await api.zoneList(repoRoot));
    } catch {
      setZones([]);
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
      {error && (
        <div className="px-3 py-1 text-[10.5px] bg-red/10 text-red border-b border-line-soft">
          {error}
        </div>
      )}
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
            <div
              key={z.zone_id}
              className="group/zone w-full flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-bg-2/60 transition-colors min-w-0"
              title={`${z.zone_id} · claimed by ${
                mine ? "this desktop" : z.session_id
              }\n${z.patterns.join("\n")}`}
            >
              <span
                className="shrink-0 w-1.5 h-1.5 rounded-full"
                style={{ background: block ? BLOCK_COLOR : WARN_COLOR }}
                aria-hidden
              />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[11px] text-text-1 font-mono truncate">
                    {z.patterns.join(", ")}
                  </span>
                  <span
                    className="shrink-0 text-[9px] font-medium uppercase tracking-wider px-1 rounded"
                    style={{
                      color: block ? BLOCK_COLOR : WARN_COLOR,
                      background: `color-mix(in oklab, ${
                        block ? BLOCK_COLOR : WARN_COLOR
                      } 14%, transparent)`,
                    }}
                  >
                    {block ? "block" : "warn"}
                  </span>
                </span>
                <span className="block text-[10px] text-text-4 truncate">
                  {ownerLabel(z)}
                  {z.label ? ` · ${z.label}` : ""}
                  {z.mtime > 0 ? ` · ${agoFromTs(z.mtime * 1000)}` : ""}
                </span>
              </span>
              <span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover/zone:opacity-100 transition-opacity">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => changeMode(z, block ? "warn" : "block")}
                  className="h-5 px-1.5 rounded text-[9.5px] text-text-3 hover:text-text-1 hover:bg-bg-hover disabled:opacity-50 transition-colors"
                  title={
                    block
                      ? "Soften to warn — colliding edits get flagged, not rejected"
                      : "Harden to block — colliding edits are actively rejected"
                  }
                >
                  {block ? "soften" : "harden"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => release(z)}
                  className="w-5 h-5 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover disabled:opacity-50"
                  title={`Release zone${mine ? "" : ` (claimed by ${z.session_id})`}`}
                >
                  ×
                </button>
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

  return (
    <div className="px-3 py-2 border-b border-line-soft flex flex-col gap-1.5 bg-bg-1/30">
      <Input
        value={patterns}
        onChange={(e) => setPatterns(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="src/auth/, src/middleware/auth.ts"
        autoFocus
        className="h-6 text-[11px] font-mono"
      />
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="why (optional) — auth refactor"
        className="h-6 text-[11px]"
      />
      <div className="flex items-center gap-1.5">
        <div className="flex items-center rounded border border-line-soft overflow-hidden">
          <button
            type="button"
            onClick={() => setMode("warn")}
            className={`h-5 px-2 text-[9.5px] uppercase tracking-wider transition-colors ${
              mode === "warn"
                ? "bg-bg-2 text-text-1 font-medium"
                : "text-text-4 hover:text-text-2"
            }`}
            title="Soft claim — colliding edits get a warning"
          >
            warn
          </button>
          <button
            type="button"
            onClick={() => setMode("block")}
            className={`h-5 px-2 text-[9.5px] uppercase tracking-wider transition-colors ${
              mode === "block"
                ? "bg-bg-2 font-medium"
                : "text-text-4 hover:text-text-2"
            }`}
            style={mode === "block" ? { color: BLOCK_COLOR } : undefined}
            title="Hard lock — colliding edits are rejected"
          >
            block
          </button>
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={parsed.length === 0 || busy}
          className="ml-auto h-5 px-2 rounded bg-bg-2 hover:bg-bg-1 text-text-1 text-[10px] font-medium border border-line-soft disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Claim
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-5 px-2 rounded text-text-3 hover:text-text-1 text-[10px] transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
