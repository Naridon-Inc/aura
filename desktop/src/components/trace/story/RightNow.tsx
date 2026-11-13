// Right now: who is working on this project this minute, and on what. Agents
// holding a live claim (a heartbeat inside the last minute) and teammates who
// set a status. Recent finished work is not repeated here: it is the first
// moment under Today.

import { useEffect, useMemo, useState } from "react";
import { api, type SentinelAgent, type TeamMember } from "../../../lib/api";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";
import { peekCache, writeCache } from "../../../lib/resourceCache";
import { TraceMark } from "../../ui/trace-list";
import { TraceStoryDay } from "../../ui/trace-story";
import { TraceTimeline, TraceTimelineEntry } from "../../ui/trace-timeline";
import { providerLabel } from "../../workpanes/usageProviders";
import { MomentFacts } from "./SessionMoment";

const HEARTBEAT_WINDOW_S = 60;
const POLL_MS = 6000;
/** The desktop app's own sentinel session: it is the reader, not a worker. */
const DESKTOP_SESSION = "desktop";

export type NowLine = { key: string; title: string; who: string; status: boolean };

function shortFile(path: string): string {
  const parts = (path ?? "").replace(/[/\\]+$/, "").split(/[/\\]+/);
  return parts[parts.length - 1] || path;
}

/** Live claims, polled while the window is visible and cached per project so
 *  a reopened Overview paints the last-known line at once. Stale heartbeats
 *  are dropped below, so a warm cache never shows anyone as falsely live. */
function useLiveAgents(repoRoot: string) {
  const key = `teamActivity:agents:${repoRoot}`;
  const [agents, setAgents] = useState<SentinelAgent[]>(() => peekCache<SentinelAgent[]>(key) ?? []);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  const visible = useDocumentVisibility();

  useEffect(() => {
    if (!repoRoot) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    async function tick() {
      try {
        const list = await api.sentinelAgents(repoRoot);
        if (!cancelled) {
          writeCache(key, list);
          setAgents(list);
        }
      } catch {
        if (!cancelled && !peekCache<SentinelAgent[]>(key)) setAgents([]);
      }
      if (!cancelled) setNowS(Math.floor(Date.now() / 1000));
    }
    void tick();
    if (!visible) return () => void (cancelled = true);
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, key, visible]);

  return { agents, nowS };
}

export function nowLines(agents: SentinelAgent[], roster: TeamMember[], nowS: number): NowLine[] {
  const live = new Map<string, SentinelAgent>();
  for (const a of agents) {
    if (a.session_id === DESKTOP_SESSION) continue;
    if (nowS - a.last_heartbeat > HEARTBEAT_WINDOW_S) continue;
    const k = (a.agent_id || a.session_id).toLowerCase();
    const prev = live.get(k);
    if (!prev || a.last_heartbeat > prev.last_heartbeat) live.set(k, a);
  }
  const lines: NowLine[] = [...live.entries()].map(([k, a]) => {
    const name = providerLabel(a.agent_id || "agent");
    const claim = [...a.claims].sort((x, y) => y.claimed_at - x.claimed_at)[0];
    const what = claim?.file_path
      ? `${name} is changing ${shortFile(claim.file_path)}`
      : `${name} is working`;
    return { key: `live:${k}`, title: what, who: "", status: false };
  });
  for (const m of roster) {
    const text = (m.activity_text ?? "").trim();
    const emoji = (m.status_emoji ?? "").trim();
    if (!text && !emoji) continue;
    lines.push({
      key: `hum:${m.handle || m.email}`,
      title: [emoji, text].filter(Boolean).join(" "),
      who: m.name || m.handle || m.email,
      status: true,
    });
  }
  return lines;
}

export function useRightNow(repoRoot: string, roster: TeamMember[]) {
  const { agents, nowS } = useLiveAgents(repoRoot);
  return useMemo(() => nowLines(agents, roster, nowS), [agents, roster, nowS]);
}

export function RightNowDay({ lines }: { lines: NowLine[] }) {
  if (lines.length === 0) return null;
  return (
    <TraceStoryDay label="Right now">
      <TraceTimeline label="Right now">
        {lines.map((l) => (
          <TraceTimelineEntry
            key={l.key}
            title={l.title}
            detail={
              <MomentFacts
                facts={[
                  l.status ? "Status" : <TraceMark tone="good">Working now</TraceMark>,
                  l.who,
                ]}
              />
            }
          />
        ))}
      </TraceTimeline>
    </TraceStoryDay>
  );
}
