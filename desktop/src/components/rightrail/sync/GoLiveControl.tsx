// The Go Live band that sits directly under the Source Control header.
// One switch is the whole git-alternative entry point: flip it on and the
// working tree syncs with the team (whole-file CRDT, M1) instead of going
// through git push. Arctic accent marks it as the primary affordance;
// teal is status-only (the synced dot), per the app color rules.

import { Switch } from "../../ui/switch";
import { agoShort, initials, peerColor } from "./syncFormat";
import type { LivePeer } from "./useLiveSync";

type Props = {
  live: boolean;
  busy: boolean;
  startedAt: number | null;
  peers: LivePeer[];
  /** Why teammates can't appear (not signed in / no GitHub remote /
   *  cloud unreachable) — replaces the eternal "waiting for peers…". */
  presenceHint: string | null;
  onToggle: (next: boolean) => void;
};

export function GoLiveControl({
  live,
  busy,
  startedAt,
  peers,
  presenceHint,
  onToggle,
}: Props) {
  const activePeers = peers.filter((p) => !p.stale);
  return (
    <div className="shrink-0 border-b border-line-soft px-3 py-2.5">
      <div
        className={`rounded-lg border px-3 py-2.5 transition-colors ${
          live
            ? "border-accent/40 bg-accent-soft/50"
            : "border-line-soft bg-bg-0/40"
        }`}
      >
        <div className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <div
              className={`text-[12.5px] font-semibold leading-tight ${
                live ? "text-accent" : "text-text-1"
              }`}
            >
              {live ? "Live" : "Go Live"}
            </div>
            <div className="text-[10.5px] text-text-3 truncate leading-tight mt-0.5">
              {live
                ? "Tree syncing with the team"
                : "Sync this tree with the team — no git push"}
            </div>
          </div>
          <Switch
            checked={live}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={live ? "Stop live sync" : "Go live"}
          />
        </div>

        {live && (
          <div className="mt-2.5 flex items-center gap-2">
            {activePeers.length > 0 ? (
              <div className="flex items-center min-w-0">
                {activePeers.slice(0, 4).map((p, i) => (
                  <span
                    key={p.sessionId}
                    className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-[8px] font-bold text-bg-0 ring-2 ring-bg-1 shrink-0"
                    style={{
                      background: peerColor(p.sessionId),
                      marginLeft: i === 0 ? 0 : -6,
                    }}
                    title={p.branch ? `${p.agentId} on ${p.branch}` : p.agentId}
                  >
                    {initials(p.agentId)}
                  </span>
                ))}
                <span className="ml-2 text-[10.5px] text-text-3 truncate">
                  {activePeers.length} live
                </span>
              </div>
            ) : (
              <span
                className="text-[10.5px] text-text-4 truncate"
                title={presenceHint ?? undefined}
              >
                {presenceHint ?? "waiting for peers…"}
              </span>
            )}
            <span
              className="ml-auto flex items-center gap-1.5 text-[10.5px] text-accent-green shrink-0"
              title={`live ${agoShort(startedAt)}`}
            >
              <span className="h-[7px] w-[7px] rounded-full bg-accent-green shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent-green)_18%,transparent)]" />
              syncing
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
