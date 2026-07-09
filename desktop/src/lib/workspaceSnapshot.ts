// Per-workspace tab snapshot.
//
// One persisted blob per workspace under `aura.workspaceSnapshot.<root>`.
// Carries the full tab state for that workspace: file paths, agent /
// terminal / manager tabs, plan + PR tabs, splitLayout, and the active
// focus markers. Switching workspaces serializes the outgoing state
// into its slot, then reads the incoming workspace's slot back.
//
// Honest about what's NOT persisted here:
//   • File buffer contents (dirty edits). We persist paths and let
//     `openFile` re-read from disk. Users who want to keep dirty work
//     across switches must save first — standard editor behavior.
//   • Live PTY children. Persisting the `sessionId` / `termId` is just
//     a placeholder — the PTY child died on shell exit, and the UI
//     re-spawns a fresh one on activation.
//   • Singleton pane internal state (Plan Builder wizard step, Prove
//     pane goal text). Those panes own their own localStorage slots.
//
// Schema is versioned via a `v` field. Mismatch on load = treat as
// no snapshot (the user's tabs come back empty rather than corrupt).

import type {
  AgentTab,
  ManagerTab,
  PlanTabData,
  PrTab,
  TerminalGroup,
  TerminalTab,
  WorkSplitTree,
} from "./editorStore";

const SCHEMA_VERSION = 1;

export type WorkspaceSnapshot = {
  v: number;
  /** File paths only — buffer contents come from disk on rehydrate. */
  filePaths: string[];
  agentTabs: AgentTab[];
  terminalTabs: TerminalTab[];
  managerTabs: ManagerTab[];
  planTabs: PlanTabData[];
  prTabs: PrTab[];
  splitLayout: WorkSplitTree | null;
  /** Bottom Terminal Panel side-list — one entry per VS Code "terminal
   *  group" (own split tree). Optional + defaulted on read so snapshots
   *  written before the groups model (which only had `terminalTabs` +
   *  the old single `terminalPanelLayout`) still load — `switchWorkspace`
   *  migrates them to one solo group per terminal tab. */
  terminalGroups?: TerminalGroup[];
  /** Which side-list group is shown in the panel body. */
  panelActiveGroupId?: string | null;
  /** The panel's OWN focused terminal (independent of `activeTermId`). */
  panelActiveTermId?: string | null;
  /** Whether the bottom Terminal Panel is open (persisted + per-workspace). */
  terminalPanelOpen?: boolean;
  activePath: string | null;
  activeAgentId: string | null;
  activeTermId: string | null;
  activeManagerId: string | null;
  activePlanId: string | null;
  activePrTabId: string | null;
  inspectorOpen: boolean;
  activeInspector: boolean;
  replayOpen: boolean;
  activeReplay: boolean;
  planBuilderOpen: boolean;
  activePlanBuilder: boolean;
  proveOpen: boolean;
  activeProve: boolean;
  graphOpen: boolean;
  activeGraph: boolean;
  inboxOpen: boolean;
  activeInbox: boolean;
  activeDashboard: boolean;
  /** Trace v2 Sessions surface (gated by `TRACE_V2`). Persisted like the
   *  other singleton actives; coerced back to false on restore when the
   *  flag is off so a stale snapshot can't re-mount the pane. */
  activeSessions: boolean;
};

export function emptySnapshot(): WorkspaceSnapshot {
  return {
    v: SCHEMA_VERSION,
    filePaths: [],
    agentTabs: [],
    terminalTabs: [],
    managerTabs: [],
    planTabs: [],
    prTabs: [],
    splitLayout: null,
    terminalGroups: [],
    panelActiveGroupId: null,
    panelActiveTermId: null,
    terminalPanelOpen: false,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activePlanId: null,
    activePrTabId: null,
    inspectorOpen: false,
    activeInspector: false,
    replayOpen: false,
    activeReplay: false,
    planBuilderOpen: false,
    activePlanBuilder: false,
    proveOpen: false,
    activeProve: false,
    graphOpen: false,
    activeGraph: false,
    inboxOpen: false,
    activeInbox: false,
    activeDashboard: false,
    activeSessions: false,
  };
}

function keyFor(repoRoot: string): string {
  return `aura.workspaceSnapshot.${repoRoot}`;
}

// Sentinel slot for the "clubbed" pseudo-workspace. Tabs accumulated
// while the user is viewing the club land here and stay separate from
// the member workspaces' own slots — leaving the club restores each
// member exactly as it was before clubbing.
export const CLUB_SLOT_KEY = "aura.workspaceSnapshot.__club__";

export function loadClubSnapshot(): WorkspaceSnapshot | null {
  try {
    const raw = localStorage.getItem(CLUB_SLOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceSnapshot;
    if (parsed?.v !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveClubSnapshot(snap: WorkspaceSnapshot): void {
  try {
    localStorage.setItem(CLUB_SLOT_KEY, JSON.stringify(snap));
  } catch {
    /* quota — ignore */
  }
}

export function removeClubSnapshot(): void {
  try {
    localStorage.removeItem(CLUB_SLOT_KEY);
  } catch {
    /* ignore */
  }
}

/** Union N workspace snapshots into one. Used to seed the club slot
 *  the first time the user enters a club — gives them every tab from
 *  every member visible in one strip. Dedupes by stable id (file path
 *  / agent sessionId / terminal termId / manager sessionId / plan id /
 *  pr tabId). Active markers from the FIRST member win. */
export function unionSnapshots(parts: WorkspaceSnapshot[]): WorkspaceSnapshot {
  if (parts.length === 0) return emptySnapshot();
  const seed = parts[0]!;
  const out = emptySnapshot();
  const seenFile = new Set<string>();
  const seenAgent = new Set<string>();
  const seenTerm = new Set<string>();
  const seenMgr = new Set<string>();
  const seenPlan = new Set<string>();
  const seenPr = new Set<string>();
  for (const p of parts) {
    for (const path of p.filePaths) {
      if (seenFile.has(path)) continue;
      seenFile.add(path);
      out.filePaths.push(path);
    }
    for (const a of p.agentTabs) {
      if (seenAgent.has(a.sessionId)) continue;
      seenAgent.add(a.sessionId);
      out.agentTabs.push(a);
    }
    for (const t of p.terminalTabs) {
      if (seenTerm.has(t.termId)) continue;
      seenTerm.add(t.termId);
      out.terminalTabs.push(t);
    }
    for (const m of p.managerTabs) {
      if (seenMgr.has(m.sessionId)) continue;
      seenMgr.add(m.sessionId);
      out.managerTabs.push(m);
    }
    for (const pl of p.planTabs) {
      if (seenPlan.has(pl.id)) continue;
      seenPlan.add(pl.id);
      out.planTabs.push(pl);
    }
    for (const pr of p.prTabs) {
      if (seenPr.has(pr.tabId)) continue;
      seenPr.add(pr.tabId);
      out.prTabs.push(pr);
    }
  }
  out.activePath = seed.activePath;
  out.activeAgentId = seed.activeAgentId;
  out.activeTermId = seed.activeTermId;
  out.activeManagerId = seed.activeManagerId;
  out.activePlanId = seed.activePlanId;
  out.activePrTabId = seed.activePrTabId;
  out.splitLayout = seed.splitLayout;
  out.terminalGroups = seed.terminalGroups;
  out.panelActiveGroupId = seed.panelActiveGroupId;
  out.panelActiveTermId = seed.panelActiveTermId;
  out.terminalPanelOpen = seed.terminalPanelOpen;
  out.inspectorOpen = seed.inspectorOpen;
  out.activeInspector = seed.activeInspector;
  out.replayOpen = seed.replayOpen;
  out.activeReplay = seed.activeReplay;
  out.planBuilderOpen = seed.planBuilderOpen;
  out.activePlanBuilder = seed.activePlanBuilder;
  out.proveOpen = seed.proveOpen;
  out.activeProve = seed.activeProve;
  out.graphOpen = seed.graphOpen;
  out.activeGraph = seed.activeGraph;
  out.inboxOpen = seed.inboxOpen;
  out.activeInbox = seed.activeInbox;
  out.activeDashboard = seed.activeDashboard;
  out.activeSessions = seed.activeSessions;
  return out;
}

export function loadSnapshot(repoRoot: string): WorkspaceSnapshot | null {
  try {
    const raw = localStorage.getItem(keyFor(repoRoot));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceSnapshot;
    if (parsed?.v !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSnapshot(repoRoot: string, snap: WorkspaceSnapshot): void {
  try {
    localStorage.setItem(keyFor(repoRoot), JSON.stringify(snap));
  } catch {
    // Quota — workspace switch keeps working in-memory; next switch
    // will retry the write. Acceptable.
  }
}

export function removeSnapshot(repoRoot: string): void {
  try {
    localStorage.removeItem(keyFor(repoRoot));
  } catch {
    /* ignore */
  }
}
