// Polls sentinel-agent claims and resolves them to gutter pips for the
// currently-open file. Sentinel exposes function-name claims (not raw
// cursor positions) so we approximate by searching the buffer for the
// function declaration. Best-effort: if the buffer doesn't contain the
// function name we just skip the claim.
//
// Heartbeat gate (HEARTBEAT_WINDOW_S): a sentinel agent that hasn't
// pinged in >60s is treated as gone — its claim still sits in the file
// but rendering a pip for an absent teammate is misleading.

import { useEffect, useMemo, useState } from "react";
import { api, type SentinelAgent } from "./api";
import { useDocumentVisibility } from "./useDocumentVisibility";
import { presenceForFile, useRadarPresence } from "./radarPresenceStore";
import type { PresenceMarker } from "../components/MonacoEditor";

const HEARTBEAT_WINDOW_S = 60;
const POLL_MS = 6000;
// Stable accent palette — picked to read well against both bg-1/bg-2 in
// the dark theme and the light theme. Per-session hash maps each agent
// to one color.
const PRESENCE_PALETTE = [
  "#7dd3fc", // sky-300
  "#fcd34d", // amber-300
  "#86efac", // emerald-300
  "#f9a8d4", // pink-300
  "#c4b5fd", // violet-300
  "#fdba74", // orange-300
];

const DESKTOP_SESSION = "desktop";

function colorFor(sessionId: string): string {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) {
    h = (h * 31 + sessionId.charCodeAt(i)) | 0;
  }
  return PRESENCE_PALETTE[Math.abs(h) % PRESENCE_PALETTE.length];
}

// Find the 1-based line where a function appears in the buffer. The
// claim only carries a name so we can't be exact — we look for a few
// common declaration forms across TS/JS/Python/Rust and fall back to
// the first plain occurrence. Returns null if nothing matched.
function findFunctionLine(buffer: string, name: string): number | null {
  if (!name) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\bfn\\s+${escaped}\\b`),                 // rust
    new RegExp(`\\bfunction\\s+${escaped}\\b`),           // js/ts
    new RegExp(`\\bdef\\s+${escaped}\\b`),                // python
    new RegExp(`\\bclass\\s+${escaped}\\b`),              // class
    new RegExp(`\\bconst\\s+${escaped}\\s*=`),            // const fn
    new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*\\(`),                   // bare call site fallback
  ];
  const lines = buffer.split("\n");
  for (const re of patterns) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i + 1;
    }
  }
  return null;
}

// Repo-relative or absolute claim path → does it match the editor's
// current absolute file path? We accept either form because sentinel
// writers in the wild use both.
function pathMatches(claimPath: string, openPath: string, repoRoot: string): boolean {
  if (!claimPath || !openPath) return false;
  if (claimPath === openPath) return true;
  const rel = openPath.startsWith(repoRoot + "/")
    ? openPath.slice(repoRoot.length + 1)
    : openPath;
  return claimPath === rel || claimPath.endsWith("/" + rel);
}

export function useTeammatePresence(
  repoRoot: string,
  filePath: string | null,
  buffer: string,
): PresenceMarker[] {
  const [agents, setAgents] = useState<SentinelAgent[]>([]);
  const visible = useDocumentVisibility();
  // AURA-19 — Team Radar awareness events join sentinel claims as a second
  // presence source: a peer's `editing <symbol>` event becomes a gutter pip
  // on that symbol's declaration line, same best-effort line resolution.
  const radarEntries = useRadarPresence(repoRoot);

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    async function tick() {
      try {
        const list = await api.sentinelAgents(repoRoot);
        if (!cancelled) setAgents(list);
      } catch {
        if (!cancelled) setAgents([]);
      }
    }
    tick();
    if (!visible) return;
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible]);

  return useMemo(() => {
    if (!filePath) return [];
    const now = Date.now() / 1000;
    const out: PresenceMarker[] = [];
    const seen = new Set<string>();
    const push = (m: PresenceMarker) => {
      const key = `${m.line}:${m.label}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(m);
    };
    for (const agent of agents) {
      if (agent.session_id === DESKTOP_SESSION) continue;
      if (now - agent.last_heartbeat > HEARTBEAT_WINDOW_S) continue;
      const color = colorFor(agent.session_id);
      for (const claim of agent.claims) {
        if (!pathMatches(claim.file_path, filePath, repoRoot)) continue;
        const line = findFunctionLine(buffer, claim.function_name);
        if (line == null) continue;
        push({
          line,
          color,
          label: `${agent.agent_id || "agent"} · ${claim.function_name}`,
        });
      }
    }
    // Radar awareness layer — symbol-bearing events from peers on this file.
    // Self-exclusion already happened in the store; entries without a symbol
    // carry no line information so they stay tab-pip-only.
    for (const entry of presenceForFile(radarEntries, repoRoot, filePath)) {
      if (!entry.symbol) continue;
      const line = findFunctionLine(buffer, entry.symbol);
      if (line == null) continue;
      push({
        line,
        color: entry.color,
        label: `${entry.actor} · ${entry.kind === "intent" ? "intends" : "editing"} ${entry.symbol}`,
      });
    }
    return out;
  }, [agents, radarEntries, filePath, buffer, repoRoot]);
}
