// Tiny hook-based store for the editor surface. Keeps the open-tab list,
// per-tab dirty state, and the original-on-disk text we need for ⌘S
// round-tripping and for the side-by-side diff view. Intentionally not
// Zustand/Redux — we only have one consumer and the API is small enough
// that useSyncExternalStore via a private subscriber set is plenty.
//
// Three tab kinds live here side-by-side:
//   - Files: backed by disk, dirty-trackable, ⌘S-saveable.
//   - Agents: backed by an interactive PTY session — see cmd_agent_pty.
//     The store only tracks the session id + view-toggle state; the
//     stream itself lives in agentSessionStore.
//   - Terminals: independent xterm.js panes opened via "+ Terminal".
//     Each one mounts a fresh `pty_open` so closing the tab kills its
//     PTY cleanly. The bottom-pane Terminal is a separate singleton.

import { useEffect, useState } from "react";
import { api } from "./api";
import {
  AURA_MANAGER_ENABLED,
  CODE_MAP_ENABLED,
  COMMONS_ENABLED,
  TRACE_V2,
} from "./featureFlags";
import {
  releaseTerminalSession,
  releaseNativeTerminalSession,
} from "../components/Terminal";
import {
  loadSnapshot,
  saveSnapshot,
  loadClubSnapshot,
  saveClubSnapshot,
  unionSnapshots,
  type WorkspaceSnapshot,
} from "./workspaceSnapshot";

export type OpenFile = {
  path: string;
  name: string;
  language: string;
  /** Last content read from disk. The diff baseline. */
  baseline: string;
  /** Current buffer in the editor. Equals baseline when not dirty. */
  current: string;
  size: number;
  /** "ok" | "too_large" | "binary" — when non-ok, render a placeholder. */
  status: string;
  /** "edit" (default) or "diff" — initial view picked by the opener
   *  (e.g. the Git sidebar opens directly into diff). The work-surface
   *  reads this once on mount and lets the user toggle from there. */
  defaultView?: "edit" | "diff";
};

export type AgentTab = {
  /** Stable id for the tab. For PTY-mode tabs this is the PTY session
   *  id from agent_pty_open. For stream-mode tabs we synthesise it
   *  from "{agent_id}@{repo_root}" so reopening collapses onto the
   *  same conversation thread. */
  sessionId: string;
  agentId: string;
  agentLabel: string;
  agentMonogram: string;
  repoRoot: string;
  /** "ui" = chat-bubble blocks, "terminal" = raw xterm.js render. */
  view: "ui" | "terminal";
  /** "stream" = clean Cline/Continue-style bubble UI driven by
   *  `claude -p --output-format stream-json` (default for new tabs).
   *  "pty" = full interactive TUI in xterm.js — opt-in for users who
   *  want the agent's native REPL (slash commands, vim mode, etc).
   *  "chat" = HTTP chat-completions adapter (Ollama / HuggingFace /
   *  any OpenAI-compatible endpoint) — rendered as a streaming bubble
   *  view, no PTY. */
  mode: "stream" | "pty" | "chat";
  /** Set when the backend detects the agent is waiting on the user
   *  (BEL fired in PTY output, permission prompt, etc). Renders a red
   *  dot on the tab; cleared when the tab becomes active. */
  attention?: boolean;
  /** For `mode === "chat"`: the openai-compat profile name backing this
   *  tab. Persisted so re-opens reach for the same endpoint. */
  openaiCompatProfile?: string;
  /** Cold/click-to-start. Set when a tab is restored from a persisted
   *  workspace snapshot rather than opened live this session. A dormant
   *  tab whose PTY is dead renders a "Start agent" affordance instead of
   *  silently relaunching a Claude process at mount — restoring a
   *  workspace must never spawn agents the user didn't ask for. The flag
   *  only gates the *dead*-PTY auto-respawn: a PTY that's still alive
   *  (same-session switch-back) attaches normally and ignores it.
   *  Starting the agent clears the flag (replaceAgent omits it). */
  dormant?: boolean;
  /** The agent's OWN session id this tab is bound to — Claude's JSONL
   *  stem (a uuid), not our PTY `sessionId`. Pinned per-tab so a shell
   *  restart resumes the exact conversation THIS tab left, even when
   *  several Claude tabs share one repo. Without it the resume key was
   *  `agent@repo`, shared by every same-repo tab, so "Start all" reopened
   *  the newest session in all of them instead of each tab's own. */
  resumeSessionId?: string | null;
};

export type TerminalTab = {
  /** Stable id (`term-<uuid>`) chosen at open time. Doubles as the tab
   *  key for customization persistence. */
  termId: string;
  cwd: string;
  /** Optional shell command to send into the PTY once it's ready.
   *  Used by the Aura Manager tile so the terminal lands on
   *  `aura orchestrate` context instead of an empty prompt. The shell
   *  echoes the line as if the user typed it. */
  bootCommand?: string;
  /** Optional friendly label shown on the tab strip. Defaults to
   *  `Terminal N` when absent. */
  label?: string;
  /** Resolved shell binary for this tab (from the chosen terminal
   *  profile). Persisted so a restart re-spawns the same shell instead
   *  of the OS default. `undefined` → backend falls back to `$SHELL`. */
  shell?: string;
  /** Profile id the tab was opened with — drives the side-list icon and
   *  lets a restart re-resolve the same launch (env, args). */
  profileId?: string;
  /** Last daemon session id this tab was bound to (when the PTY daemon
   *  is hosting plain shells). On rehydrate the panel cross-references
   *  this against `ptyListAlivePlain()` — alive ⇒ live reconnect, dead
   *  ⇒ cold scrollback replay. Set by the Terminal component after
   *  `pty_open` returns. */
  daemonSessionId?: string;
};

/** One row in the terminal panel's side-list — VS Code's "terminal group".
 *  A group owns its OWN split tree, so multiple independent split groups
 *  coexist: adding a new terminal mints a fresh group and never disturbs
 *  an existing split, and splitting only re-tiles the active group. A
 *  single-pane group is a leaf holding one `terminal` ref; a split group
 *  is a `split` node with 2+ panes. The canonical per-terminal data still
 *  lives in `terminalTabs` keyed by `termId`; the group only arranges
 *  which terminals tile together. */
export type TerminalGroup = {
  /** Stable id (`tgrp-<uuid>`). Survives reorders + reload. */
  groupId: string;
  /** This group's split tree. Leaves are always `terminal` refs. */
  layout: WorkSplitTree;
  /** The focused pane within this group (a `termId` present in `layout`). */
  activeTermId: string;
};

export type WorkPaneRef =
  | { kind: "agent"; id: string }
  | { kind: "terminal"; id: string }
  /** Manager session — top-level, cross-workspace. Same id format as
   *  ManagerTab.sessionId so the split's resolution path can re-use
   *  the existing managerTabs array. */
  | { kind: "manager"; id: string }
  /** A live editor pane on a file tab. The pane mirrors the OpenFile
   *  buffer (same `current`/`baseline`/`status`) so edits round-trip
   *  through the canonical `editorStore.files` list — split panes are
   *  views, not copies. */
  | { kind: "file"; path: string }
  /** Empty pane created by Split. Renders the EmptyPanePicker so the
   *  user can drop in any open agent/terminal/file/manager (across
   *  workspaces) or spawn a new one. The id is a generated nonce so
   *  multiple empty panes can coexist. */
  | { kind: "empty"; id: string }
  /** Plan tab — opens an Aura Manager `PendingPlan` as a full work
   *  surface (markdown body + ☐ todos). The id matches PendingPlan.id
   *  so the same plan only opens once across the layout. Plans are
   *  session-only (stripped from persisted layout, like terminals)
   *  because they live on the originating ManagerSession. */
  | { kind: "plan"; id: string }
  /** Tasks board as a full workpane tab. id is the repo root so one
   *  tab per repo (re-opening just re-focuses). Body renders TasksBoard
   *  embedded (no inset-0 overlay). */
  | { kind: "tasks"; id: string }
  /** Single-task detail as a full workpane tab — Plane-style with the
   *  breadcrumb header, wide description/activity column on the left
   *  and metadata cards on the right. `id` is the task id (one tab
   *  per task); `repoRoot` is carried alongside so the tab can survive
   *  workspace switches and re-hydrate its fetches without leaning on
   *  the active project.root. */
  | { kind: "task"; id: string; repoRoot: string }
  /** Standup view as a workpane tab. id is the repo root. Body shows
   *  the per-member daily rollup from intent_log.jsonl + Tasks state.
   *  Scaffolded in V.1; data wiring + summarizer land in U.1. */
  | { kind: "standup"; id: string }
  /** Active huddle screenshare as a workpane tab. id is the
   *  composite huddle key (`<repoRoot>::<channel>`) so re-sharing
   *  inside the same huddle re-uses the existing tab. Body renders
   *  the LiveKit screen track attached to a full-area <video>.
   *  Session-only — the layout persister strips this kind on save
   *  (a re-loaded shell has no live SFU track to show). */
  | { kind: "screenshare"; id: string }
  /** Pages (notes/wiki) as a workpane tab — RR.3. id is the repo
   *  root so one tab per repo (re-opening re-focuses). Body renders
   *  NotesWorkpane in `embedded` mode (no modal overlay, no internal
   *  × — the tab strip carries the close affordance). */
  | { kind: "pages"; id: string }
  /** Automations — orchestration runs + saved launch presets, as a
   *  workpane tab. id is the repo root (one tab per repo, same shape as
   *  openTasks/openStandup). Body renders AutomationsSurface. */
  | { kind: "automations"; id: string }
  /** Team chat in the wide center pane — id is the repo root (one tab
   *  per repo). Body renders the full CommsPanel (channel rail + message
   *  stream + members), which only breathes at center width. The ADE
   *  Team sidebar section collapses to a slim launcher while this is
   *  open so there's a single CommsPanel instance (one WS, one poller). */
  | { kind: "channels"; id: string }
  /** Commons — the shared social/plugin surface in the wide center pane.
   *  id is the repo root (one tab per repo). Body renders CommonsSurface
   *  (Lounge presence + ship log, and the Plugin Exchange), which only
   *  breathes at center width — the reason it's a first-class destination
   *  rather than a width-gated tab in the Team ContextPanel. */
  | { kind: "commons"; id: string }
  /** A full-surface plugin mini-app (Gmail/Gemini/Reddit-style client).
   *  `id` is the `<pluginId>:<appId>` key; the body renders the app's
   *  HTML in a sandboxed full-bleed iframe (PluginSandboxFrame). Opened
   *  from the Commons "Apps" launcher; this is where "people do things". */
  | { kind: "app"; id: string }
  /** Trace verify/insight tool as a workpane tab — Review / Rewind /
   *  Attestations / Doctor / Memory (was a mutually-exclusive singleton
   *  flag, `traceTool`). Living in the leaf lets it sit in the unified
   *  strip beside the agent/Tasks/Pages tabs instead of swapping the
   *  whole surface out and hiding them. `id` is the tool name so one tab
   *  per tool (re-opening re-focuses); `tool` selects the rendered body;
   *  `arg` carries Rewind's symbol/file prefill. Persisted across reload
   *  (#222): each tool re-queries live state on mount, so a restored tab
   *  is as fresh as a freshly-opened one. */
  | {
      kind: "trace";
      id: string;
      tool: TraceToolKind;
      arg?: { identifier?: string; file?: string };
    }
  /** Trace v2 surface as a workpane tab (was the mutually-exclusive
   *  `activeSessions` singleton). Living in the leaf lets it sit beside the
   *  agent/Tasks/trace tabs instead of taking over the whole center and
   *  hiding them. `id` encodes the view as `sessions:<view>` so each Trace
   *  view (Overview / My sessions / Team activity / Cost & usage) is its
   *  OWN openable tab — see `sessionsTabId`/`sessionsViewFromId`. The flat
   *  `traceView` mirror tracks whichever sessions tab is focused (restored
   *  from the ref id) so the Trace rail can highlight the active row.
   *  Persisted across reload (#222, gated on `TRACE_V2`) — re-queries live
   *  state on mount. */
  | { kind: "sessions"; id: string }
  /** Trace/Studio insight pages that used to be mutually-exclusive
   *  whole-area singletons (`activeInspector` / `activeReplay` /
   *  `activeProve` / `activeGraph`) and so hid every other tab while open.
   *  Now each is a workpane tab living in the leaf, beside the
   *  agent/Tasks/trace tabs. `id` is a constant (one tab per kind). The
   *  matching `active*` flag survives only as the Trace rail's highlight
   *  mirror, re-derived from the active leaf ref as tabs change. */
  | { kind: "inspector"; id: string }
  | { kind: "replay"; id: string }
  | { kind: "prove"; id: string }
  | { kind: "graph"; id: string };

// Plan-as-markdown is rendered through the standard `kind: "file"`
// pane, with the file living at `<repoRoot>/.aura/plans/<planId>.md`.
// The renderer detects the path and swaps in the plan UI (breadcrumb
// + checkbox round-trip to A2A) — see `isPlanMarkdownPath` below.

/** True when a file path is one of the saved plan markdown files. The
 *  WorkSurface uses this to swap in PlanMarkdownTab instead of the
 *  default editor. */
export function isPlanMarkdownPath(path: string): boolean {
  return /[/\\]\.aura[/\\]plans[/\\][^/\\]+\.md$/.test(path);
}

/** Extract the plan id from a plan markdown path. Returns null when
 *  the path is not a plan markdown file. */
export function planIdFromMarkdownPath(path: string): string | null {
  const m = path.match(/[/\\]\.aura[/\\]plans[/\\]([^/\\]+)\.md$/);
  return m ? m[1] : null;
}

/** Compose the canonical plan markdown path for a given repo + plan id. */
export function planMarkdownPath(repoRoot: string, planId: string): string {
  // Use the platform's separator at runtime; the repoRoot already
  // carries it, so a forward slash works on both macOS and Windows
  // (Tauri normalizes).
  return `${repoRoot}/.aura/plans/${planId}.md`;
}

export type WorkSplitDirection = "row" | "column";

/** Recursive split tree. A split layout is either a leaf pane (one
 *  group with its own tab list) or a split node holding 2+ children,
 *  each of which is itself a tree. Each split node carries its own
 *  `direction`, so split-right and then split-down inside one pane
 *  nests instead of re-orienting the whole layout. Each leaf carries
 *  its own `tabs` + `activeIndex` so per-pane tab strips render only
 *  the tabs that belong to that pane. */
export type WorkSplitLeaf = {
  kind: "leaf";
  /** Stable per-pane id. Survives re-renders so React keys + customise
   *  flows can address a specific pane independent of its DFS position. */
  paneId: string;
  tabs: WorkPaneRef[];
  /** Index into `tabs`. Always 0..tabs.length-1; clamped on mutation. */
  activeIndex: number;
};

export type WorkSplitTree =
  | WorkSplitLeaf
  | { kind: "split"; direction: WorkSplitDirection; children: WorkSplitTree[] };

/** Compatibility alias — older callers used `WorkSplitLayout` for the
 *  flat 2..N pane shape. The store now stores `WorkSplitTree` instead;
 *  the alias keeps imports compiling while consumers migrate. */
export type WorkSplitLayout = WorkSplitTree;

/** Soft cap on total leaf (pane) count. Above this, screen real estate
 *  per pane (≈300px wide on a 13" laptop) becomes unusable. */
export const MAX_SPLIT_PANES = 6;

// ── Tree helpers ─────────────────────────────────────────────────────

let _paneIdCounter = 0;
function generatePaneId(): string {
  _paneIdCounter += 1;
  return `pane-${Date.now().toString(36)}-${_paneIdCounter}`;
}

/** Build a fresh leaf with a generated pane id. */
export function makeLeaf(tabs: WorkPaneRef[], activeIndex = 0): WorkSplitLeaf {
  return {
    kind: "leaf",
    paneId: generatePaneId(),
    tabs,
    activeIndex: Math.max(0, Math.min(activeIndex, Math.max(0, tabs.length - 1))),
  };
}

/** Flatten the tree into the in-order list of leaf nodes. */
export function treeLeafNodes(t: WorkSplitTree): WorkSplitLeaf[] {
  if (t.kind === "leaf") return [t];
  return t.children.flatMap(treeLeafNodes);
}

/** Flatten to in-order list of *currently active* refs, one per leaf —
 *  this is what render walks for split-mode pane content. */
export function treeLeaves(t: WorkSplitTree): WorkPaneRef[] {
  return treeLeafNodes(t)
    .map((l) => l.tabs[l.activeIndex])
    .filter((r): r is WorkPaneRef => !!r);
}

/** Every ref across every leaf's full tab list — used by "is this ref
 *  somewhere in the layout?" checks (de-dup, cross-workspace add). */
export function treeAllRefs(t: WorkSplitTree): WorkPaneRef[] {
  return treeLeafNodes(t).flatMap((l) => l.tabs);
}

/** Total leaf (pane) count (used for MAX_SPLIT_PANES cap). */
export function treePaneCount(t: WorkSplitTree | null): number {
  return t ? treeLeafNodes(t).length : 0;
}

/** Does any leaf in the tree carry this ref in its tab list? */
export function treeContains(t: WorkSplitTree, ref: WorkPaneRef): boolean {
  return treeAllRefs(t).some((r) => samePaneRef(r, ref));
}

/** Find the leaf that owns `ref` in its tab list, if any. */
export function treeFindLeafByRef(
  t: WorkSplitTree,
  ref: WorkPaneRef,
): WorkSplitLeaf | null {
  for (const leaf of treeLeafNodes(t)) {
    if (leaf.tabs.some((r) => samePaneRef(r, ref))) return leaf;
  }
  return null;
}

/** Replace every occurrence of `target` ref with `next` (across every
 *  leaf's tab list). No-op if `target` not found. */
export function treeReplace(
  t: WorkSplitTree,
  target: WorkPaneRef,
  next: WorkPaneRef,
): WorkSplitTree {
  if (t.kind === "leaf") {
    const tabs = t.tabs.map((r) => (samePaneRef(r, target) ? next : r));
    return tabs === t.tabs ? t : { ...t, tabs };
  }
  return { ...t, children: t.children.map((c) => treeReplace(c, target, next)) };
}

/** Remove `target` from every leaf's tab list. Empty leaves are
 *  pruned; single-child splits collapse; nested splits sharing the
 *  parent direction flatten. Returns null when the tree empties. */
export function treeRemove(
  t: WorkSplitTree,
  target: WorkPaneRef,
): WorkSplitTree | null {
  if (t.kind === "leaf") {
    const idx = t.tabs.findIndex((r) => samePaneRef(r, target));
    if (idx < 0) return t;
    const tabs = t.tabs.filter((_, i) => i !== idx);
    if (tabs.length === 0) return null;
    const activeIndex = Math.max(
      0,
      Math.min(t.activeIndex >= idx ? t.activeIndex - 1 : t.activeIndex, tabs.length - 1),
    );
    return { ...t, tabs, activeIndex };
  }
  const next: WorkSplitTree[] = [];
  for (const c of t.children) {
    const after = treeRemove(c, target);
    if (after) next.push(after);
  }
  if (next.length === 0) return null;
  if (next.length === 1) return next[0]; // collapse single-child split
  const flat: WorkSplitTree[] = [];
  for (const c of next) {
    if (c.kind === "split" && c.direction === t.direction) flat.push(...c.children);
    else flat.push(c);
  }
  return { ...t, children: flat };
}

/** Remove an entire leaf (the whole pane and all its tabs) by paneId.
 *  Used by "Close pane" actions that want to drop the pane regardless
 *  of how many tabs it carries. */
export function treeRemoveLeaf(
  t: WorkSplitTree,
  paneId: string,
): WorkSplitTree | null {
  if (t.kind === "leaf") return t.paneId === paneId ? null : t;
  const next: WorkSplitTree[] = [];
  for (const c of t.children) {
    const after = treeRemoveLeaf(c, paneId);
    if (after) next.push(after);
  }
  if (next.length === 0) return null;
  if (next.length === 1) return next[0];
  const flat: WorkSplitTree[] = [];
  for (const c of next) {
    if (c.kind === "split" && c.direction === t.direction) flat.push(...c.children);
    else flat.push(c);
  }
  return { ...t, children: flat };
}

/** Insert a new pane next to `source`. Pulls source's leaf, splits it
 *  away into its own single-tab leaf and creates a sibling pane with
 *  the new (empty) tab. If the immediate parent split runs in
 *  `direction`, append as sibling; otherwise nest a new sub-split. */
export function treeSplitAt(
  t: WorkSplitTree,
  source: WorkPaneRef,
  empty: WorkPaneRef,
  direction: WorkSplitDirection,
): WorkSplitTree {
  if (t.kind === "leaf") {
    const idx = t.tabs.findIndex((r) => samePaneRef(r, source));
    if (idx < 0) return t;
    // The source leaf might carry many tabs. Extract `source` into its
    // own pane and leave the others behind so the user's other open
    // tabs in that pane stay untouched.
    const remainingTabs = t.tabs.filter((_, i) => i !== idx);
    const sourceLeaf = makeLeaf([source], 0);
    const emptyLeaf = makeLeaf([empty], 0);
    const split = {
      kind: "split" as const,
      direction,
      children: [sourceLeaf, emptyLeaf] as WorkSplitTree[],
    };
    if (remainingTabs.length === 0) {
      // Source was the only tab in the leaf — replace the whole leaf
      // with the new split.
      return split;
    }
    // Remaining tabs stay in the original leaf alongside the new
    // split. Wrap both in a row split so the new pane lands next to
    // the original. The outer split direction is `direction`.
    const remainderLeaf: WorkSplitLeaf = {
      ...t,
      tabs: remainingTabs,
      activeIndex: Math.max(
        0,
        Math.min(
          t.activeIndex >= idx ? t.activeIndex - 1 : t.activeIndex,
          remainingTabs.length - 1,
        ),
      ),
    };
    return {
      kind: "split",
      direction,
      children: [remainderLeaf, makeLeaf([source], 0), makeLeaf([empty], 0)],
    };
  }
  // Find which child contains source (by leaf-tab inclusion).
  const childIdx = t.children.findIndex(
    (c) => c.kind === "leaf" && c.tabs.some((r) => samePaneRef(r, source)),
  );
  if (childIdx >= 0) {
    const child = t.children[childIdx] as WorkSplitLeaf;
    const idx = child.tabs.findIndex((r) => samePaneRef(r, source));
    const remainingTabs = child.tabs.filter((_, i) => i !== idx);
    const newPane = makeLeaf([empty], 0);
    if (remainingTabs.length === 0) {
      // Whole child is the source — replace it directly.
      const sourceLeaf = makeLeaf([source], 0);
      if (t.direction === direction) {
        const children = [...t.children];
        children.splice(childIdx, 1, sourceLeaf, newPane);
        return { ...t, children };
      }
      const children = [...t.children];
      children[childIdx] = {
        kind: "split",
        direction,
        children: [sourceLeaf, newPane],
      };
      return { ...t, children };
    }
    // Source had siblings inside its leaf — extract just the source
    // tab into its own pane, then place a new sibling after it.
    const remainderLeaf: WorkSplitLeaf = {
      ...child,
      tabs: remainingTabs,
      activeIndex: Math.max(
        0,
        Math.min(
          child.activeIndex >= idx ? child.activeIndex - 1 : child.activeIndex,
          remainingTabs.length - 1,
        ),
      ),
    };
    const sourceLeaf = makeLeaf([source], 0);
    if (t.direction === direction) {
      const children = [...t.children];
      children.splice(childIdx, 1, remainderLeaf, sourceLeaf, newPane);
      return { ...t, children };
    }
    const children = [...t.children];
    children[childIdx] = {
      kind: "split",
      direction,
      children: [remainderLeaf, sourceLeaf, newPane],
    };
    return { ...t, children };
  }
  // Not at this level — recurse.
  return {
    ...t,
    children: t.children.map((c) => treeSplitAt(c, source, empty, direction)),
  };
}

/** Reorder leaf siblings inside their immediate parent split. */
export function treeReorder(
  t: WorkSplitTree,
  srcLeafId: string,
  dstLeafId: string,
): WorkSplitTree {
  if (t.kind === "leaf") return t;
  const srcIdx = t.children.findIndex(
    (c) => c.kind === "leaf" && c.paneId === srcLeafId,
  );
  const dstIdx = t.children.findIndex(
    (c) => c.kind === "leaf" && c.paneId === dstLeafId,
  );
  if (srcIdx >= 0 && dstIdx >= 0 && srcIdx !== dstIdx) {
    const children = [...t.children];
    const [moved] = children.splice(srcIdx, 1);
    children.splice(dstIdx, 0, moved);
    return { ...t, children };
  }
  return { ...t, children: t.children.map((c) => treeReorder(c, srcLeafId, dstLeafId)) };
}

/** Append `ref` to the tab list of leaf `paneId`. No-op if pane not
 *  found or ref already in that pane. */
export function treeAddTab(
  t: WorkSplitTree,
  paneId: string,
  ref: WorkPaneRef,
  focusNew = true,
): WorkSplitTree {
  if (t.kind === "leaf") {
    if (t.paneId !== paneId) return t;
    if (t.tabs.some((r) => samePaneRef(r, ref))) {
      // Already there — just focus it.
      const idx = t.tabs.findIndex((r) => samePaneRef(r, ref));
      return { ...t, activeIndex: idx };
    }
    const tabs = [...t.tabs, ref];
    return {
      ...t,
      tabs,
      activeIndex: focusNew ? tabs.length - 1 : t.activeIndex,
    };
  }
  return { ...t, children: t.children.map((c) => treeAddTab(c, paneId, ref, focusNew)) };
}

/** Set the active tab inside a pane by tab index. */
export function treeSetActiveTab(
  t: WorkSplitTree,
  paneId: string,
  index: number,
): WorkSplitTree {
  if (t.kind === "leaf") {
    if (t.paneId !== paneId) return t;
    if (index < 0 || index >= t.tabs.length) return t;
    return { ...t, activeIndex: index };
  }
  return { ...t, children: t.children.map((c) => treeSetActiveTab(c, paneId, index)) };
}

/** Find the leaf whose currently-active tab matches `ref`. */
export function treeFindActiveLeaf(
  t: WorkSplitTree,
  ref: WorkPaneRef,
): WorkSplitLeaf | null {
  for (const leaf of treeLeafNodes(t)) {
    const active = leaf.tabs[leaf.activeIndex];
    if (active && samePaneRef(active, ref)) return leaf;
  }
  return null;
}

export type ManagerTab = {
  /** Manager session id from the backend — used by managerStore to
   *  fetch + subscribe to the live ManagerSession JSON. Stable across
   *  shell restarts; the tab persists by re-opening with the same id. */
  sessionId: string;
  /** Truncated objective for the tab title. Stored alongside the id so
   *  closing + reopening the tab while the backend reads from disk
   *  shows the right label without an extra round-trip. */
  label: string;
};

/** Stage 8N — PR detail tabs. Same role as ManagerTab / TerminalTab —
 *  one entry per open PR, lives in the unified tab strip alongside
 *  files / agents / terminals. Field name `number` (not `prNumber`)
 *  matches the legacy `selectedPr` shape so the derived shim in
 *  useEditorStore() is a zero-cost rename. */
export type PrTab = {
  /** Stable id `${repoRoot}#${number}` — duplicate openPrDetail calls
   *  focus the existing tab instead of pushing a duplicate. */
  tabId: string;
  repoRoot: string;
  number: number;
  /** Friendly label for the tab strip. Updated when the user re-opens
   *  with a different title (rare). */
  title: string;
  /** True when the tab was opened from the Inbox — drives the Back
   *  button + closePrDetail's pop-back-to-inbox behaviour. */
  fromInbox: boolean;
};

/** Plan tab — opened from a Manager `PendingPlan`. We snapshot the
 *  plan's contents into the editor store so the tab keeps rendering
 *  even after the originating session resolves the plan (build/cancel)
 *  or is paged out of memory. Plan tabs are session-only — they do not
 *  survive a shell restart. */
/** Cursor-parity rich plan content. The simple form (title, summary,
 *  todos) still works — every rich field is optional and the PlanTab
 *  silently skips its section when empty. Brains opt into deeper
 *  content as they graduate from "draft a list" to "draft a full
 *  design doc". */
export type PlanPhase = {
  title: string;
  body: string;
  fileRefs: string[];
};

export type PlanTabData = {
  id: string;
  title: string;
  summary: string;
  /** Multi-paragraph objective. When present, renders as the lead
   *  "Objective" section instead of `summary`. `summary` stays as the
   *  one-line synopsis used by the inline chat card. */
  objective?: string;
  /** Markdown describing the current state — the "before" picture. */
  baseline?: string;
  /** Raw mermaid graph syntax, e.g. `flowchart TD\n  A --> B`. */
  architectureMermaid?: string;
  /** Numbered implementation phases with file refs. */
  phases?: PlanPhase[];
  /** Bulleted deliverables — what the user gets when this lands. */
  deliverables?: string[];
  /** Bulleted test plan — how we verify the plan worked. */
  tests?: string[];
  todos: {
    description: string;
    agent: string | null;
    done: boolean;
    fileRefs?: string[];
    /** Bucket N1 — teammate email/username this todo is assigned to. */
    assignee?: string | null;
    /** Bucket G — auto-routing suggestion when ≥10 historical samples
     *  exist for this todo's taxonomy cell. Surfaced as a click-to-
     *  override badge next to the agent badge. */
    suggestedProvider?: {
      providerId: string;
      score: number;
      sampleCount: number;
    } | null;
    /** What "done" looks like for this step — rendered as the goal line. */
    goal?: string | null;
    /** The verify plan — rendered as a checklist under the goal. */
    acceptance?: string[];
    /** Optional sub-steps. When present this step is a grouping and each
     *  sub-step becomes its own runnable task on Build. */
    subtasks?: {
      description: string;
      agent?: string | null;
      goal?: string | null;
      acceptance?: string[];
    }[];
  }[];
  /** Bucket G3 — backing pending plan id, used by the SkillBadge
   *  override dropdown to call `manager_override_todo_agent`. Only
   *  set while the plan is still pending; once the user clicks Build
   *  this clears so the badge becomes read-only. */
  pendingPlanId?: string | null;
  /** Originating workspace + session for "Referenced by N Agents" + jump-back. */
  repoRoot: string | null;
  sessionId: string | null;
  /** Wall-clock created-at, ms. */
  at: number;
};

/** The Trace verify/insight tools that open as singleton center pages
 *  (formerly modal dialogs). "memory" joined the set so the memory +
 *  sessions browser reads as a page, not a popup. */
export type TraceToolKind =
  | "review"
  | "rewind"
  | "attest"
  | "doctor"
  | "memory"
  | "impacts";

/** The sub-views the Trace Sessions surface can land on. "team" is the
 *  team-wide accountability feed (every teammate's AI changes — who, what,
 *  why, sealed, and whether it touches your work); "sessions" is your own
 *  drillable run log; "overview" is the at-a-glance dashboard; "usage" is the
 *  dedicated cost & token-usage view (the one home for spend, so Overview only
 *  shows a one-line cost summary that links here). */
export type TraceView = "overview" | "sessions" | "team" | "usage";

// Each Trace view is now its OWN openable workpane tab (no more in-pane
// segmented toggle): the view is encoded in the `sessions` pane id as
// `sessions:<view>`. These two helpers are the single source of truth for
// that id ⇄ view mapping, so the store, the render switch, and the tab-label
// derivation never drift. A bare legacy id ("sessions", from an older
// persisted layout) decodes to the "sessions" view.
const SESSIONS_TAB_PREFIX = "sessions:";
export function sessionsTabId(view: TraceView): string {
  return `${SESSIONS_TAB_PREFIX}${view}`;
}
export function sessionsViewFromId(id: string): TraceView {
  const v = id.startsWith(SESSIONS_TAB_PREFIX)
    ? id.slice(SESSIONS_TAB_PREFIX.length)
    : id;
  return v === "team" || v === "usage" || v === "overview" || v === "sessions"
    ? (v as TraceView)
    : "overview";
}

type State = {
  files: OpenFile[];
  agentTabs: AgentTab[];
  terminalTabs: TerminalTab[];
  managerTabs: ManagerTab[];
  planTabs: PlanTabData[];
  activePlanId: string | null;
  /** File path of the active file tab — null if no file is active. */
  activePath: string | null;
  /** Session id of the active agent tab — null if no agent is active.
   *  Mutually exclusive with the other actives: setting any of them
   *  clears the rest. */
  activeAgentId: string | null;
  /** Term id of the active terminal tab. */
  activeTermId: string | null;
  /** Bottom Terminal Panel's OWN focused terminal — independent of
   *  `activeTermId` (the editor-area active pane). Selecting a terminal
   *  in the panel side-list moves this, not the editor focus. */
  panelActiveTermId: string | null;
  /** Lightweight split-pane state for live PTY surfaces. The full
   *  tab list remains canonical; this only says "show these two live
   *  tabs together" when one of them is active. */
  splitLayout: WorkSplitLayout | null;
  /** Recently-closed tabs, oldest→newest, for ⌘⇧T "reopen closed tab"
   *  (VS Code parity). Only cleanly-reopenable kinds are recorded: a file
   *  reopens to its buffer, a view tab (Tasks/Pages/task/Trace/Sessions/…)
   *  re-queries on mount. Live-PTY kinds (terminal/agent) and session-only
   *  kinds (plan/empty/screenshare) are NOT recorded — their process/session
   *  is gone on close, so "reopen" would be a lie. Session-only, capped, and
   *  deliberately left out of the persisted snapshot. */
  closedTabs: WorkPaneRef[];
  /** The bottom Terminal Panel's side-list — one entry per VS Code
   *  "terminal group". Each group owns its OWN split tree, so multiple
   *  independent split groups coexist: a new terminal mints a fresh group
   *  (never disturbing an existing split) and splitting only re-tiles the
   *  active group. The canonical per-terminal data stays in `terminalTabs`;
   *  groups only arrange which terminals tile together in the panel. */
  terminalGroups: TerminalGroup[];
  /** Which side-list group is currently shown in the panel body. */
  panelActiveGroupId: string | null;
  /** Whether the bottom Terminal Panel is open. Lives in state (was a
   *  local `useState` in App.tsx) so it persists across restart and is
   *  workspace-scoped — switching workspaces restores that workspace's
   *  own panel-open state. */
  terminalPanelOpen: boolean;
  /** Manager session id of the active manager tab. */
  activeManagerId: string | null;
  /** Singleton Intent Inspector pane. The pane has no per-instance
   *  state (it queries `aura intent-vs-actual` on demand) so we don't
   *  need a tab array — one boolean for open/closed plus an active
   *  flag is enough. */
  inspectorOpen: boolean;
  activeInspector: boolean;
  /** Singleton Provenance Replay pane. Same shape as inspector — the
   *  pane queries git + manifest blobs on demand, so we just track
   *  open/active flags here. */
  replayOpen: boolean;
  activeReplay: boolean;
  /** Singleton Plan Builder wizard. The pane is a multi-step wizard
   *  that calls `aura plan` headless, parses the produced XML and lets
   *  the user edit before saving. No per-instance state — wizard step
   *  + buffer live inside the surface component. */
  planBuilderOpen: boolean;
  activePlanBuilder: boolean;
  /** Singleton Prove pane. Live goal-trace surface — user types a
   *  behavioral goal, pane shells `aura prove` and renders the result
   *  as a checks list + simple satisfied/missing graph. Persists the
   *  current goal text via localStorage so reopen restores context. */
  proveOpen: boolean;
  activeProve: boolean;
  /** Singleton Semantic Graph pane (graphify port). Loads
   *  `.aura/kg/graph.json` on open; rebuild from a header button.
   *  Same shape as the other Studio panes — no per-instance state. */
  graphOpen: boolean;
  activeGraph: boolean;
  /** Stage 8N — PR detail is now a real tab kind. Multiple PRs can be
   *  open concurrently and survive switching between code / agent /
   *  terminal tabs. Each tab carries the data PRDetailPane needs to
   *  render the right PR (repoRoot + number + title) plus the inbox
   *  origin flag for the Back button.
   *
   *  The legacy singleton flags (prDetailOpen / activePrDetail /
   *  selectedPr / prDetailFromInbox) are kept alive as DERIVED shims
   *  in `useEditorStore()` so the 19 existing consumers don't change
   *  shape during the migration. */
  prTabs: PrTab[];
  activePrTabId: string | null;
  /** Singleton Inbox pane (Stage 8A). Graphite-style PR triage list
   *  bucketed by viewer relationship — Needs your review / Returned to
   *  you / Approved / Waiting for reviewers / Drafts / Merged / Waiting
   *  for author. The pane reads PRs for the current workspace via
   *  `pr_list` + `pr_whoami`. Same shape as the other singleton panes. */
  inboxOpen: boolean;
  activeInbox: boolean;
  /** Always-first Aura dashboard. Pinned permanent tab, can't be
   *  closed. Default-active when a workspace opens with no other tab
   *  selected, so first paint is the Aura perspective of the project
   *  (AST nodes, intents, snapshots, command bar). */
  activeDashboard: boolean;
  /** Trace v2 Sessions surface (gated by `TRACE_V2`). A singleton center
   *  pane like the others — the per-run list spine plus its session
   *  detail. List↔detail navigation lives inside the pane, not the store,
   *  so the store only needs this one active flag. */
  activeSessions: boolean;
  /** Which sub-view the Trace/Sessions surface lands on. Ephemeral (not
   *  persisted): the rail's Overview vs Sessions rows both open the same
   *  `activeSessions` pane but preselect this. The session detail drill
   *  -down is local to the pane, so it isn't tracked here. */
  traceView: TraceView;
  /** Which Trace verify tool is open as a center page, if any. These used
   *  to be modal dialogs (Review / Rewind / Attestations / Doctor); they
   *  now render as a singleton page like the other Studio panes so they
   *  read as tabs, not popups. Mutually exclusive — opening one replaces
   *  the last — so a single discriminator covers all four. */
  traceTool: TraceToolKind | null;
  /** Optional prefill for the open tool (Rewind reads identifier + file
   *  when summoned from a symbol's right-click menu). Cleared on close. */
  traceToolArg: { identifier?: string; file?: string } | null;
  /** Active top-level sidebar tab. UI preference (global), not
   *  workspace-bound. */
  sidebarTab: "sessions" | "code";
  /** Active sub-pill under the Code tab. */
  codeSubPill: "files" | "git" | "prs";
};

const SIDEBAR_TAB_KEY = "aura.sidebar.tab";
const CODE_SUBPILL_KEY = "aura.sidebar.codeSubPill";

function readSidebarTab(): "sessions" | "code" {
  try {
    const v = localStorage.getItem(SIDEBAR_TAB_KEY);
    if (v === "sessions" || v === "code") return v;
  } catch {
    /* ignore */
  }
  return "code";
}
function readCodeSubPill(): "files" | "git" | "prs" {
  try {
    const v = localStorage.getItem(CODE_SUBPILL_KEY);
    if (v === "files" || v === "git" || v === "prs") return v;
  } catch {
    /* ignore */
  }
  return "files";
}
function persistSidebarTab(v: "sessions" | "code") {
  try {
    localStorage.setItem(SIDEBAR_TAB_KEY, v);
  } catch {
    /* quota — ignore */
  }
}
function persistCodeSubPill(v: "files" | "git" | "prs") {
  try {
    localStorage.setItem(CODE_SUBPILL_KEY, v);
  } catch {
    /* quota — ignore */
  }
}

const subs = new Set<() => void>();

// The workspace this shell is bound to right now, tracked in-memory so the
// snapshot writer never depends on App.tsx's localStorage write ordering.
// `switchWorkspace` sets it to the incoming root; until the first switch it's
// null and `currentWorkspaceRoot()` falls back to persisted `aura.lastWorkspace`.
let activeRoot: string | null = null;

// Per-workspace snapshots are only re-written once boot has finished hydrating
// the live state. Without this gate the synchronous boot effects (the global
// split-layout restore) would fire `setState` BEFORE `switchWorkspace` has
// restored the workspace's tabs, clobbering the good on-disk snapshot with a
// near-empty one. App.tsx calls `armWorkspaceSnapshots()` after the boot
// `loadProjectAt` resolves; from then on every structural tab change keeps the
// scoped snapshot fresh, so a closed tab stays closed across restarts.
let snapshotsArmed = false;

/** Arm the per-workspace snapshot writer. Called once, after boot hydration. */
export function armWorkspaceSnapshots(): void {
  snapshotsArmed = true;
}

let state: State = {
  files: [],
  agentTabs: [],
  terminalTabs: [],
  managerTabs: [],
  planTabs: [],
  activePlanId: null,
  activePath: null,
  activeAgentId: null,
  activeTermId: null,
  panelActiveTermId: null,
  splitLayout: null,
  closedTabs: [],
  terminalGroups: [],
  panelActiveGroupId: null,
  terminalPanelOpen: false,
  activeManagerId: null,
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
  prTabs: [],
  activePrTabId: null,
  inboxOpen: false,
  activeInbox: false, activeSessions: false, traceTool: null, traceToolArg: null,
  traceView: "overview",
  // Aura dashboard tab retired — the chat-first WorkSurfaceEmpty owns
  // the empty state, and the Manager lives in the right-rail. Default
  // off so opening a fresh workspace lands on the empty surface, not
  // on the legacy ManagerDashboardSurface.
  activeDashboard: false,
  sidebarTab: readSidebarTab(),
  codeSubPill: readCodeSubPill(),
};

function emit() {
  subs.forEach((fn) => fn());
}

function setState(next: State) {
  const prevTabsByRoot = groupAgentTabsByRoot(state.agentTabs);
  const prevManagerTabs = state.managerTabs;
  const prevSplitLayout = state.splitLayout;
  state = next;
  // Stage 9I — persist splitLayout to a single global key so a shell
  // restart restores the layout (cross-workspace splits are common, so
  // the key is global rather than per-repo). Empty / terminal refs are
  // filtered out before serialising — terminal PTYs and empty pickers
  // are session-only, the layout collapses cleanly when they're gone.
  if (next.splitLayout !== prevSplitLayout) {
    persistSplitLayout(next.splitLayout);
  }
  // Persist the open stream-mode agent tab list per workspace whenever
  // it changes. PTY-mode tabs are inherently ephemeral (the child is
  // gone after restart) so they're filtered out — restored tabs come
  // back as fresh stream tabs that --resume the persisted sessionId on
  // their next prompt. Compare per-root snapshots to avoid touching
  // localStorage on every unrelated state change (file open, etc).
  const nextTabsByRoot = groupAgentTabsByRoot(next.agentTabs);
  for (const [root, list] of nextTabsByRoot) {
    if (!shallowEq(list, prevTabsByRoot.get(root))) {
      persistOpenAgents(root, list);
    }
  }
  for (const root of prevTabsByRoot.keys()) {
    if (!nextTabsByRoot.has(root)) {
      persistOpenAgents(root, []);
    }
  }
  // Manager tabs are global (not workspace-bound) — single localStorage
  // key. Persist on any open/close/rename so a shell restart restores
  // the user's in-flight Manager sessions.
  if (managerTabsChanged(prevManagerTabs, next.managerTabs)) {
    persistManagerTabs(next.managerTabs);
  }
  // Keep the active workspace's scoped snapshot fresh on every structural
  // change — not just on switch-away (the old behaviour, which let a tab the
  // user closed mid-session resurrect on the next launch because the snapshot
  // still held it). Armed only after boot finishes hydrating, so the boot-time
  // global-layout restore can't overwrite the on-disk snapshot before
  // `switchWorkspace` has populated live state. setState is user-frequency
  // (tab open/close/switch/reorder), never per-token, so a full serialise here
  // is cheap. `switchWorkspace` itself bypasses setState, so the transient
  // empty state mid-switch is never captured.
  if (snapshotsArmed && activeRoot) {
    saveSnapshot(activeRoot, buildSnapshotFromState(next));
  }
  emit();
}

type PersistedAgent = {
  sessionId: string;
  agentId: string;
  agentLabel: string;
  agentMonogram: string;
  /** "stream" | "pty" | "chat". Persisted so a tab that was a PTY (the
   *  default for interactive coding-agent CLIs like Claude Code /
   *  Gemini / Codex / Cursor) reopens as a PTY rather than being
   *  silently dropped on workspace switch. "chat" reopens an
   *  openai-compat chat surface bound to its saved profile. */
  mode: "stream" | "pty" | "chat";
  /** Only set when `mode === "chat"`. Identifies the openai-compat
   *  profile so the rehydrate path can rebind the chat view. */
  openaiCompatProfile?: string;
  /** The agent's own session id (Claude JSONL stem) this tab is bound to,
   *  persisted so a cold restore resumes THIS tab's conversation rather
   *  than the newest-in-repo. Per-tab — see AgentTab.resumeSessionId. */
  resumeSessionId?: string;
};

function groupAgentTabsByRoot(tabs: AgentTab[]): Map<string, PersistedAgent[]> {
  const out = new Map<string, PersistedAgent[]>();
  for (const t of tabs) {
    const list = out.get(t.repoRoot) ?? [];
    list.push({
      sessionId: t.sessionId,
      agentId: t.agentId,
      agentLabel: t.agentLabel,
      agentMonogram: t.agentMonogram,
      mode: t.mode,
      openaiCompatProfile: t.openaiCompatProfile,
      resumeSessionId: t.resumeSessionId ?? undefined,
    });
    out.set(t.repoRoot, list);
  }
  return out;
}

function shallowEq(a: PersistedAgent[], b: PersistedAgent[] | undefined): boolean {
  if (!b) return a.length === 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.sessionId !== y.sessionId ||
      x.agentId !== y.agentId ||
      x.agentLabel !== y.agentLabel ||
      x.mode !== y.mode ||
      x.resumeSessionId !== y.resumeSessionId
    ) {
      return false;
    }
  }
  return true;
}

// Hard ceiling on how many agents a single workspace restores from
// persistence. A real working set is a handful; anything beyond this is
// almost certainly the runaway-respawn accumulation from earlier builds.
// Generous enough not to clip normal multi-agent use, bounded enough that a
// bloated localStorage can't reopen a workspace into a swarm.
const MAX_PERSISTED_AGENTS_PER_ROOT = 8;

function openAgentsKey(repoRoot: string): string {
  return `aura.openAgents.${repoRoot}`;
}

function persistOpenAgents(repoRoot: string, list: PersistedAgent[]) {
  try {
    if (list.length === 0) {
      localStorage.removeItem(openAgentsKey(repoRoot));
    } else {
      localStorage.setItem(openAgentsKey(repoRoot), JSON.stringify(list));
    }
  } catch {
    /* quota — ignore */
  }
}

// ── Manager tab persistence ────────────────────────────────────────
//
// Single global key — Manager sessions can span repos so the tab roster
// is workspace-independent. App.tsx restores from `readPersistedManagers`
// at boot, intersects with `manager_list()` to drop sessions whose JSON
// has been deleted, and re-issues `openManager` for the survivors.

const MANAGER_TABS_KEY = "aura.managerTabs";

type PersistedManager = {
  sessionId: string;
  label: string;
};

function managerTabsChanged(a: ManagerTab[], b: ManagerTab[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].sessionId !== b[i].sessionId || a[i].label !== b[i].label) {
      return true;
    }
  }
  return false;
}

function persistManagerTabs(list: ManagerTab[]) {
  try {
    if (list.length === 0) {
      localStorage.removeItem(MANAGER_TABS_KEY);
    } else {
      const payload: PersistedManager[] = list.map((t) => ({
        sessionId: t.sessionId,
        label: t.label,
      }));
      localStorage.setItem(MANAGER_TABS_KEY, JSON.stringify(payload));
    }
  } catch {
    /* quota — ignore */
  }
}

export function readPersistedManagers(): PersistedManager[] {
  // Flag off → no manager tabs are restored, so a snapshot written while the
  // native chat was enabled can't re-mount it on the next launch.
  if (!AURA_MANAGER_ENABLED) return [];
  try {
    const raw = localStorage.getItem(MANAGER_TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PersistedManager =>
        e && typeof e.sessionId === "string" && typeof e.label === "string",
    );
  } catch {
    return [];
  }
}

/** Read the persisted stream-tab roster for a workspace. The caller
 *  (App.tsx loadProjectAt) walks this on workspace open and re-issues
 *  openAgent for each entry so the user sees their previous chats
 *  back in place. */
export function readPersistedAgents(repoRoot: string): PersistedAgent[] {
  try {
    const raw = localStorage.getItem(openAgentsKey(repoRoot));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: PersistedAgent[] = parsed
      .filter(
        (e): e is Omit<PersistedAgent, "mode"> & {
          mode?: "stream" | "pty" | "chat";
          openaiCompatProfile?: string;
        } =>
          e &&
          typeof e.sessionId === "string" &&
          typeof e.agentId === "string" &&
          typeof e.agentLabel === "string",
      )
      .map((e) => ({
        ...e,
        mode: e.mode === "pty" ? "pty" : e.mode === "chat" ? "chat" : "stream",
        openaiCompatProfile: e.openaiCompatProfile,
      }));
    // Self-heal the runaway-agent accumulation: dedupe by sessionId and
    // keep only the most-recent working set. Earlier builds auto-respawned
    // on every PTY exit, which could pile dozens of dead/duplicate agents
    // into this list — restoring them all booted a workspace with a swarm
    // of dormant tiles. Dedupe + cap bounds that without a liveness probe
    // (dormant agents are legitimately not-alive, so we can't prune by it).
    const seen = new Set<string>();
    const deduped: PersistedAgent[] = [];
    for (const e of valid) {
      if (seen.has(e.sessionId)) continue;
      seen.add(e.sessionId);
      deduped.push(e);
    }
    const capped =
      deduped.length > MAX_PERSISTED_AGENTS_PER_ROOT
        ? deduped.slice(-MAX_PERSISTED_AGENTS_PER_ROOT)
        : deduped;
    // Flush the cleaned list back so the bloat doesn't reaccumulate and the
    // next read is already small.
    if (capped.length !== parsed.length) {
      persistOpenAgents(repoRoot, capped);
    }
    return capped;
  } catch {
    return [];
  }
}

// ── Split layout persistence ───────────────────────────────────────
//
// One global key — splits are deliberately cross-workspace (the picker
// pulls from every workspace's tab list) so per-repo keys would split
// the layout in half on workspace switch. Empty/terminal refs are
// stripped before serialising; they're session-only and the tree
// collapses cleanly when their leaves disappear.
//
// #222 NOTE: the per-workspace snapshot (`aura.workspaceSnapshot.<root>`) is
// now the SINGLE source of truth for restoring a workspace's layout on boot.
// The old boot-time read of this global key was a SECOND, competing source
// that applied a beat before the snapshot rehydrate landed and then got
// overwritten by it — the flat/split flip the user saw. That boot reader is
// gone (`readPersistedSplitLayout` is retained but no longer called at boot),
// so the snapshot wins unambiguously. The key is still written on layout
// changes (harmless, self-healing) so a future cross-workspace consumer can
// opt back in without re-introducing a boot-time fight.

const SPLIT_LAYOUT_KEY = "aura.splitLayout";
// Bumped whenever the persisted-layout contract changes. A read that finds
// a different version drops the blob (see `readPersistedSplitLayout`) — this
// is the one-shot escape hatch that clears every stale layout from before a
// shell update, so a cache from an old build can never re-mount tabs that no
// longer exist. v2 introduced the {v,root} envelope below.
const SPLIT_LAYOUT_VERSION = 2;

/** The workspace this shell is bound to right now — the same value App.tsx
 *  writes as it loads a project (`aura.lastWorkspace`). The global split
 *  layout is STAMPED with it so a layout saved under workspace A is never
 *  blindly re-applied when booting into workspace B. Each workspace's own
 *  snapshot (`aura.workspaceSnapshot.<root>`) owns its scoped layout; this
 *  global key is only a fast-path for restoring the *current* workspace. */
function currentWorkspaceRoot(): string | null {
  // Prefer the in-memory binding set by `switchWorkspace` (race-free vs
  // App.tsx's `aura.lastWorkspace` write); fall back to the persisted value on
  // the very first paint, before any workspace has been switched in.
  if (activeRoot) return activeRoot;
  try {
    return localStorage.getItem("aura.lastWorkspace");
  } catch {
    return null;
  }
}

/** Stamped envelope around the persisted global split tree. The stamp is
 *  what makes the cache safe: a version mismatch (older build) or a root
 *  mismatch (layout belongs to a different workspace) both cause the blob
 *  to be ignored on restore instead of leaking foreign/stale tabs in. */
type PersistedSplitLayout = {
  v: number;
  root: string | null;
  tree: WorkSplitTree;
};

/** Section/nav surfaces — Tasks, Automations, Goals, Safety check,
 *  My sessions, Team, Code Map, mini-apps, and the Trace tools. Every one of
 *  these is a destination reachable from the nav rail in a single click, NOT
 *  a document you author. Persisting them (the old #222 behaviour) meant a
 *  workspace snapshot or split-layout blob would resurrect them on reload as
 *  "phantom tabs" the user never opened — exactly the bug report. So they are
 *  dropped on BOTH persist (`sanitizeRefForPersist`) and restore
 *  (`validateTree`); only real documents/sessions — file / agent / manager /
 *  task / pages — survive a reload. A stale blob already on disk self-heals
 *  the next time it's read.
 *
 *  NOTE: `pages` is deliberately NOT here. After the Pages redesign a page tab
 *  is an authored document (it carries the open page's title, not just the
 *  word "Pages"), so it must be workspace-dependent: opening a page belongs to
 *  the CURRENT workspace's tab set, and switching workspaces has to swap the
 *  strip to that workspace's own pages and bring them back on return. The
 *  per-workspace snapshot is keyed by repoRoot and the global split-layout key
 *  is stamped with its root (see `currentWorkspaceRoot`), so a restored pages
 *  tab can only ever re-mount in the exact workspace it was open in — never as
 *  a cross-workspace phantom. */
const EPHEMERAL_SURFACE_KINDS: ReadonlySet<string> = new Set([
  "tasks",
  "standup",
  "automations",
  "channels",
  "commons",
  "app",
  "sessions",
  "inspector",
  "replay",
  "prove",
  "graph",
  "trace",
]);

function sanitizeRefForPersist(ref: WorkPaneRef): WorkPaneRef | null {
  if (ref.kind === "empty") return null;
  if (ref.kind === "terminal") return null; // termId is runtime-only
  if (ref.kind === "plan") return null; // plan tabs are session-only
  if (ref.kind === "screenshare") return null; // SFU track is session-only
  // Open-on-demand nav destinations never persist — see EPHEMERAL_SURFACE_KINDS.
  if (EPHEMERAL_SURFACE_KINDS.has(ref.kind)) return null;
  return ref;
}

function sanitizeTreeForPersist(t: WorkSplitTree): WorkSplitTree | null {
  if (t.kind === "leaf") {
    const tabs = t.tabs.map(sanitizeRefForPersist).filter((r): r is WorkPaneRef => !!r);
    if (tabs.length === 0) return null;
    return {
      kind: "leaf",
      paneId: t.paneId,
      tabs,
      activeIndex: Math.min(t.activeIndex, tabs.length - 1),
    };
  }
  const kids: WorkSplitTree[] = [];
  for (const c of t.children) {
    const after = sanitizeTreeForPersist(c);
    if (after) kids.push(after);
  }
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { kind: "split", direction: t.direction, children: kids };
}

function persistSplitLayout(tree: WorkSplitTree | null) {
  try {
    if (!tree) {
      localStorage.removeItem(SPLIT_LAYOUT_KEY);
      return;
    }
    const sanitized = sanitizeTreeForPersist(tree);
    if (!sanitized) {
      localStorage.removeItem(SPLIT_LAYOUT_KEY);
      return;
    }
    const envelope: PersistedSplitLayout = {
      v: SPLIT_LAYOUT_VERSION,
      root: currentWorkspaceRoot(),
      tree: sanitized,
    };
    localStorage.setItem(SPLIT_LAYOUT_KEY, JSON.stringify(envelope));
  } catch {
    /* quota — ignore */
  }
}

const TRACE_TOOL_KINDS = new Set<TraceToolKind>([
  "review",
  "rewind",
  "attest",
  "doctor",
  "memory",
  "impacts",
]);

function isTraceToolKind(v: unknown): v is TraceToolKind {
  return typeof v === "string" && TRACE_TOOL_KINDS.has(v as TraceToolKind);
}

/** Re-hydrate a persisted trace `arg` (Rewind's symbol/file prefill). Keeps
 *  only the `{ identifier?, file? }` string shape; returns null when nothing
 *  usable survives so the restored tab opens the tool with no prefill. */
function sanitizeTraceArg(v: unknown): { identifier?: string; file?: string } | null {
  if (!v || typeof v !== "object") return null;
  const a = v as { identifier?: unknown; file?: unknown };
  const out: { identifier?: string; file?: string } = {};
  if (typeof a.identifier === "string") out.identifier = a.identifier;
  if (typeof a.file === "string") out.file = a.file;
  return out.identifier || out.file ? out : null;
}

/** Validate a parsed value is a WorkSplitTree shape. Defensive — bad
 *  localStorage from an older build is dropped silently. */
function validateTree(v: unknown): WorkSplitTree | null {
  if (!v || typeof v !== "object") return null;
  const node = v as { kind?: unknown };
  if (node.kind === "leaf") {
    const leaf = v as { paneId?: unknown; tabs?: unknown; activeIndex?: unknown };
    if (typeof leaf.paneId !== "string") return null;
    if (!Array.isArray(leaf.tabs)) return null;
    const tabs: WorkPaneRef[] = [];
    for (const t of leaf.tabs) {
      if (!t || typeof t !== "object") continue;
      const r = t as { kind?: unknown; id?: unknown; path?: unknown };
      // Drop section/nav surfaces on restore — they open from the nav rail on
      // demand and must never come back as phantom tabs. The shape branches
      // below stay as a record but are unreachable for these kinds.
      if (typeof r.kind === "string" && EPHEMERAL_SURFACE_KINDS.has(r.kind)) continue;
      if (r.kind === "agent" && typeof r.id === "string") tabs.push({ kind: "agent", id: r.id });
      // Manager refs only survive restore when the native chat is enabled —
      // otherwise a persisted split that held an "Aura" pane is dropped so it
      // can't re-mount the gated surface.
      else if (r.kind === "manager" && typeof r.id === "string" && AURA_MANAGER_ENABLED)
        tabs.push({ kind: "manager", id: r.id });
      else if (r.kind === "file" && typeof r.path === "string") tabs.push({ kind: "file", path: r.path });
      else if (r.kind === "tasks" && typeof r.id === "string") tabs.push({ kind: "tasks", id: r.id });
      else if (
        r.kind === "task" &&
        typeof r.id === "string" &&
        typeof (r as { repoRoot?: unknown }).repoRoot === "string"
      )
        tabs.push({
          kind: "task",
          id: r.id,
          repoRoot: (r as { repoRoot: string }).repoRoot,
        });
      else if (r.kind === "standup" && typeof r.id === "string") tabs.push({ kind: "standup", id: r.id });
      else if (r.kind === "pages" && typeof r.id === "string") tabs.push({ kind: "pages", id: r.id });
      else if (r.kind === "automations" && typeof r.id === "string") tabs.push({ kind: "automations", id: r.id });
      else if (r.kind === "channels" && typeof r.id === "string") tabs.push({ kind: "channels", id: r.id });
      else if (r.kind === "commons" && typeof r.id === "string" && COMMONS_ENABLED) tabs.push({ kind: "commons", id: r.id });
      else if (r.kind === "app" && typeof r.id === "string" && COMMONS_ENABLED) tabs.push({ kind: "app", id: r.id });
      // Trace/Studio page tabs (#222) — persisted so the open-order
      // survives reload. `sessions`/`graph` stay gated on their feature
      // flags (matching `hydrateFromSnapshot`) so a stale entry can't
      // re-mount a pane whose flag is now off.
      else if (r.kind === "sessions" && typeof r.id === "string" && TRACE_V2)
        tabs.push({ kind: "sessions", id: r.id });
      else if (r.kind === "inspector" && typeof r.id === "string")
        tabs.push({ kind: "inspector", id: r.id });
      else if (r.kind === "replay" && typeof r.id === "string")
        tabs.push({ kind: "replay", id: r.id });
      else if (r.kind === "prove" && typeof r.id === "string")
        tabs.push({ kind: "prove", id: r.id });
      else if (r.kind === "graph" && typeof r.id === "string" && CODE_MAP_ENABLED)
        tabs.push({ kind: "graph", id: r.id });
      else if (
        r.kind === "trace" &&
        typeof r.id === "string" &&
        isTraceToolKind((r as { tool?: unknown }).tool)
      ) {
        const tool = (r as { tool: TraceToolKind }).tool;
        const arg = sanitizeTraceArg((r as { arg?: unknown }).arg);
        tabs.push(arg ? { kind: "trace", id: r.id, tool, arg } : { kind: "trace", id: r.id, tool });
      }
      // screenshare is session-only and stripped on persist, so a
      // round-trip would never contain it; we deliberately don't
      // include a re-hydration branch so a stale entry from a
      // hand-edited localStorage gets dropped silently.
    }
    if (tabs.length === 0) return null;
    const activeIndex =
      typeof leaf.activeIndex === "number"
        ? Math.max(0, Math.min(leaf.activeIndex, tabs.length - 1))
        : 0;
    return { kind: "leaf", paneId: leaf.paneId, tabs, activeIndex };
  }
  if (node.kind === "split") {
    const split = v as { direction?: unknown; children?: unknown };
    if (split.direction !== "row" && split.direction !== "column") return null;
    if (!Array.isArray(split.children)) return null;
    const children: WorkSplitTree[] = [];
    for (const c of split.children) {
      const after = validateTree(c);
      if (after) children.push(after);
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { kind: "split", direction: split.direction, children };
  }
  return null;
}

/** Read the persisted split tree, if any. Returns null when nothing is
 *  stored, the stored shape is invalid, or — crucially — the stamp doesn't
 *  match this shell + workspace. The boot restore (App.tsx) applies the
 *  global key once, independent of which project loads; without this gate a
 *  layout saved under another workspace (or by an older build) would stomp
 *  the correctly-scoped per-workspace restore with tabs that resolve to
 *  nothing. Three reject paths, each clearing the bad blob so it can't
 *  linger:
 *    1. not the current envelope version  → an old-build cache; drop it.
 *    2. a bare pre-stamp tree (no `v`)    → legacy format; drop it.
 *    3. stamped for a different workspace → the other workspace's own
 *       snapshot owns that layout; ignore here (don't clear — it's still
 *       valid for *that* root, and the global key is rewritten the moment
 *       this workspace's layout changes). */
export function readPersistedSplitLayout(): WorkSplitTree | null {
  try {
    const raw = localStorage.getItem(SPLIT_LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      localStorage.removeItem(SPLIT_LAYOUT_KEY);
      return null;
    }
    const env = parsed as Partial<PersistedSplitLayout>;
    if (env.v !== SPLIT_LAYOUT_VERSION || !env.tree) {
      // Legacy bare-tree blob or a layout from a prior build — drop it so a
      // stale cache never re-mounts tabs that no longer exist.
      localStorage.removeItem(SPLIT_LAYOUT_KEY);
      return null;
    }
    const here = currentWorkspaceRoot();
    // A root of null means "saved before any workspace was bound" (first
    // run) — tolerate it. Otherwise require an exact match with the booting
    // workspace; a mismatch means this layout belongs to a different project.
    if (env.root != null && here != null && env.root !== here) return null;
    return validateTree(env.tree);
  } catch {
    return null;
  }
}

export function useEditorStore(): State & {
  open: (path: string, opts?: { defaultView?: "edit" | "diff" }) => Promise<void>;
  /** Open `path` as a new pane next to the currently-active pane, split
   *  in `direction`. Used by Files panel Alt+click and the per-row
   *  context-menu "Open in Split" entries. If a split layout already
   *  exists and the active leaf is found, the file is inserted as a
   *  sibling; otherwise a fresh row/column split wraps the previous
   *  full pane + the new file. No-op replaces a regular open if the
   *  file already lives somewhere in the layout. */
  openFileSplit: (path: string, direction: WorkSplitDirection) => Promise<void>;
  close: (path: string) => void;
  closeAll: () => void;
  /** Workspace transition: serialize `prev`'s full tab state into its
   *  per-workspace snapshot, wipe live state, then rehydrate from
   *  `next`'s snapshot (if any). Replaces the legacy "closeAll +
   *  reload agents" path that bled non-target-workspace tabs across
   *  switches. Pass `prev=null` on first boot. */
  switchWorkspace: (prev: string | null, next: string) => void;
  /** Club entry: serialize `prev` (the outgoing concrete workspace, if
   *  any) into its own slot, then hydrate state from the club slot.
   *  First entry seeds the club slot from a union of the members'
   *  snapshots. */
  enterClub: (prev: string | null, members: string[]) => void;
  /** Club exit: serialize the live tab state back to the club slot
   *  (so re-entering picks up where the user left off), then hydrate
   *  state from `next`'s per-workspace snapshot like a normal switch. */
  exitClub: (next: string) => void;
  setActive: (path: string) => void;
  updateBuffer: (path: string, text: string) => void;
  saveActive: () => Promise<void>;
  isDirty: (path: string) => boolean;
  openAgent: (
    tab: Omit<AgentTab, "view" | "mode"> & {
      view?: "ui" | "terminal";
      mode?: "stream" | "pty" | "chat";
    },
  ) => void;
  /** Replace an existing agent tab in place — same slot, new
   *  session/mode. Used by "Open Terminal" so a stream tab flips to a
   *  PTY tab without spawning a third tab beside it. */
  replaceAgent: (
    oldSessionId: string,
    next: Omit<AgentTab, "view" | "mode"> & {
      view?: "ui" | "terminal";
      mode?: "stream" | "pty" | "chat";
    },
  ) => void;
  closeAgent: (sessionId: string) => void;
  /** Close an agent tab AND stop its underlying CLI (kills the PTY, then drops
   *  the tab). The default for the tab's X / Cmd-W, so a closed agent never
   *  lingers as an orphan process. Use plain `closeAgent` only when the session
   *  must stay alive (e.g. detach-to-window hands off the live PTY). */
  stopAndCloseAgent: (sessionId: string) => void;
  /** Bind (or update) the per-tab Claude session id that "Start all" / a
   *  restart should resume. Keyed by the tab's current sessionId; a no-op
   *  if the value is unchanged so it never churns persistence. This is what
   *  lets several same-repo Claude tabs each reopen their OWN conversation
   *  instead of all snapping to the newest session in the repo. */
  bindAgentResumeSession: (sessionId: string, resumeSessionId: string) => void;
  setActiveAgent: (sessionId: string) => void;
  setAgentView: (sessionId: string, view: "ui" | "terminal") => void;
  /** Flip the per-tab attention flag on (BEL detected, permission
   *  prompt). Auto-cleared when the user focuses the tab. */
  markAgentAttention: (sessionId: string) => void;
  clearAgentAttention: (sessionId: string) => void;
  openTerminal: (
    cwd: string,
    opts?: { bootCommand?: string; label?: string; shell?: string; profileId?: string },
  ) => string;
  closeTerminal: (termId: string) => void;
  setActiveTerminal: (termId: string) => void;
  /** Bottom Terminal Panel — open a terminal as a NEW side-list group
   *  (mints its own group; never disturbs an existing split). */
  openPanelTerminal: (
    cwd: string,
    opts?: { bootCommand?: string; label?: string; shell?: string; profileId?: string },
  ) => string;
  /** Bottom Terminal Panel — focus a terminal. Selects its owning group
   *  and focuses that pane; never destroys any group's layout. */
  selectPanelTerminal: (termId: string) => void;
  /** Bottom Terminal Panel — focus a whole group (side-list row click). */
  selectPanelGroup: (groupId: string) => void;
  /** Bottom Terminal Panel — split the active group's focused pane with a
   *  fresh sibling. Returns the new termId, or null if at the pane cap.
   *  Only re-tiles the active group; other groups are untouched. */
  splitPanelTerminal: (direction: WorkSplitDirection) => string | null;
  /** Bottom Terminal Panel — drag an EXISTING terminal into a target
   *  group's split (VS Code drag-and-drop parity). Removes it from its
   *  source group (dropping the group if it empties) and tiles it beside
   *  the target group's active pane. No-op if same group or at pane cap. */
  mergeTerminalIntoGroup: (
    termId: string,
    targetGroupId: string,
    direction?: WorkSplitDirection,
  ) => void;
  /** Bottom Terminal Panel — open/close (persisted + workspace-scoped). */
  setTerminalPanelOpen: (open: boolean) => void;
  toggleTerminalPanel: () => void;
  /** "Expand" a bottom-panel terminal into the center editor area as a
   *  regular tab (VS Code's "Move Terminal into Editor Area"). The live
   *  PTY survives the move; the terminal leaves the panel (no double
   *  mount) and the panel closes if it empties. */
  promoteTerminalToEditor: (termId: string) => void;
  /** Inverse of `promoteTerminalToEditor` — "Move Terminal into Panel".
   *  Pull a terminal living as a center editor tab back into the bottom
   *  Terminal panel as its own group (opening the panel if needed). The
   *  live PTY survives; the terminal leaves the editor split so it never
   *  double-mounts. No-op-but-focus when it's already a panel terminal. */
  demoteTerminalToPanel: (termId: string) => void;
  setSplitLayout: (panes: WorkPaneRef[], direction: WorkSplitDirection) => void;
  /** Restore a full split tree wholesale. Used at app boot to apply
   *  the persisted layout from localStorage without losing the per-pane
   *  tab structure that flat panes would erase. */
  setSplitLayoutTree: (tree: WorkSplitTree) => void;
  addSplitPane: (ref: WorkPaneRef) => void;
  /** Append an empty pane in the existing split (no-op if no split).
   *  Returns the generated empty-pane id so the caller can scroll/focus. */
  addEmptySplitPane: () => string | null;
  /** Begin a split by spawning an empty sibling next to `source`. The
   *  caller passes the source pane ref (the one the user clicked Split
   *  on). Returns the empty pane's id. */
  splitWithEmpty: (source: WorkPaneRef, direction: WorkSplitDirection) => string;
  /** Replace the pane at `index` with a new ref. Used by EmptyPanePicker
   *  to drop a chosen tab into the empty slot without recreating the
   *  layout. */
  replaceSplitPaneAt: (index: number, ref: WorkPaneRef) => void;
  /** Reorder split panes — drag handle moves pane from `srcIndex` to
   *  `dstIndex`. */
  reorderSplitPanes: (srcIndex: number, dstIndex: number) => void;
  /** Reorder tab strips by drag (Stage 9H). */
  reorderAgentTabs: (srcIndex: number, dstIndex: number) => void;
  reorderTerminalTabs: (srcIndex: number, dstIndex: number) => void;
  /** Persist the backend pty id a terminal is bound to, for next-launch
   *  daemon reconnect (`reconnectId`). Set by the Terminal component's
   *  `onOpened`. */
  setTerminalDaemonSession: (termId: string, daemonSessionId: string) => void;
  reorderManagerTabs: (srcIndex: number, dstIndex: number) => void;
  reorderFileTabs: (srcIndex: number, dstIndex: number) => void;
  /** Per-pane tab list mutators (Stage 9I). Used by per-pane tab strips
   *  in WorkSurface and by the cross-workspace add affordance to pull a
   *  tab from another workspace into this pane. */
  addTabToPane: (paneId: string, ref: WorkPaneRef) => void;
  setActiveTabInPane: (paneId: string, index: number) => void;
  closeTabInPane: (paneId: string, index: number) => void;
  /** Reopen the most-recently-closed reopenable tab (⌘⇧T). No-op when the
   *  reopen stack is empty. Files reload their buffer; view tabs re-query. */
  reopenClosedTab: () => void;
  /** Drag-and-drop a tab from one pane to another. */
  moveTabBetweenPanes: (srcPaneId: string, srcIndex: number, dstPaneId: string) => void;
  removeSplitPane: (index: number) => void;
  setSplitDirection: (direction: WorkSplitDirection) => void;
  clearSplitLayout: () => void;
  openManager: (sessionId: string, label: string) => void;
  closeManager: (sessionId: string) => void;
  setActiveManager: (sessionId: string) => void;
  /** Plan tab mutators (Stage 11.4). `openPlan` registers the plan
   *  data + opens it in the active leaf (or creates a fresh top-level
   *  leaf if no split layout exists yet). `togglePlanTodo` flips the
   *  done flag locally — the brain owns the canonical task graph, but
   *  letting the user check items off in the UI matches Cursor's plan
   *  surface. */
  openPlan: (
    plan: {
      id: string;
      title: string;
      summary: string;
      objective?: string;
      baseline?: string;
      architectureMermaid?: string;
      phases?: PlanPhase[];
      deliverables?: string[];
      tests?: string[];
      pendingPlanId?: string | null;
      todos: {
        description: string;
        agent: string | null;
        fileRefs?: string[];
        assignee?: string | null;
        suggestedProvider?: {
          providerId: string;
          score: number;
          sampleCount: number;
        } | null;
        goal?: string | null;
        acceptance?: string[];
        subtasks?: {
          description: string;
          agent?: string | null;
          goal?: string | null;
          acceptance?: string[];
        }[];
      }[];
    },
    repoRoot?: string | null,
    sessionId?: string | null,
  ) => void;
  closePlan: (planId: string) => void;
  setActivePlan: (planId: string) => void;
  togglePlanTodo: (planId: string, todoIndex: number) => void;
  openInspector: () => void;
  closeInspector: () => void;
  setActiveInspector: () => void;
  openReplay: () => void;
  closeReplay: () => void;
  setActiveReplay: () => void;
  openPlanBuilder: () => void;
  closePlanBuilder: () => void;
  setActivePlanBuilder: () => void;
  openProve: () => void;
  closeProve: () => void;
  setActiveProve: () => void;
  openGraph: () => void;
  closeGraph: () => void;
  setActiveGraph: () => void;
  openPrDetail: (repoRoot: string, number: number, title: string) => void;
  closePrDetail: () => void;
  setActivePrDetail: () => void;
  closePrTab: (tabId: string) => void;
  setActivePrTab: (tabId: string) => void;
  /** Stage 8N derived shims — kept so legacy callers using
   *  `editor.selectedPr / .activePrDetail / .prDetailOpen /
   *  .prDetailFromInbox` keep working without the migration touching
   *  every consumer. Computed from prTabs + activePrTabId. */
  selectedPr: PrTab | null;
  activePrDetail: boolean;
  prDetailOpen: boolean;
  prDetailFromInbox: boolean;
  openInbox: () => void;
  closeInbox: () => void;
  setActiveInbox: () => void;
  /** Open the Trace v2 surface (no-op when `TRACE_V2` is off). `view`
   *  picks the landing sub-view — Overview (default) or the Sessions list. */
  openSessions: (view?: TraceView) => void;
  /** Open a Trace verify tool as a center page (Review / Rewind /
   *  Attestations / Doctor). Replaces the old modal dialogs. `arg`
   *  prefills Rewind from a symbol's right-click menu. */
  openTraceTool: (tool: TraceToolKind, arg?: { identifier?: string; file?: string }) => void;
  closeTraceTool: () => void;
  /** Promote the Tasks board to a first-class workpane tab keyed by
   *  repoRoot. Focuses an existing tab or appends a new one. */
  openTasks: (repoRoot: string) => void;
  closeTasks: (repoRoot: string) => void;
  /** Open a single task as its own Plane-style detail workpane tab.
   *  `taskId` is the row id; `repoRoot` is the repo the task lives in.
   *  Idempotent — focuses an existing tab for the same task. */
  openTaskDetail: (taskId: string, repoRoot: string) => void;
  closeTaskDetail: (taskId: string) => void;
  /** Ask TasksBoard to promote a task from the read-mode detail pane
   *  into the stepped editor. Works whether the detail is mounted
   *  board-local or as its own workpane tab (see requestTaskEdit). */
  requestTaskEdit: (taskId: string, repoRoot: string) => void;
  /** Consumed by TasksBoard on mount to pick up a pending edit request
   *  fired while the board wasn't mounted (detail was a full tab). */
  consumePendingTaskEdit: (repoRoot: string) => string | null;
  /** Same for the per-repo Standup view. */
  openStandup: (repoRoot: string) => void;
  closeStandup: (repoRoot: string) => void;
  /** Per-repo Automations view (orchestration runs + saved presets). */
  openAutomations: (repoRoot: string) => void;
  closeAutomations: (repoRoot: string) => void;
  /** Per-repo Team chat in the center pane (full CommsPanel). */
  openChannels: (repoRoot: string) => void;
  closeChannels: (repoRoot: string) => void;
  /** Per-repo Commons surface (Lounge + Plugin Exchange), full center width. */
  openCommons: (repoRoot: string) => void;
  closeCommons: (repoRoot: string) => void;
  /** Full-surface plugin mini-app pane. `appKey` = `<pluginId>:<appId>`. */
  openApp: (appKey: string) => void;
  closeApp: (appKey: string) => void;
  /** V.Y.4 — open the active huddle's screenshare as a workpane tab.
   *  `huddleKey` = `<repoRoot>::<channel>`. CallPanel auto-fires this
   *  when a new screenshare track shows up. */
  openScreenshare: (huddleKey: string) => void;
  closeScreenshare: (huddleKey: string) => void;
  /** RR.3 — open the Pages (notes/wiki) surface as a workpane tab
   *  keyed by repo root. Replaces the legacy full-screen overlay. */
  openPages: (repoRoot: string) => void;
  closePages: (repoRoot: string) => void;
  setActiveDashboard: () => void;
  reloadFromDisk: (path: string) => Promise<void>;
  setSidebarTab: (tab: "sessions" | "code") => void;
  setCodeSubPill: (pill: "files" | "git" | "prs") => void;
} {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }, []);

  return {
    ...state,
    open: openFile,
    close: closeFile,
    closeAll,
    switchWorkspace,
    enterClub,
    exitClub,
    setActive,
    updateBuffer,
    saveActive,
    isDirty: (path) => {
      const f = state.files.find((x) => x.path === path);
      return !!f && f.current !== f.baseline;
    },
    openAgent,
    replaceAgent,
    closeAgent,
    stopAndCloseAgent,
    bindAgentResumeSession,
    setActiveAgent,
    setAgentView,
    markAgentAttention,
    clearAgentAttention,
    openTerminal,
    closeTerminal,
    setActiveTerminal,
    openPanelTerminal,
    selectPanelTerminal,
    selectPanelGroup,
    splitPanelTerminal,
    mergeTerminalIntoGroup,
    setTerminalPanelOpen,
    toggleTerminalPanel,
    promoteTerminalToEditor,
    demoteTerminalToPanel,
    setSplitLayout,
    setSplitLayoutTree,
    addSplitPane,
    addEmptySplitPane,
    splitWithEmpty,
    openFileSplit,
    replaceSplitPaneAt,
    reorderSplitPanes,
    reorderAgentTabs,
    reorderTerminalTabs,
    setTerminalDaemonSession,
    reorderManagerTabs,
    reorderFileTabs,
    addTabToPane,
    setActiveTabInPane,
    closeTabInPane,
    reopenClosedTab,
    moveTabBetweenPanes,
    removeSplitPane,
    setSplitDirection,
    clearSplitLayout,
    openManager,
    closeManager,
    setActiveManager,
    openPlan,
    closePlan,
    setActivePlan,
    togglePlanTodo,
    openInspector,
    closeInspector,
    setActiveInspector,
    openReplay,
    closeReplay,
    setActiveReplay,
    openPlanBuilder,
    closePlanBuilder,
    setActivePlanBuilder,
    openProve,
    closeProve,
    setActiveProve,
    openGraph,
    closeGraph,
    setActiveGraph,
    openPrDetail,
    closePrDetail,
    setActivePrDetail,
    closePrTab,
    setActivePrTab,
    // Stage 8N derived shims — see type comment above.
    selectedPr:
      state.prTabs.find((t) => t.tabId === state.activePrTabId) ?? null,
    activePrDetail: state.activePrTabId !== null,
    prDetailOpen: state.prTabs.length > 0,
    prDetailFromInbox:
      state.prTabs.find((t) => t.tabId === state.activePrTabId)?.fromInbox ??
      false,
    openInbox,
    closeInbox,
    setActiveInbox,
    openSessions,
    openTraceTool,
    closeTraceTool,
    openTasks,
    closeTasks,
    openTaskDetail,
    closeTaskDetail,
    requestTaskEdit,
    consumePendingTaskEdit,
    openStandup,
    closeStandup,
    openAutomations,
    closeAutomations,
    openChannels,
    closeChannels,
    openCommons,
    closeCommons,
    openApp,
    closeApp,
    openScreenshare,
    closeScreenshare,
    openPages,
    closePages,
    setActiveDashboard,
    reloadFromDisk,
    setSidebarTab,
    setCodeSubPill,
  };
}

export function setSidebarTab(tab: "sessions" | "code") {
  if (state.sidebarTab === tab) return;
  persistSidebarTab(tab);
  setState({ ...state, sidebarTab: tab });
}

export function setCodeSubPill(pill: "files" | "git" | "prs") {
  if (state.codeSubPill === pill) return;
  persistCodeSubPill(pill);
  setState({ ...state, codeSubPill: pill });
}

// Re-read an open file from disk and update both baseline + current
// when the buffer is clean. If the user has unsaved edits we leave the
// buffer alone (keeps their work) but refresh baseline so the diff
// renders against the latest disk content. External-edit collision
// detection (prompt to merge) can layer on later if it becomes a real
// problem in practice.
async function reloadFromDisk(path: string) {
  const idx = state.files.findIndex((f) => f.path === path);
  if (idx < 0) return;
  const cur = state.files[idx];
  let content;
  try {
    content = await api.readFile(path);
  } catch {
    return;
  }
  const next = state.files.slice();
  if (cur.current === cur.baseline) {
    next[idx] = {
      ...cur,
      baseline: content.text,
      current: content.text,
      size: content.size,
      status: content.status,
      language: content.language,
    };
  } else {
    next[idx] = { ...cur, baseline: content.text };
  }
  setState({ ...state, files: next });
}

export async function openFileImperative(
  path: string,
  opts?: { defaultView?: "edit" | "diff" },
) {
  return openFile(path, opts);
}

/** Read the currently focused Manager session id without subscribing.
 *  Used by fire-and-forget callers (e.g. plan-tab open pushing context
 *  into the brain) that can't be React hooks. */
export function getActiveManagerSessionId(): string | null {
  return state.activeManagerId;
}

async function openFile(path: string, opts?: { defaultView?: "edit" | "diff" }) {
  const existing = state.files.find((f) => f.path === path);
  const fileRef: WorkPaneRef = { kind: "file", path };

  // When a split layout is active, the legacy `activePath` flag alone is
  // ignored by the split-render path — it only walks the layout tree. So
  // a file-tree click while split + terminal (or split + agent) is up
  // would update activePath but the surface kept showing the split's
  // current contents. Mirror the file ref into the layout so the click
  // actually surfaces the file. Prefer the leaf that owns the currently-
  // active ref; fall back to leaves[0] so the file always lands SOMEWHERE
  // visible.
  function syncIntoSplit(layout: WorkSplitTree): WorkSplitTree {
    if (treeContains(layout, fileRef)) {
      const owner = treeFindLeafByRef(layout, fileRef);
      if (owner) {
        const idx = owner.tabs.findIndex((r) => samePaneRef(r, fileRef));
        return treeSetActiveTab(layout, owner.paneId, idx);
      }
      return layout;
    }
    let targetPaneId: string | null = null;
    const activeRef: WorkPaneRef | null = state.activePath
      ? { kind: "file", path: state.activePath }
      : state.activeAgentId
        ? { kind: "agent", id: state.activeAgentId }
        : state.activeTermId
          ? { kind: "terminal", id: state.activeTermId }
          : state.activeManagerId
            ? { kind: "manager", id: state.activeManagerId }
            : null;
    if (activeRef) {
      const owner = treeFindLeafByRef(layout, activeRef);
      if (owner) targetPaneId = owner.paneId;
    }
    if (!targetPaneId) {
      const leaves = treeLeafNodes(layout);
      targetPaneId = leaves[0]?.paneId ?? null;
    }
    if (!targetPaneId) return layout;
    return treeAddTab(layout, targetPaneId, fileRef, true);
  }

  if (existing) {
    const nextLayout = state.splitLayout
      ? syncIntoSplit(state.splitLayout)
      : state.splitLayout;
    if (opts?.defaultView && existing.defaultView !== opts.defaultView) {
      const idx = state.files.findIndex((f) => f.path === path);
      const next = state.files.slice();
      next[idx] = { ...next[idx], defaultView: opts.defaultView };
      setState({
        ...state,
        files: next,
        splitLayout: nextLayout,
        activePath: path,
        activeAgentId: null,
        activeTermId: null,
        activeManagerId: null,
      });
      return;
    }
    setState({
      ...state,
      splitLayout: nextLayout,
      activePath: path,
      activeAgentId: null,
      activeTermId: null,
      activeManagerId: null,
    });
    return;
  }
  const content = await api.readFile(path);
  const name = path.split("/").pop() ?? path;
  const file: OpenFile = {
    path,
    name,
    language: content.language,
    baseline: content.text,
    current: content.text,
    size: content.size,
    status: content.status,
    defaultView: opts?.defaultView,
  };
  const nextLayout = state.splitLayout
    ? syncIntoSplit(state.splitLayout)
    : state.splitLayout;
  setState({
    ...state,
    files: [...state.files, file],
    splitLayout: nextLayout,
    activePath: path,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
  });
}

// ─── per-workspace snapshot + switch ───────────────────────────────
//
// Workspace switching: serialize `prev`'s tabs into its slot, wipe live
// state, hydrate from `next`'s slot. Bypasses `setState` so the
// existing per-key persistence (agents per-repo, manager global, split
// global) doesn't mis-fire on the transient empty state in between —
// the snapshot writer is the canonical source of truth for the switch.

function buildSnapshotFromState(s: State): WorkspaceSnapshot {
  return {
    v: 1,
    filePaths: s.files.map((f) => f.path),
    agentTabs: s.agentTabs,
    terminalTabs: s.terminalTabs,
    managerTabs: s.managerTabs,
    planTabs: s.planTabs,
    prTabs: s.prTabs,
    // Persist only real documents/sessions — section/nav surfaces are stripped
    // (EPHEMERAL_SURFACE_KINDS) so they can't resurrect as phantom tabs. The
    // live in-session tree (s.splitLayout) is untouched; only the saved copy
    // is filtered.
    splitLayout: s.splitLayout ? sanitizeTreeForPersist(s.splitLayout) : null,
    terminalGroups: s.terminalGroups,
    panelActiveGroupId: s.panelActiveGroupId,
    panelActiveTermId: s.panelActiveTermId,
    terminalPanelOpen: s.terminalPanelOpen,
    activePath: s.activePath,
    activeAgentId: s.activeAgentId,
    activeTermId: s.activeTermId,
    activeManagerId: s.activeManagerId,
    activePlanId: s.activePlanId,
    activePrTabId: s.activePrTabId,
    inspectorOpen: s.inspectorOpen,
    activeInspector: s.activeInspector,
    replayOpen: s.replayOpen,
    activeReplay: s.activeReplay,
    planBuilderOpen: s.planBuilderOpen,
    activePlanBuilder: s.activePlanBuilder,
    proveOpen: s.proveOpen,
    activeProve: s.activeProve,
    graphOpen: s.graphOpen,
    activeGraph: s.activeGraph,
    inboxOpen: s.inboxOpen,
    activeInbox: s.activeInbox,
    activeDashboard: s.activeDashboard,
    activeSessions: s.activeSessions,
  };
}

/** Hydrate the bottom Terminal Panel's groups model from a snapshot,
 *  migrating legacy snapshots (which carried `terminalTabs` but no
 *  `terminalGroups`) to one solo group per terminal tab. Drops any dead
 *  refs / empty groups defensively so a stale snapshot can't render a
 *  group whose terminals no longer exist. Re-points the panel focus onto
 *  a surviving group/term. */
function restorePanelGroups(snap: WorkspaceSnapshot): {
  terminalGroups: TerminalGroup[];
  panelActiveGroupId: string | null;
  panelActiveTermId: string | null;
} {
  const liveIds = new Set(snap.terminalTabs.map((t) => t.termId));
  let groups: TerminalGroup[] = [];
  if (snap.terminalGroups && snap.terminalGroups.length > 0) {
    for (const g of snap.terminalGroups) {
      // Prune refs whose terminal tab no longer exists; skip emptied groups.
      let layout: WorkSplitTree | null = g.layout;
      for (const leaf of treeLeafNodes(g.layout)) {
        for (const ref of leaf.tabs) {
          if (ref.kind === "terminal" && !liveIds.has(ref.id) && layout) {
            layout = treeRemove(layout, ref);
          }
        }
      }
      if (!layout) continue;
      const activeAlive =
        treeFindLeafByRef(layout, { kind: "terminal", id: g.activeTermId }) != null;
      const firstRef = treeLeafNodes(layout)
        .flatMap((l) => l.tabs)
        .find((r) => r.kind === "terminal");
      const activeTermId = activeAlive
        ? g.activeTermId
        : firstRef && firstRef.kind === "terminal"
          ? firstRef.id
          : g.activeTermId;
      groups.push({ ...g, layout, activeTermId });
    }
  } else {
    // Legacy migration: one solo group per terminal tab (the old model
    // had a single shared `terminalPanelLayout`; we don't try to recover
    // its split arrangement — each terminal comes back in its own row).
    groups = snap.terminalTabs.map((t) => ({
      groupId: newGroupId(),
      layout: makeLeaf([{ kind: "terminal", id: t.termId }]),
      activeTermId: t.termId,
    }));
  }
  let panelActiveGroupId = snap.panelActiveGroupId ?? null;
  if (panelActiveGroupId == null || !groups.some((g) => g.groupId === panelActiveGroupId)) {
    panelActiveGroupId = groups[0]?.groupId ?? null;
  }
  const activeGroup = groups.find((g) => g.groupId === panelActiveGroupId) ?? null;
  let panelActiveTermId = snap.panelActiveTermId ?? null;
  if (panelActiveTermId == null || findPanelGroupOf(groups, panelActiveTermId) == null) {
    panelActiveTermId = activeGroup?.activeTermId ?? null;
  }
  return { terminalGroups: groups, panelActiveGroupId, panelActiveTermId };
}

function switchWorkspace(prev: string | null, next: string) {
  // 1) Persist outgoing workspace's tab state, if any.
  if (prev) {
    saveSnapshot(prev, buildSnapshotFromState(state));
  }
  // Bind the snapshot writer to the incoming workspace immediately, before the
  // wipe/hydrate below, so any post-switch setState persists into `next`'s slot
  // (never the outgoing root). In-memory so it's race-free vs App.tsx writing
  // `aura.lastWorkspace`.
  activeRoot = next;

  // 2) Wipe everything to defaults. Files come back via openFile, not
  //    by carrying buffers across (they could be stale; disk is truth).
  const wiped: State = {
    files: [],
    agentTabs: [],
    terminalTabs: [],
    managerTabs: [],
    planTabs: [],
    closedTabs: [],
    prTabs: [],
    splitLayout: null,
    terminalGroups: [],
    panelActiveGroupId: null,
    terminalPanelOpen: false,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    panelActiveTermId: null,
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
    activeInbox: false, activeSessions: false, traceTool: null, traceToolArg: null,
    activeDashboard: false,
    traceView: "overview",
    sidebarTab: state.sidebarTab,
    codeSubPill: state.codeSubPill,
  };

  // 3) Hydrate from incoming workspace's snapshot if we have one.
  const restored = loadSnapshot(next);
  if (restored) {
    const panel = restorePanelGroups(restored);
    state = {
      ...wiped,
      // filePaths are restored by App.tsx via openFile (it owns the
      // backend read). The snapshot's filePaths get re-applied as soon
      // as App finishes loading the project; we don't hydrate
      // `state.files` directly here because OpenFile carries a
      // baseline buffer that requires the disk read.
      agentTabs: restored.agentTabs.map(markAgentDormant),
      terminalTabs: restored.terminalTabs,
      managerTabs: restored.managerTabs,
      planTabs: restored.planTabs,
      prTabs: restored.prTabs,
      // #222 — sanitize the restored tree the SAME way `hydrateFromSnapshot`
      // does (strip section/nav surfaces, obey flag gates) so both restore
      // paths produce one identical model instead of a raw passthrough here
      // and a validated tree there.
      splitLayout: restored.splitLayout ? validateTree(restored.splitLayout) : null,
      terminalGroups: panel.terminalGroups,
      panelActiveGroupId: panel.panelActiveGroupId,
      panelActiveTermId: panel.panelActiveTermId,
      terminalPanelOpen: restored.terminalPanelOpen ?? false,
      activePath: restored.activePath,
      activeAgentId: restored.activeAgentId,
      activeTermId: restored.activeTermId,
      activeManagerId: restored.activeManagerId,
      activePlanId: restored.activePlanId,
      activePrTabId: restored.activePrTabId,
      inspectorOpen: restored.inspectorOpen,
      activeInspector: restored.activeInspector,
      replayOpen: restored.replayOpen,
      activeReplay: restored.activeReplay,
      planBuilderOpen: restored.planBuilderOpen,
      activePlanBuilder: restored.activePlanBuilder,
      proveOpen: restored.proveOpen,
      activeProve: restored.activeProve,
      graphOpen: CODE_MAP_ENABLED && restored.graphOpen,
      activeGraph: CODE_MAP_ENABLED && restored.activeGraph,
      inboxOpen: restored.inboxOpen,
      activeInbox: restored.activeInbox,
      activeDashboard: restored.activeDashboard,
      activeSessions: TRACE_V2 && restored.activeSessions,
    };
  } else {
    state = wiped;
  }
  emit();
}

/** File paths the active workspace's snapshot wants re-opened. App
 *  reads this right after `switchWorkspace` and replays them via
 *  `openFile` (which owns the backend disk read). */
export function pendingFilePaths(repoRoot: string): string[] {
  return loadSnapshot(repoRoot)?.filePaths ?? [];
}

/** File paths to re-open when entering the club. Reads from the club
 *  slot first; if no slot exists yet, falls back to a union of every
 *  member's pending paths so first-time entry isn't empty. */
export function pendingFilePathsForClub(members: string[]): string[] {
  const club = loadClubSnapshot();
  if (club) return club.filePaths;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    for (const p of pendingFilePaths(m)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function emptyState(): State {
  return {
    files: [],
    agentTabs: [],
    terminalTabs: [],
    closedTabs: [],
    managerTabs: [],
    planTabs: [],
    prTabs: [],
    splitLayout: null,
    terminalGroups: [],
    panelActiveGroupId: null,
    terminalPanelOpen: false,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    panelActiveTermId: null,
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
    activeInbox: false, activeSessions: false, traceTool: null, traceToolArg: null,
    activeDashboard: false,
    traceView: "overview",
    sidebarTab: state?.sidebarTab ?? readSidebarTab(),
    codeSubPill: state?.codeSubPill ?? readCodeSubPill(),
  };
}

/** Stamp restored-from-disk agent tabs as dormant (cold). Restoring a
 *  workspace must never silently relaunch a Claude PTY — a dormant tab
 *  whose process is gone renders a click-to-start affordance instead of
 *  auto-respawning at mount. Harmless when the PTY is actually still
 *  alive (same-session switch-back): the view attaches normally and
 *  ignores the flag. Cleared the moment the agent is started. */
function markAgentDormant(t: AgentTab): AgentTab {
  return { ...t, dormant: true };
}

function hydrateFromSnapshot(snap: WorkspaceSnapshot): State {
  const panel = restorePanelGroups(snap);
  return {
    ...emptyState(),
    agentTabs: snap.agentTabs.map(markAgentDormant),
    terminalTabs: snap.terminalTabs,
    managerTabs: snap.managerTabs,
    planTabs: snap.planTabs,
    prTabs: snap.prTabs,
    // Run the restored tree through validateTree so stale section/nav surfaces
    // are stripped (self-heals snapshots written before this fix) and
    // flag-gated panes (manager/sessions/graph) obey their current flags —
    // the raw passthrough used to bypass both.
    splitLayout: snap.splitLayout ? validateTree(snap.splitLayout) : null,
    terminalGroups: panel.terminalGroups,
    panelActiveGroupId: panel.panelActiveGroupId,
    panelActiveTermId: panel.panelActiveTermId,
    terminalPanelOpen: snap.terminalPanelOpen ?? false,
    activePath: snap.activePath,
    activeAgentId: snap.activeAgentId,
    activeTermId: snap.activeTermId,
    activeManagerId: snap.activeManagerId,
    activePlanId: snap.activePlanId,
    activePrTabId: snap.activePrTabId,
    // Section/nav surfaces never pre-open on reload. Their canonical state is
    // the (already section-filtered) split tree; these legacy "open" booleans
    // are only a live Trace-rail mirror. Restoring them used to redraw phantom
    // Goals / Code Map / Change story / Proof trail / Inbox / Sessions pills
    // via the global Tabs strip — a second channel for the same bug. Force
    // them cold; the setters re-arm them when the user opens one this session.
    inspectorOpen: false,
    activeInspector: false,
    replayOpen: false,
    activeReplay: false,
    // Plan Builder is a work-in-progress wizard buffer, not a nav section —
    // it legitimately survives a reload so the user doesn't lose the draft.
    planBuilderOpen: snap.planBuilderOpen,
    activePlanBuilder: snap.activePlanBuilder,
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

function enterClub(prev: string | null, members: string[]) {
  // 1) Persist outgoing concrete workspace's tabs to its own slot.
  //    Skip when `prev` is null (boot-time entry) — the in-memory state
  //    is empty so writing it would clobber any existing snapshot.
  if (prev) {
    saveSnapshot(prev, buildSnapshotFromState(state));
  }

  // 2) Resolve the club snapshot. First entry has no club slot yet, so
  //    we seed by unioning each member's snapshot — the user enters the
  //    club already seeing every member's tabs, which matches the
  //    "clubbed view = both workspaces visible" expectation.
  let club = loadClubSnapshot();
  if (!club) {
    const parts = members
      .map((m) => loadSnapshot(m))
      .filter((s): s is WorkspaceSnapshot => !!s);
    if (parts.length > 0) {
      club = unionSnapshots(parts);
      saveClubSnapshot(club);
    }
  }
  state = club ? hydrateFromSnapshot(club) : emptyState();
  emit();
}

function exitClub(next: string) {
  // 1) Persist the unioned tab state to the club slot so re-entering
  //    later sees the same surface (including any new tabs the user
  //    opened while in club mode).
  saveClubSnapshot(buildSnapshotFromState(state));

  // 2) Hydrate from the target workspace's own slot exactly the way a
  //    plain `switchWorkspace` would. The target snapshot wasn't
  //    touched while the user was in club mode, so the workspace
  //    returns to its pre-club state — clean separation.
  const restored = loadSnapshot(next);
  state = restored ? hydrateFromSnapshot(restored) : emptyState();
  emit();
}

function closeAll() {
  if (
    state.files.length === 0 &&
    // Stage 9B — agent + terminal tabs now survive workspace switches
    // (same as managerTabs). Files are still wiped because file refs are
    // workspace-scoped (relative paths under repoRoot would collide).
    state.activePath === null
  )
    return;
  // Bypass setState's persistence diff — closeAll fires on workspace
  // switch (loadProjectAt closes the old workspace's tabs before opening
  // the new one's). Routing through setState would see the old root's
  // agents disappear from the next snapshot and wipe its localStorage,
  // making the prior workspace come back empty when the user switches
  // back to it. Persistence stays in lockstep with explicit user actions
  // (openAgent / closeAgent / replaceAgent), not workspace transitions.
  // Stage 9B — keep agentTabs/terminalTabs/splitLayout alive so a split
  // built across workspaces survives the switch. Active focus resets to
  // dashboard; the user can pick a tab back up explicitly. Files are
  // wiped because file refs are workspace-scoped (relative paths). Any
  // file pane in the splitLayout simply fails to resolve and the split
  // hides itself — re-opening the file restores the layout.
  state = {
    ...state,
    files: [],
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeDashboard: false,
  };
  emit();
}

function closeFile(path: string) {
  const idx = state.files.findIndex((f) => f.path === path);
  if (idx < 0) return;
  const next = state.files.slice();
  next.splice(idx, 1);
  let activePath = state.activePath;
  let activeAgentId = state.activeAgentId;
  let activeTermId = state.activeTermId;
  if (activePath === path) {
    // Fall back to the previous file tab; if none, fall back to the first
    // agent tab so the work surface stays populated when the user closes
    // their last file.
    const prev = next[Math.max(0, idx - 1)] ?? null;
    if (prev) {
      activePath = prev.path;
      activeAgentId = null;
      activeTermId = null;
    } else if (state.agentTabs.length > 0) {
      activePath = null;
      activeAgentId = state.agentTabs[state.agentTabs.length - 1].sessionId;
      activeTermId = null;
    } else if (state.terminalTabs.length > 0) {
      activePath = null;
      activeAgentId = null;
      activeTermId = state.terminalTabs[state.terminalTabs.length - 1].termId;
    } else {
      activePath = null;
    }
  }
  setState({
    ...state,
    closedTabs: rememberClosedTab({ kind: "file", path }),
    files: next,
    splitLayout: state.splitLayout
      ? treeRemove(state.splitLayout, { kind: "file", path })
      : null,
    activePath,
    activeAgentId,
    activeTermId,
  });
}

function setActive(path: string) {
  if (
    state.activePath === path &&
    state.activeAgentId === null &&
    state.activeTermId === null &&
    state.activeManagerId === null &&
    state.activePlanId === null &&
    !state.activeInspector &&
    !state.activeReplay &&
    !state.activePlanBuilder &&
    !state.activeProve &&
    !state.activeGraph
  )
    return;
  setState({ ...state, activePath: path, activeAgentId: null, activeTermId: null, activeManagerId: null, activeInspector: false, activeReplay: false, activePlanBuilder: false, activeProve: false, activeGraph: false, activeDashboard: false, activePlanId: null, activePrTabId: null, activeInbox: false, activeSessions: false, traceTool: null });
}

function updateBuffer(path: string, text: string) {
  const idx = state.files.findIndex((f) => f.path === path);
  if (idx < 0) return;
  const next = state.files.slice();
  next[idx] = { ...next[idx], current: text };
  setState({ ...state, files: next });
}

async function saveActive() {
  const active = state.files.find((f) => f.path === state.activePath);
  if (!active) return;
  if (active.current === active.baseline) return;
  await api.writeFile(active.path, active.current);
  // Promote current to new baseline so dirty flips off and the diff
  // baseline updates to match disk.
  const idx = state.files.findIndex((f) => f.path === active.path);
  if (idx < 0) return;
  const next = state.files.slice();
  next[idx] = { ...next[idx], baseline: next[idx].current };
  setState({ ...state, files: next });
}

function openAgent(
  tab: Omit<AgentTab, "view" | "mode"> & {
    view?: "ui" | "terminal";
    mode?: "stream" | "pty" | "chat";
  },
) {
  // Default mode is "pty" — every interactive agent CLI we ship
  // (claude, gemini, codex, cursor-agent) is a full TUI; bubble-UI
  // parsing of stream-json was a bug factory (chat-turn glue, stale
  // resume crash, lost tool renders) and fights the agent's native
  // surface (slash commands, vim mode, file picker). Stream mode is
  // kept reachable as opt-in for legacy callers but no surface
  // selects it by default. "chat" is the new HTTP adapter for
  // openai-compat endpoints (Ollama / HF / Together / Groq / …) —
  // hosted entirely in JS, no PTY.
  const mode = tab.mode ?? "pty";
  const view = tab.view ?? (mode === "pty" ? "terminal" : "ui");
  const existing = state.agentTabs.find((t) => t.sessionId === tab.sessionId);
  if (existing) {
    // Just focus — never overwrite the user's chosen view on a re-open.
    // When a split is live, also fold the agent into the active leaf so
    // its pill is visible (the split path hides the global strip).
    setState({
      ...state,
      splitLayout: state.splitLayout
        ? focusRefInLayout(state.splitLayout, { kind: "agent", id: tab.sessionId })
        : state.splitLayout,
      activeAgentId: tab.sessionId,
      activePath: null,
      activeTermId: null,
      activeManagerId: null,
      activePlanId: null,
    });
    return;
  }
  const next: AgentTab = {
    sessionId: tab.sessionId,
    agentId: tab.agentId,
    agentLabel: tab.agentLabel,
    agentMonogram: tab.agentMonogram,
    repoRoot: tab.repoRoot,
    view,
    mode,
    openaiCompatProfile: tab.openaiCompatProfile,
    dormant: tab.dormant,
    resumeSessionId: tab.resumeSessionId,
  };
  setState({
    ...state,
    agentTabs: [...state.agentTabs, next],
    splitLayout: state.splitLayout
      ? focusRefInLayout(state.splitLayout, { kind: "agent", id: next.sessionId })
      : state.splitLayout,
    activeAgentId: next.sessionId,
    activePath: null,
    activeTermId: null,
    activeManagerId: null,
    activePlanId: null,
  });
}

/** The workspace root this shell is bound to right now. Additive export for
 *  launch glue (Parity W8) that must decide focus-vs-passive tab placement
 *  without reaching into App.tsx's project state. */
export function getActiveWorkspaceRoot(): string | null {
  return currentWorkspaceRoot();
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

/** Append an agent tab WITHOUT stealing focus when it belongs to a workspace
 *  other than the active one (Parity W8 launch manifest). A fleet launched
 *  into a fresh worktree must not yank the user out of what they're doing —
 *  tabs land passively and surface via the workspace-exclusive strip + fleet
 *  pips when the user switches over. Same-workspace launches delegate to
 *  `openAgent` so the normal focus behavior applies. Duplicate sessionIds are
 *  left untouched (passive means passive — no focus side effects). */
export function appendAgentTabPassive(
  tab: Omit<AgentTab, "view" | "mode"> & {
    view?: "ui" | "terminal";
    mode?: "stream" | "pty" | "chat";
  },
) {
  const here = currentWorkspaceRoot();
  if (here && stripTrailingSlash(here) === stripTrailingSlash(tab.repoRoot)) {
    openAgent(tab);
    return;
  }
  if (state.agentTabs.some((t) => t.sessionId === tab.sessionId)) return;
  const mode = tab.mode ?? "pty";
  const view = tab.view ?? (mode === "pty" ? "terminal" : "ui");
  setState({
    ...state,
    agentTabs: [
      ...state.agentTabs,
      {
        sessionId: tab.sessionId,
        agentId: tab.agentId,
        agentLabel: tab.agentLabel,
        agentMonogram: tab.agentMonogram,
        repoRoot: tab.repoRoot,
        view,
        mode,
        openaiCompatProfile: tab.openaiCompatProfile,
        dormant: tab.dormant,
        resumeSessionId: tab.resumeSessionId,
      },
    ],
  });
}

function replaceAgent(
  oldSessionId: string,
  src: Omit<AgentTab, "view" | "mode"> & {
    view?: "ui" | "terminal";
    mode?: "stream" | "pty" | "chat";
  },
) {
  const idx = state.agentTabs.findIndex((t) => t.sessionId === oldSessionId);
  // No matching tab → fall through to a normal open at the end. Keeps
  // the call site tolerant of a stale id (e.g. user closed the tab
  // while the PTY was spawning).
  if (idx < 0) {
    openAgent(src);
    return;
  }
  const mode = src.mode ?? "stream";
  const view = src.view ?? (mode === "stream" ? "ui" : "terminal");
  const replaced: AgentTab = {
    sessionId: src.sessionId,
    agentId: src.agentId,
    agentLabel: src.agentLabel,
    agentMonogram: src.agentMonogram,
    repoRoot: src.repoRoot,
    view,
    mode,
    // Carry the per-tab resume id across the swap. The spawning call site
    // passes the resolved id on `src`; if it didn't, keep whatever the old
    // tab already had so a restart still reopens THIS tab's own session.
    resumeSessionId: src.resumeSessionId ?? state.agentTabs[idx].resumeSessionId,
  };
  const nextTabs = state.agentTabs.slice();
  nextTabs[idx] = replaced;
  const wasActive = state.activeAgentId === oldSessionId;
  const splitLayout = updateSplitRef(
    state.splitLayout,
    { kind: "agent", id: oldSessionId },
    { kind: "agent", id: replaced.sessionId },
  );
  setState({
    ...state,
    agentTabs: nextTabs,
    splitLayout,
    activeAgentId: wasActive ? replaced.sessionId : state.activeAgentId,
    activePath: wasActive ? null : state.activePath,
    activeTermId: wasActive ? null : state.activeTermId,
    activeManagerId: wasActive ? null : state.activeManagerId,
  });
}

// Close an agent tab AND stop its underlying CLI — the default for the tab's
// X button and Cmd-W. `closeAgent` alone only drops the tab, because detach()
// leans on that to hand a *live* session to a popout window; so the kill can't
// live inside closeAgent. It lives here, at the explicit-close call sites, so a
// closed Claude Code (or any agent CLI) never lingers as an orphan process.
function stopAndCloseAgent(sessionId: string): void {
  void api.agentPtyClose(sessionId).catch(() => {});
  closeAgent(sessionId);
}

function closeAgent(sessionId: string) {
  const idx = state.agentTabs.findIndex((t) => t.sessionId === sessionId);
  if (idx < 0) return;
  const next = state.agentTabs.slice();
  next.splice(idx, 1);
  let activeAgentId = state.activeAgentId;
  let activePath = state.activePath;
  let activeTermId = state.activeTermId;
  if (activeAgentId === sessionId) {
    const prev = next[Math.max(0, idx - 1)] ?? null;
    if (prev) {
      activeAgentId = prev.sessionId;
      activePath = null;
      activeTermId = null;
    } else if (state.files.length > 0) {
      activeAgentId = null;
      activePath = state.files[state.files.length - 1].path;
      activeTermId = null;
    } else if (state.terminalTabs.length > 0) {
      activeAgentId = null;
      activePath = null;
      activeTermId = state.terminalTabs[state.terminalTabs.length - 1].termId;
    } else {
      activeAgentId = null;
    }
  }
  setState({
    ...state,
    agentTabs: next,
    splitLayout: state.splitLayout
      ? treeRemove(state.splitLayout, { kind: "agent", id: sessionId })
      : null,
    activeAgentId,
    activePath,
    activeTermId,
  });
}

function bindAgentResumeSession(sessionId: string, resumeSessionId: string) {
  const idx = state.agentTabs.findIndex((t) => t.sessionId === sessionId);
  if (idx < 0) return;
  if (state.agentTabs[idx].resumeSessionId === resumeSessionId) return;
  const next = state.agentTabs.slice();
  next[idx] = { ...next[idx], resumeSessionId };
  setState({ ...state, agentTabs: next });
}

function setActiveAgent(sessionId: string) {
  if (
    // A live split always re-runs so the agent gets folded/focused into
    // the active leaf (the split path ignores activeAgentId).
    state.splitLayout == null &&
    state.activeAgentId === sessionId &&
    state.activePath === null &&
    state.activeTermId === null &&
    state.activeManagerId === null &&
    state.activePlanId === null &&
    !state.activeInspector &&
    !state.activeReplay &&
    !state.activePlanBuilder &&
    !state.activeProve &&
    !state.activeGraph
  )
    return;
  // Auto-clear attention when focusing — user is now looking at the
  // agent that was asking for input.
  const agentTabs = state.agentTabs.map((t) =>
    t.sessionId === sessionId && t.attention ? { ...t, attention: false } : t,
  );
  setState({ ...state, agentTabs, splitLayout: state.splitLayout ? focusRefInLayout(state.splitLayout, { kind: "agent", id: sessionId }) : state.splitLayout, activeAgentId: sessionId, activePath: null, activeTermId: null, activeManagerId: null, activeInspector: false, activeReplay: false, activePlanBuilder: false, activeProve: false, activeGraph: false, activeDashboard: false, activePlanId: null, activePrTabId: null, activeInbox: false, activeSessions: false, traceTool: null });
}

function markAgentAttention(sessionId: string) {
  // No-op if the tab is already active — user can already see it.
  if (state.activeAgentId === sessionId) return;
  let touched = false;
  const agentTabs = state.agentTabs.map((t) => {
    if (t.sessionId === sessionId && !t.attention) {
      touched = true;
      return { ...t, attention: true };
    }
    return t;
  });
  if (touched) setState({ ...state, agentTabs });
}

function clearAgentAttention(sessionId: string) {
  let touched = false;
  const agentTabs = state.agentTabs.map((t) => {
    if (t.sessionId === sessionId && t.attention) {
      touched = true;
      return { ...t, attention: false };
    }
    return t;
  });
  if (touched) setState({ ...state, agentTabs });
}

function openTerminal(
  cwd: string,
  opts?: { bootCommand?: string; label?: string; shell?: string; profileId?: string },
): string {
  const termId = `term-${typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10)}`;
  const next: TerminalTab = {
    termId,
    cwd,
    bootCommand: opts?.bootCommand,
    label: opts?.label,
    shell: opts?.shell,
    profileId: opts?.profileId,
  };
  setState({
    ...state,
    terminalTabs: [...state.terminalTabs, next],
    splitLayout: state.splitLayout
      ? focusRefInLayout(state.splitLayout, { kind: "terminal", id: termId })
      : state.splitLayout,
    activeTermId: termId,
    activePath: null,
    activeAgentId: null,
    activeManagerId: null,
    activePlanId: null,
  });
  return termId;
}

// ── Bottom Terminal Panel (VS Code-style) ────────────────────────────
//
// The panel is a self-contained surface over the shared `terminalTabs`
// list. Its side-list is `terminalGroups` — one row per VS Code
// "terminal group", each owning its OWN split tree. This is the fix for
// "grouped terminals detach when a new terminal is added": a new
// terminal mints a fresh group and never disturbs an existing split, and
// splitting only re-tiles the active group. `panelActiveGroupId` is the
// shown group; `panelActiveTermId` is the focused pane within it — both
// independent of the editor's `activeTermId`, so the panel never blanks
// an open file.

function newTermId(): string {
  return `term-${typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10)}`;
}

function newGroupId(): string {
  return `tgrp-${typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10)}`;
}

/** The group that owns `termId` in its split tree, if any. */
function findPanelGroupOf(
  groups: TerminalGroup[],
  termId: string,
): TerminalGroup | undefined {
  const ref: WorkPaneRef = { kind: "terminal", id: termId };
  return groups.find((g) => treeFindLeafByRef(g.layout, ref) != null);
}

/** Open a terminal INTO the bottom panel (its + button). Adds to the
 *  shared list, mints a NEW side-list group for it, and focuses that
 *  group — existing groups (and their splits) are untouched. */
function openPanelTerminal(
  cwd: string,
  opts?: { bootCommand?: string; label?: string; shell?: string; profileId?: string },
): string {
  const termId = newTermId();
  const next: TerminalTab = {
    termId,
    cwd,
    bootCommand: opts?.bootCommand,
    label: opts?.label,
    shell: opts?.shell,
    profileId: opts?.profileId,
  };
  const groupId = newGroupId();
  const group: TerminalGroup = {
    groupId,
    layout: makeLeaf([{ kind: "terminal", id: termId }]),
    activeTermId: termId,
  };
  setState({
    ...state,
    terminalTabs: [...state.terminalTabs, next],
    terminalGroups: [...state.terminalGroups, group],
    panelActiveGroupId: groupId,
    panelActiveTermId: termId,
  });
  return termId;
}

/** Focus a terminal in the bottom panel. Selects its owning group and
 *  focuses that pane — never destroys any group's layout. */
function selectPanelTerminal(termId: string): void {
  const group = findPanelGroupOf(state.terminalGroups, termId);
  if (!group) {
    // Not in any group (shouldn't happen) — just move panel focus.
    setState({ ...state, panelActiveTermId: termId });
    return;
  }
  const ref: WorkPaneRef = { kind: "terminal", id: termId };
  const groups = state.terminalGroups.map((g) =>
    g.groupId === group.groupId
      ? { ...g, layout: focusRefInLayout(g.layout, ref), activeTermId: termId }
      : g,
  );
  setState({
    ...state,
    terminalGroups: groups,
    panelActiveGroupId: group.groupId,
    panelActiveTermId: termId,
  });
}

/** Focus a whole side-list group (row click). Shows that group's body
 *  and restores its own last-focused pane. */
function selectPanelGroup(groupId: string): void {
  const group = state.terminalGroups.find((g) => g.groupId === groupId);
  if (!group) return;
  setState({
    ...state,
    panelActiveGroupId: groupId,
    panelActiveTermId: group.activeTermId,
  });
}

/** Split the active group's focused pane with a fresh sibling in the
 *  same cwd/shell. Only re-tiles the active group; other groups are
 *  untouched. Caps at `MAX_SPLIT_PANES` per group. */
function splitPanelTerminal(direction: WorkSplitDirection): string | null {
  const groupId = state.panelActiveGroupId;
  if (!groupId) return null;
  const group = state.terminalGroups.find((g) => g.groupId === groupId);
  if (!group) return null;
  const activeId = state.panelActiveTermId ?? group.activeTermId;
  const activeTab = state.terminalTabs.find((t) => t.termId === activeId);
  if (!activeTab) return null;
  if (treeLeafNodes(group.layout).length >= MAX_SPLIT_PANES) return null;
  const termId = newTermId();
  const newTab: TerminalTab = {
    termId,
    cwd: activeTab.cwd,
    shell: activeTab.shell,
    profileId: activeTab.profileId,
  };
  const activeRef: WorkPaneRef = { kind: "terminal", id: activeId };
  const newRef: WorkPaneRef = { kind: "terminal", id: termId };
  const nextLayout = treeSplitAt(group.layout, activeRef, newRef, direction);
  const groups = state.terminalGroups.map((g) =>
    g.groupId === groupId ? { ...g, layout: nextLayout, activeTermId: termId } : g,
  );
  setState({
    ...state,
    terminalTabs: [...state.terminalTabs, newTab],
    terminalGroups: groups,
    panelActiveGroupId: groupId,
    panelActiveTermId: termId,
  });
  return termId;
}

/** Drag an EXISTING terminal into a target group's split (VS Code
 *  drag-and-drop parity — "use an existing terminal as part of the
 *  split view"). Removes it from its source group (dropping the group
 *  if it empties), then tiles it beside the target group's active pane.
 *  No-op if same group, target missing, or target at the pane cap. */
function mergeTerminalIntoGroup(
  termId: string,
  targetGroupId: string,
  direction: WorkSplitDirection = "row",
): void {
  const source = findPanelGroupOf(state.terminalGroups, termId);
  const target = state.terminalGroups.find((g) => g.groupId === targetGroupId);
  if (!target) return;
  if (source && source.groupId === targetGroupId) return; // already there
  if (treeLeafNodes(target.layout).length >= MAX_SPLIT_PANES) return;

  const ref: WorkPaneRef = { kind: "terminal", id: termId };
  // Split beside the target's active pane — but fall back to its first
  // pane if the active id has somehow drifted out of the tree, so the
  // dragged terminal is always actually inserted (never orphaned).
  let targetActiveRef: WorkPaneRef = { kind: "terminal", id: target.activeTermId };
  if (treeFindLeafByRef(target.layout, targetActiveRef) == null) {
    const first = treeLeafNodes(target.layout)
      .flatMap((l) => l.tabs)
      .find((r) => r.kind === "terminal");
    if (!first || first.kind !== "terminal") return;
    targetActiveRef = first;
  }
  const nextTargetLayout = treeSplitAt(target.layout, targetActiveRef, ref, direction);

  const groups: TerminalGroup[] = [];
  for (const g of state.terminalGroups) {
    if (g.groupId === targetGroupId) {
      groups.push({ ...g, layout: nextTargetLayout, activeTermId: termId });
    } else if (source && g.groupId === source.groupId) {
      const pruned = treeRemove(g.layout, ref);
      if (pruned == null) continue; // source group emptied → drop the row
      // Re-point the source group's focus if we removed its active pane.
      const stillThere =
        treeFindLeafByRef(pruned, { kind: "terminal", id: g.activeTermId }) != null;
      const firstRef = treeLeafNodes(pruned)
        .flatMap((l) => l.tabs)
        .find((r) => r.kind === "terminal");
      const fallback = firstRef && firstRef.kind === "terminal" ? firstRef.id : g.activeTermId;
      groups.push({ ...g, layout: pruned, activeTermId: stillThere ? g.activeTermId : fallback });
    } else {
      groups.push(g);
    }
  }
  setState({
    ...state,
    terminalGroups: groups,
    panelActiveGroupId: targetGroupId,
    panelActiveTermId: termId,
    // If the dragged terminal came from the EDITOR (no panel-group source),
    // strip it from the editor split tree / flat active slot too, so it
    // doesn't stay mounted there after tiling into the panel group. A no-op
    // when the source was a panel group (the ref isn't in the editor).
    splitLayout: state.splitLayout ? treeRemove(state.splitLayout, ref) : state.splitLayout,
    activeTermId: state.activeTermId === termId ? null : state.activeTermId,
  });
}

/** Bottom Terminal Panel — open/close (persisted + workspace-scoped). */
function setTerminalPanelOpen(open: boolean): void {
  if (state.terminalPanelOpen === open) return;
  setState({ ...state, terminalPanelOpen: open });
}

function toggleTerminalPanel(): void {
  setState({ ...state, terminalPanelOpen: !state.terminalPanelOpen });
}

/** Remove a terminal from the bottom-panel group model: prune its leaf
 *  from the owning group's split tree, drop the group when it empties,
 *  and re-point the panel focus to a survivor. Does NOT touch the
 *  TerminalTab or its PTY — shared by `closeTerminal` (tab is being
 *  destroyed) and `promoteTerminalToEditor` (tab moves to the editor and
 *  stays alive). Returns only the panel slice of state. */
function detachTerminalFromPanel(
  groups: TerminalGroup[],
  panelActiveGroupId: string | null,
  panelActiveTermId: string | null,
  termId: string,
): {
  terminalGroups: TerminalGroup[];
  panelActiveGroupId: string | null;
  panelActiveTermId: string | null;
} {
  const closedRef: WorkPaneRef = { kind: "terminal", id: termId };
  const ownerId = findPanelGroupOf(groups, termId)?.groupId ?? null;
  const next: TerminalGroup[] = [];
  for (const g of groups) {
    if (g.groupId !== ownerId) {
      next.push(g);
      continue;
    }
    const pruned = treeRemove(g.layout, closedRef);
    if (pruned == null) continue; // group emptied → drop the row
    const stillThere =
      treeFindLeafByRef(pruned, { kind: "terminal", id: g.activeTermId }) != null;
    const firstRef = treeLeafNodes(pruned)
      .flatMap((l) => l.tabs)
      .find((r) => r.kind === "terminal");
    const fallback = firstRef && firstRef.kind === "terminal" ? firstRef.id : g.activeTermId;
    next.push({ ...g, layout: pruned, activeTermId: stillThere ? g.activeTermId : fallback });
  }
  let nextGroupId = panelActiveGroupId;
  let nextTermId = panelActiveTermId;
  const activeGroupGone =
    nextGroupId != null && !next.some((g) => g.groupId === nextGroupId);
  if (activeGroupGone || nextTermId === termId) {
    const survivor = activeGroupGone
      ? next[Math.max(0, next.length - 1)] ?? null
      : next.find((g) => g.groupId === nextGroupId) ?? next[next.length - 1] ?? null;
    nextGroupId = survivor?.groupId ?? null;
    nextTermId = survivor?.activeTermId ?? null;
  }
  return { terminalGroups: next, panelActiveGroupId: nextGroupId, panelActiveTermId: nextTermId };
}

/** "Expand" a bottom-panel terminal into the center editor area as a
 *  regular terminal tab — VS Code's "Move Terminal into Editor Area". The
 *  PTY + xterm session is keyed by termId and reattaches at the new mount
 *  point, so the live shell and its scrollback survive the move. The
 *  terminal LEAVES the bottom panel (no double-mount); the panel closes
 *  when it empties. When the editor is split, the terminal drops into the
 *  layout as a focused tab so the user's split is never collapsed. */
function promoteTerminalToEditor(termId: string): void {
  if (!state.terminalTabs.some((t) => t.termId === termId)) return;
  const ref: WorkPaneRef = { kind: "terminal", id: termId };
  const panel = detachTerminalFromPanel(
    state.terminalGroups,
    state.panelActiveGroupId,
    state.panelActiveTermId,
    termId,
  );
  const panelStillOpen = panel.terminalGroups.length > 0;
  const tree = state.splitLayout;
  if (tree) {
    // Editor is split — fold the terminal into the layout as a focused
    // tab, leaving the existing split panes intact.
    let nextTree = tree;
    if (treeContains(tree, ref)) {
      const owner = treeFindLeafByRef(tree, ref);
      if (owner) {
        const tabIdx = owner.tabs.findIndex((r) => samePaneRef(r, ref));
        nextTree = treeSetActiveTab(tree, owner.paneId, tabIdx);
      }
    } else {
      const firstLeaf = treeLeafNodes(tree)[0];
      nextTree = firstLeaf ? treeAddTab(tree, firstLeaf.paneId, ref) : tree;
    }
    setState({
      ...state,
      terminalGroups: panel.terminalGroups,
      panelActiveGroupId: panel.panelActiveGroupId,
      panelActiveTermId: panel.panelActiveTermId,
      terminalPanelOpen: panelStillOpen ? state.terminalPanelOpen : false,
      splitLayout: nextTree,
      activeTermId: termId,
    });
    return;
  }
  // Flat editor — focus the terminal as the active center tab (clears the
  // other active-surface flags so the editor renders the terminal pane).
  setState({
    ...state,
    terminalGroups: panel.terminalGroups,
    panelActiveGroupId: panel.panelActiveGroupId,
    panelActiveTermId: panel.panelActiveTermId,
    terminalPanelOpen: panelStillOpen ? state.terminalPanelOpen : false,
    activeTermId: termId,
    activePath: null,
    activeAgentId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activeDashboard: false,
    activePlanId: null,
    activePrTabId: null,
    activeInbox: false,
    activeSessions: false,
    traceTool: null,
  });
}

/** Inverse of `promoteTerminalToEditor` — "Move Terminal into Panel".
 *  A terminal living as a center editor tab is pulled back into the bottom
 *  Terminal panel as its own fresh group, opening the panel if it was
 *  closed. The PTY/xterm session reattaches at the panel mount point so the
 *  live shell survives; the terminal is stripped from the editor split tree
 *  / flat active slot so it never mounts twice. When the terminal is already
 *  a panel terminal this just surfaces + focuses it (idempotent). */
function demoteTerminalToPanel(termId: string): void {
  if (!state.terminalTabs.some((t) => t.termId === termId)) return;
  const ref: WorkPaneRef = { kind: "terminal", id: termId };
  const existing = findPanelGroupOf(state.terminalGroups, termId);
  if (existing) {
    const groups = state.terminalGroups.map((g) =>
      g.groupId === existing.groupId
        ? { ...g, layout: focusRefInLayout(g.layout, ref), activeTermId: termId }
        : g,
    );
    setState({
      ...state,
      terminalGroups: groups,
      panelActiveGroupId: existing.groupId,
      panelActiveTermId: termId,
      terminalPanelOpen: true,
    });
    return;
  }
  // Strip from the editor (split tree + flat active slot) and re-home in a
  // brand-new panel group.
  const groupId = newGroupId();
  const group: TerminalGroup = {
    groupId,
    layout: makeLeaf([ref]),
    activeTermId: termId,
  };
  setState({
    ...state,
    splitLayout: state.splitLayout ? treeRemove(state.splitLayout, ref) : null,
    activeTermId: state.activeTermId === termId ? null : state.activeTermId,
    terminalGroups: [...state.terminalGroups, group],
    panelActiveGroupId: groupId,
    panelActiveTermId: termId,
    terminalPanelOpen: true,
  });
}

function closeTerminal(termId: string) {
  const idx = state.terminalTabs.findIndex((t) => t.termId === termId);
  if (idx < 0) return;
  // Dispose the persistent xterm + PTY for this tab. Tab switches do
  // NOT call this — they just unmount the React tree while the session
  // stays alive in the Terminal module map. Fire both engines' release;
  // each no-ops if the id isn't in its map, so we needn't know which
  // engine backed the tab.
  releaseTerminalSession(termId);
  releaseNativeTerminalSession(termId);
  const next = state.terminalTabs.slice();
  next.splice(idx, 1);
  let activeAgentId = state.activeAgentId;
  let activePath = state.activePath;
  let activeTermId = state.activeTermId;
  if (activeTermId === termId) {
    const prev = next[Math.max(0, idx - 1)] ?? null;
    if (prev) {
      activeTermId = prev.termId;
    } else if (state.files.length > 0) {
      activeTermId = null;
      activePath = state.files[state.files.length - 1].path;
    } else if (state.agentTabs.length > 0) {
      activeTermId = null;
      activeAgentId = state.agentTabs[state.agentTabs.length - 1].sessionId;
    } else {
      activeTermId = null;
    }
  }
  // Clean the bottom panel: drop the closed terminal from its owning
  // group's split tree, removing the group entirely when it empties.
  // Other groups stay intact. Re-point the panel focus to a surviving
  // group/terminal so the panel never shows a dead tab after a close.
  const panel = detachTerminalFromPanel(
    state.terminalGroups,
    state.panelActiveGroupId,
    state.panelActiveTermId,
    termId,
  );
  setState({
    ...state,
    terminalTabs: next,
    splitLayout: state.splitLayout
      ? treeRemove(state.splitLayout, { kind: "terminal", id: termId })
      : null,
    terminalGroups: panel.terminalGroups,
    panelActiveGroupId: panel.panelActiveGroupId,
    panelActiveTermId: panel.panelActiveTermId,
    activeAgentId,
    activePath,
    activeTermId,
  });
}

function setActiveTerminal(termId: string) {
  if (
    state.splitLayout == null &&
    state.activeTermId === termId &&
    state.activePath === null &&
    state.activeAgentId === null &&
    state.activeManagerId === null &&
    state.activePlanId === null &&
    !state.activeInspector &&
    !state.activeReplay &&
    !state.activePlanBuilder &&
    !state.activeProve &&
    !state.activeGraph
  )
    return;
  setState({ ...state, splitLayout: state.splitLayout ? focusRefInLayout(state.splitLayout, { kind: "terminal", id: termId }) : state.splitLayout, activeTermId: termId, activePath: null, activeAgentId: null, activeManagerId: null, activeInspector: false, activeReplay: false, activePlanBuilder: false, activeProve: false, activeGraph: false, activeDashboard: false, activePlanId: null, activePrTabId: null, activeInbox: false, activeSessions: false, traceTool: null });
}

/** Build a single-direction split tree from a flat panes list. */
function flatToTree(panes: WorkPaneRef[], direction: WorkSplitDirection): WorkSplitTree {
  if (panes.length === 1) return makeLeaf([panes[0]], 0);
  return {
    kind: "split",
    direction,
    children: panes.map((p) => makeLeaf([p], 0)),
  };
}

/** Set the full split layout. `panes` length must be ≥ 2 and ≤
 *  MAX_SPLIT_PANES — caller is expected to pre-clamp. The last pane
 *  becomes the focused one. */
function setSplitLayout(panes: WorkPaneRef[], direction: WorkSplitDirection) {
  if (panes.length < 2) return;
  const clamped = panes.slice(0, MAX_SPLIT_PANES);
  const focus = clamped[clamped.length - 1];
  setState({
    ...state,
    splitLayout: flatToTree(clamped, direction),
    activePath: focus.kind === "file" ? focus.path : null,
    activeAgentId: focus.kind === "agent" ? focus.id : null,
    activeTermId: focus.kind === "terminal" ? focus.id : null,
    activeManagerId: focus.kind === "manager" ? focus.id : null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activeInbox: false, activeSessions: false, traceTool: null,
    activeDashboard: false,
  });
}

/** Restore a full split tree (bypasses flat-to-tree conversion). */
function setSplitLayoutTree(tree: WorkSplitTree) {
  // Re-derive the Trace-rail highlight mirror from the restored tree (#222)
  // so a reload that lands on a Prove / Sessions / Doctor tab lights the
  // matching rail item immediately, not only after the first tab click.
  // First leaf whose active tab is a trace-ish surface wins (the rail shows
  // one highlight anyway).
  let mirror: TraceMirror = CLEARED_TRACE_MIRROR;
  for (const leaf of treeLeafNodes(tree)) {
    const m = traceFieldsForRef(leaf.tabs[leaf.activeIndex]);
    if (m !== CLEARED_TRACE_MIRROR) {
      mirror = m;
      break;
    }
  }
  setState({ ...state, splitLayout: tree, ...mirror });
}

/** Append a pane to the existing split's root. No-op if no split is
 *  active — caller must establish the initial 2-pane split first. */
function addSplitPane(ref: WorkPaneRef) {
  const tree = state.splitLayout;
  if (!tree) return;
  if (treePaneCount(tree) >= MAX_SPLIT_PANES) return;
  if (treeContains(tree, ref)) return;
  const newLeaf = makeLeaf([ref], 0);
  let next: WorkSplitTree;
  if (tree.kind === "split") {
    next = { ...tree, children: [...tree.children, newLeaf] };
  } else {
    next = { kind: "split", direction: "row", children: [tree, newLeaf] };
  }
  setState({
    ...state,
    splitLayout: next,
    activePath: ref.kind === "file" ? ref.path : null,
    activeAgentId: ref.kind === "agent" ? ref.id : null,
    activeTermId: ref.kind === "terminal" ? ref.id : null,
    activeManagerId: ref.kind === "manager" ? ref.id : null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activeInbox: false, activeSessions: false, traceTool: null,
    activeDashboard: false,
  });
}

/** Append an empty pane (picker stub) to the active split's root. */
function addEmptySplitPane(): string | null {
  const tree = state.splitLayout;
  if (!tree) return null;
  if (treePaneCount(tree) >= MAX_SPLIT_PANES) return null;
  const id = generateEmptyPaneId();
  const ref: WorkPaneRef = { kind: "empty", id };
  const newLeaf = makeLeaf([ref], 0);
  let next: WorkSplitTree;
  if (tree.kind === "split") {
    next = { ...tree, children: [...tree.children, newLeaf] };
  } else {
    next = { kind: "split", direction: "row", children: [tree, newLeaf] };
  }
  setState({ ...state, splitLayout: next });
  return id;
}

/** Begin or extend the split by spawning an empty sibling next to
 *  `source`. The new pane appears in the user-chosen `direction`. If
 *  the immediate parent split already runs in `direction`, the empty
 *  pane joins as a sibling; otherwise it nests inside the source leaf
 *  so the rest of the layout keeps its orientation. Returns the empty
 *  pane's id. */
function splitWithEmpty(source: WorkPaneRef, direction: WorkSplitDirection): string {
  const id = generateEmptyPaneId();
  const empty: WorkPaneRef = { kind: "empty", id };
  const tree = state.splitLayout;
  if (tree && treeContains(tree, source)) {
    if (treePaneCount(tree) >= MAX_SPLIT_PANES) return id;
    setState({ ...state, splitLayout: treeSplitAt(tree, source, empty, direction) });
    return id;
  }
  // Fresh layout — wrap source in a single-tab leaf and put new pane
  // alongside it.
  setState({
    ...state,
    splitLayout: {
      kind: "split",
      direction,
      children: [makeLeaf([source], 0), makeLeaf([empty], 0)],
    },
  });
  return id;
}

/** Open a file as a new pane next to the currently-active pane. Loads
 *  the file into `files` if not already present, then either inserts a
 *  sibling leaf into the existing split tree or creates a fresh split
 *  that wraps the previous full pane alongside the new file. */
async function openFileSplit(path: string, direction: WorkSplitDirection): Promise<void> {
  if (!state.files.find((f) => f.path === path)) {
    const content = await api.readFile(path);
    const name = path.split("/").pop() ?? path;
    const file: OpenFile = {
      path,
      name,
      language: content.language,
      baseline: content.text,
      current: content.text,
      size: content.size,
      status: content.status,
    };
    setState({ ...state, files: [...state.files, file] });
  }

  const fileRef: WorkPaneRef = { kind: "file", path };
  const tree = state.splitLayout;

  // Already somewhere in the layout — just focus it; splitting a second
  // copy would duplicate content.
  if (tree && treeContains(tree, fileRef)) {
    setState({
      ...state,
      activePath: path,
      activeAgentId: null,
      activeTermId: null,
      activeManagerId: null,
    });
    return;
  }

  let sourceRef: WorkPaneRef | null = null;
  if (state.activePath && state.activePath !== path) {
    sourceRef = { kind: "file", path: state.activePath };
  } else if (state.activeAgentId) {
    sourceRef = { kind: "agent", id: state.activeAgentId };
  } else if (state.activeTermId) {
    sourceRef = { kind: "terminal", id: state.activeTermId };
  } else if (state.activeManagerId) {
    sourceRef = { kind: "manager", id: state.activeManagerId };
  }

  if (!sourceRef) {
    setState({
      ...state,
      activePath: path,
      activeAgentId: null,
      activeTermId: null,
      activeManagerId: null,
    });
    return;
  }

  if (tree && treeContains(tree, sourceRef)) {
    if (treePaneCount(tree) >= MAX_SPLIT_PANES) {
      setState({
        ...state,
        activePath: path,
        activeAgentId: null,
        activeTermId: null,
        activeManagerId: null,
      });
      return;
    }
    setState({
      ...state,
      splitLayout: treeSplitAt(tree, sourceRef, fileRef, direction),
      activePath: path,
      activeAgentId: null,
      activeTermId: null,
      activeManagerId: null,
    });
    return;
  }

  setState({
    ...state,
    splitLayout: {
      kind: "split",
      direction,
      children: [makeLeaf([sourceRef], 0), makeLeaf([fileRef], 0)],
    },
    activePath: path,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
  });
}

/** Resolve a DFS leaf-active-tab index to the active ref. */
function activeRefAtIndex(tree: WorkSplitTree | null, index: number): WorkPaneRef | null {
  if (!tree) return null;
  const refs = treeLeaves(tree);
  if (index < 0 || index >= refs.length) return null;
  return refs[index];
}

/** DFS-order leaf node at `index`. */
function leafNodeAtIndex(tree: WorkSplitTree | null, index: number): WorkSplitLeaf | null {
  if (!tree) return null;
  const leaves = treeLeafNodes(tree);
  if (index < 0 || index >= leaves.length) return null;
  return leaves[index];
}

/** Replace pane at DFS leaf `index`. Picker calls this to swap an
 *  empty pane for the chosen agent/terminal/file/manager ref. */
function replaceSplitPaneAt(index: number, ref: WorkPaneRef) {
  const tree = state.splitLayout;
  if (!tree) return;
  const targetRef = activeRefAtIndex(tree, index);
  if (!targetRef) return;
  // Already somewhere in the layout — remove the empty slot rather
  // than duplicating the same content across two panes.
  if (!samePaneRef(targetRef, ref) && treeContains(tree, ref)) {
    setState({ ...state, splitLayout: treeRemove(tree, targetRef) });
    return;
  }
  setState({
    ...state,
    splitLayout: treeReplace(tree, targetRef, ref),
    activePath: ref.kind === "file" ? ref.path : null,
    activeAgentId: ref.kind === "agent" ? ref.id : null,
    activeTermId: ref.kind === "terminal" ? ref.id : null,
    activeManagerId: ref.kind === "manager" ? ref.id : null,
  });
}

/** Reorder panes within the split. `srcIndex` / `dstIndex` are DFS
 *  leaf positions. The reorder only takes effect when both leaves
 *  share an immediate parent split — cross-group drags are no-ops. */
function reorderSplitPanes(srcIndex: number, dstIndex: number) {
  const tree = state.splitLayout;
  if (!tree) return;
  if (srcIndex === dstIndex) return;
  const src = leafNodeAtIndex(tree, srcIndex);
  const dst = leafNodeAtIndex(tree, dstIndex);
  if (!src || !dst) return;
  setState({ ...state, splitLayout: treeReorder(tree, src.paneId, dst.paneId) });
}

/** Append a tab to a specific pane (by paneId). Used by the per-pane
 *  "+ Add tab" affordance. If the ref is already in any leaf in the
 *  layout, no-op (avoids duplicate panes claiming the same content). */
function addTabToPane(paneId: string, ref: WorkPaneRef): void {
  const tree = state.splitLayout;
  if (!tree) return;
  if (treeContains(tree, ref)) {
    // Move focus to wherever it lives.
    const owner = treeFindLeafByRef(tree, ref);
    if (owner) {
      const idx = owner.tabs.findIndex((r) => samePaneRef(r, ref));
      setState({ ...state, splitLayout: treeSetActiveTab(tree, owner.paneId, idx) });
    }
    return;
  }
  setState({ ...state, splitLayout: treeAddTab(tree, paneId, ref) });
}

/** Set the active tab inside a specific pane. */
// The active leaf ref is the source of truth in split mode, so anything
// that reads the flat `traceTool` mirror (the Trace rail's active-tool
// highlight) needs it re-derived whenever that ref changes. Returns the
// tool + prefill when the focused tab is a trace tab, else cleared.
type TraceMirror = {
  traceTool: TraceToolKind | null;
  traceToolArg: { identifier?: string; file?: string } | null;
  activeSessions: boolean;
  activeInspector: boolean;
  activeReplay: boolean;
  activeProve: boolean;
  activeGraph: boolean;
};

// All Trace-rail mirrors cleared. The trace insight surfaces
// (Sessions / Intent↔AST / Provenance / Goals / Semantic Graph) now live
// as workpane tabs; their flat `active*` flags survive ONLY so the Trace
// rail can highlight the active one. This is the "nothing trace-y is the
// focused tab" baseline, spread by openers/closers when the focus moves
// off a trace tab.
const CLEARED_TRACE_MIRROR: TraceMirror = {
  traceTool: null,
  traceToolArg: null,
  activeSessions: false,
  activeInspector: false,
  activeReplay: false,
  activeProve: false,
  activeGraph: false,
};

function traceFieldsForRef(
  ref: WorkPaneRef | undefined,
): TraceMirror & { traceView: TraceView } {
  // Carry the current top-level view forward by default so focusing a
  // non-sessions tab never clobbers it; a sessions tab decodes its view from
  // the ref id, keeping the rail highlight + tab label glued to whichever
  // Trace view tab is focused (even when the user clicks the tab directly).
  const base = { ...CLEARED_TRACE_MIRROR, traceView: state.traceView };
  if (!ref) return base;
  switch (ref.kind) {
    case "trace":
      return { ...base, traceTool: ref.tool, traceToolArg: ref.arg ?? null };
    case "sessions":
      return { ...base, activeSessions: true, traceView: sessionsViewFromId(ref.id) };
    case "inspector":
      return { ...base, activeInspector: true };
    case "replay":
      return { ...base, activeReplay: true };
    case "prove":
      return { ...base, activeProve: true };
    case "graph":
      return { ...base, activeGraph: true };
    default:
      return base;
  }
}

function setActiveTabInPane(paneId: string, index: number): void {
  const tree = state.splitLayout;
  if (!tree) return;
  const nextLayout = treeSetActiveTab(tree, paneId, index);
  const leaf = treeLeafNodes(nextLayout).find((l) => l.paneId === paneId);
  setState({
    ...state,
    splitLayout: nextLayout,
    ...traceFieldsForRef(leaf?.tabs[leaf.activeIndex]),
  });
}

/** Move a tab from one split pane to another. Refuses to leave a pane
 *  empty (would collapse the layout) — that case requires the user to
 *  close the source pane explicitly first. No-ops on same-pane same-index
 *  drops; same-pane different-index reorders within the destination. */
function moveTabBetweenPanes(
  srcPaneId: string,
  srcIndex: number,
  dstPaneId: string,
): void {
  const tree = state.splitLayout;
  if (!tree) return;
  const srcLeaf = treeLeafNodes(tree).find((l) => l.paneId === srcPaneId);
  if (!srcLeaf) return;
  const ref = srcLeaf.tabs[srcIndex];
  if (!ref) return;
  if (srcPaneId === dstPaneId) return;
  if (srcLeaf.tabs.length <= 1) return;
  const dstLeaf = treeLeafNodes(tree).find((l) => l.paneId === dstPaneId);
  if (!dstLeaf) return;
  // Remove from source, then add to destination. `treeRemove` handles
  // the active-index reseat on the source side; `treeAddTab` appends and
  // makes the new tab active on the destination.
  const afterRemove = treeRemove(tree, ref);
  if (!afterRemove) return;
  if (afterRemove.kind === "leaf") {
    // The split collapsed because the source was the second pane and
    // also held only this tab. Skip — the invariant above should have
    // prevented this but belt-and-braces.
    return;
  }
  setState({
    ...state,
    splitLayout: treeAddTab(afterRemove, dstPaneId, ref),
  });
}

/** Close a tab inside a specific pane. Empty panes are pruned; a
 *  one-pane survivor collapses the entire split. */
// ── ⌘⇧T "reopen closed tab" (VS Code parity) ──────────────────────
//
// Only kinds whose content survives a close are recorded. A file reopens to
// its on-disk buffer; every "view" tab (Tasks / task detail / Pages / Trace
// tools / Sessions / Commons / …) re-queries live state on mount, so
// re-opening is loss-free. Live-PTY kinds (terminal / agent) and session-only
// kinds (manager / plan / empty / screenshare) are deliberately excluded — the
// process or session is gone the instant the tab closed, so "reopen" could only
// resurrect an empty husk, which is worse than nothing.
const REOPENABLE_TAB_KINDS: ReadonlySet<WorkPaneRef["kind"]> = new Set([
  "file",
  "tasks",
  "task",
  "pages",
  "standup",
  "automations",
  "channels",
  "commons",
  "app",
  "sessions",
  "trace",
  "inspector",
  "replay",
  "prove",
  "graph",
]);

const MAX_CLOSED_TABS = 10;

/** Record a just-closed tab onto the reopen stack (newest last), if its kind
 *  is loss-free to reopen. De-dupes an identical ref (re-closing the same file
 *  bumps it to the top rather than stacking) and caps the history. Mutates the
 *  passed state slice in place is avoided — returns the next array. */
function rememberClosedTab(ref: WorkPaneRef): WorkPaneRef[] {
  const prev = state.closedTabs ?? [];
  if (!REOPENABLE_TAB_KINDS.has(ref.kind)) return prev;
  const deduped = prev.filter((r) => !samePaneRef(r, ref));
  const next = [...deduped, ref];
  return next.length > MAX_CLOSED_TABS ? next.slice(next.length - MAX_CLOSED_TABS) : next;
}

/** Pop the most-recently-closed reopenable tab and re-open it. Files route
 *  through `openFile` (re-reads the buffer); view tabs route through the shared
 *  `focusOrAppendRef` opener. No-op when the stack is empty. */
function reopenClosedTab(): void {
  const stack = state.closedTabs ?? [];
  if (stack.length === 0) return;
  const ref = stack[stack.length - 1];
  const remaining = stack.slice(0, stack.length - 1);
  // Drop the entry first so a failed reopen doesn't wedge the stack, then open.
  setState({ ...state, closedTabs: remaining });
  if (ref.kind === "file") {
    void openFile(ref.path);
  } else {
    focusOrAppendRef(ref);
  }
}

function closeTabInPane(paneId: string, index: number): void {
  const tree = state.splitLayout;
  if (!tree) return;
  const leaf = treeLeafNodes(tree).find((l) => l.paneId === paneId);
  if (!leaf) return;
  const ref = leaf.tabs[index];
  if (!ref) return;
  // Record for ⌘⇧T reopen (no-op for non-reopenable kinds).
  const closedTabs = rememberClosedTab(ref);
  // Closing a split-pane tab must also STOP whatever is running in it — this
  // path used to only prune the roster, so a shell or a coding-agent CLI kept
  // running as an orphan (the flat strip already kills via releaseTerminal-
  // Session / stopAndCloseAgent). Kill it here too so "close stops it" holds
  // no matter which strip the tab lived on.
  if (ref.kind === "terminal") {
    // Both engines: each release no-ops if the id isn't in its map, so we
    // needn't know whether this pane was xterm- or native-GPU-backed.
    releaseTerminalSession(ref.id);
    releaseNativeTerminalSession(ref.id);
  } else if (ref.kind === "agent") void api.agentPtyClose(ref.id).catch(() => {});
  // Roster reconciliation: dropping a ref from the split tree must also
  // drop its underlying roster entry (mirroring closeAgent/closeTerminal/
  // closeManager) so closed tabs don't leak into agentTabs/terminalTabs/
  // managerTabs and ghost the project-level live-agent lane.
  const agentTabs =
    ref.kind === "agent" ? state.agentTabs.filter((t) => t.sessionId !== ref.id) : state.agentTabs;
  const terminalTabs =
    ref.kind === "terminal" ? state.terminalTabs.filter((t) => t.termId !== ref.id) : state.terminalTabs;
  const managerTabs =
    ref.kind === "manager" ? state.managerTabs.filter((t) => t.sessionId !== ref.id) : state.managerTabs;
  const next = treeRemove(tree, ref);
  if (!next) {
    setState({ ...state, closedTabs, agentTabs, terminalTabs, managerTabs, splitLayout: null, ...CLEARED_TRACE_MIRROR });
    return;
  }
  if (next.kind === "leaf") {
    const survivor = next.tabs[next.activeIndex];
    const flatCapable =
      !!survivor &&
      (survivor.kind === "file" ||
        survivor.kind === "agent" ||
        survivor.kind === "terminal" ||
        survivor.kind === "manager" ||
        survivor.kind === "plan");
    // Collapse back to the flat strip only when exactly one flat-capable
    // tab is left. A surviving layout-only tab (Tasks / Pages / Team /
    // trace / …) has no flat representation, and a multi-tab leaf IS the
    // unified strip — both stay as the splitLayout so closing one tab
    // never silently drops the others.
    if (next.tabs.length === 1 && flatCapable) {
      setState({
        ...state,
        closedTabs,
        agentTabs,
        terminalTabs,
        managerTabs,
        splitLayout: null,
        activePath: survivor?.kind === "file" ? survivor.path : null,
        activeAgentId: survivor?.kind === "agent" ? survivor.id : null,
        activeTermId: survivor?.kind === "terminal" ? survivor.id : null,
        activeManagerId: survivor?.kind === "manager" ? survivor.id : null,
        activePlanId: survivor?.kind === "plan" ? survivor.id : null,
        ...CLEARED_TRACE_MIRROR,
      });
      return;
    }
    setState({
      ...state,
      closedTabs,
      agentTabs,
      terminalTabs,
      managerTabs,
      splitLayout: next,
      ...traceFieldsForRef(survivor),
    });
    return;
  }
  const touched = treeLeafNodes(next).find((l) => l.paneId === paneId);
  setState({
    ...state,
    closedTabs,
    agentTabs,
    terminalTabs,
    managerTabs,
    splitLayout: next,
    ...traceFieldsForRef(touched?.tabs[touched.activeIndex]),
  });
}

// ── Stage 9H — reorder tab strips by drag ─────────────────────────
//
// Each strip (agent / terminal / manager / files) is a flat array; the
// reducer just splices src→dst. No active-id changes — the moved tab
// keeps its identity.

function reorderAgentTabs(srcIndex: number, dstIndex: number) {
  const arr = state.agentTabs;
  if (srcIndex === dstIndex) return;
  if (srcIndex < 0 || srcIndex >= arr.length) return;
  if (dstIndex < 0 || dstIndex >= arr.length) return;
  const next = arr.slice();
  const [moved] = next.splice(srcIndex, 1);
  next.splice(dstIndex, 0, moved);
  setState({ ...state, agentTabs: next });
}

function reorderTerminalTabs(srcIndex: number, dstIndex: number) {
  const arr = state.terminalTabs;
  if (srcIndex === dstIndex) return;
  if (srcIndex < 0 || srcIndex >= arr.length) return;
  if (dstIndex < 0 || dstIndex >= arr.length) return;
  const next = arr.slice();
  const [moved] = next.splice(srcIndex, 1);
  next.splice(dstIndex, 0, moved);
  setState({ ...state, terminalTabs: next });
}

/** Record the backend pty id a terminal tab is currently bound to, so a
 *  restart can attempt a live daemon reconnect (`reconnectId`) before
 *  falling back to cold scrollback replay. No-op when the id is unchanged
 *  to avoid a needless re-render + snapshot churn. */
function setTerminalDaemonSession(termId: string, daemonSessionId: string) {
  const arr = state.terminalTabs;
  const idx = arr.findIndex((t) => t.termId === termId);
  if (idx < 0 || arr[idx].daemonSessionId === daemonSessionId) return;
  const next = arr.slice();
  next[idx] = { ...next[idx], daemonSessionId };
  setState({ ...state, terminalTabs: next });
}

function reorderManagerTabs(srcIndex: number, dstIndex: number) {
  const arr = state.managerTabs;
  if (srcIndex === dstIndex) return;
  if (srcIndex < 0 || srcIndex >= arr.length) return;
  if (dstIndex < 0 || dstIndex >= arr.length) return;
  const next = arr.slice();
  const [moved] = next.splice(srcIndex, 1);
  next.splice(dstIndex, 0, moved);
  setState({ ...state, managerTabs: next });
}

function reorderFileTabs(srcIndex: number, dstIndex: number) {
  const arr = state.files;
  if (srcIndex === dstIndex) return;
  if (srcIndex < 0 || srcIndex >= arr.length) return;
  if (dstIndex < 0 || dstIndex >= arr.length) return;
  const next = arr.slice();
  const [moved] = next.splice(srcIndex, 1);
  next.splice(dstIndex, 0, moved);
  setState({ ...state, files: next });
}

let _emptyPaneCounter = 0;
function generateEmptyPaneId(): string {
  _emptyPaneCounter += 1;
  return `empty-${Date.now().toString(36)}-${_emptyPaneCounter}`;
}

/** Drop a pane (entire leaf, including all its tabs) by DFS leaf
 *  index. Collapses single-child splits and flattens nested splits
 *  sharing direction; when the tree empties, the survivor's `active*`
 *  field is set so WorkSurface unwinds to a normal full-width tab. */
function removeSplitPane(index: number) {
  const tree = state.splitLayout;
  if (!tree) return;
  const leaf = leafNodeAtIndex(tree, index);
  if (!leaf) return;
  const next = treeRemoveLeaf(tree, leaf.paneId);
  if (!next) {
    setState({ ...state, splitLayout: null });
    return;
  }
  if (next.kind === "leaf") {
    const survivor = next.tabs[next.activeIndex];
    setState({
      ...state,
      splitLayout: null,
      activePath: survivor?.kind === "file" ? survivor.path : null,
      activeAgentId: survivor?.kind === "agent" ? survivor.id : null,
      activeTermId: survivor?.kind === "terminal" ? survivor.id : null,
      activeManagerId: survivor?.kind === "manager" ? survivor.id : null,
    });
    return;
  }
  setState({ ...state, splitLayout: next });
}

/** Flip the root split's direction. Inner splits (nested layouts)
 *  keep their own direction — this only re-orients the outermost
 *  flex container. */
function setSplitDirection(direction: WorkSplitDirection) {
  const tree = state.splitLayout;
  if (!tree || tree.kind !== "split" || tree.direction === direction) return;
  setState({ ...state, splitLayout: { ...tree, direction } });
}

function clearSplitLayout() {
  if (!state.splitLayout) return;
  setState({ ...state, splitLayout: null });
}

export function samePaneRef(a: WorkPaneRef, b: WorkPaneRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.path === b.path;
  // agent / terminal / manager / empty all use { id }
  if (a.kind !== "file" && b.kind !== "file") return a.id === b.id;
  return false;
}

function updateSplitRef(
  layout: WorkSplitTree | null,
  from: WorkPaneRef,
  to: WorkPaneRef,
): WorkSplitTree | null {
  if (!layout) return null;
  return treeReplace(layout, from, to);
}

// ── Manager tabs ────────────────────────────────────────────────────
//
// Manager tabs are top-level (not workspace-bound) and intentionally
// survive `closeAll()` so they persist across workspace switches —
// the Manager session itself can span repos in 4C and a workspace
// hop shouldn't drop the user out of an in-flight session.

function openManager(sessionId: string, label: string) {
  // Native Aura Manager is gated off for now — swallow any open request
  // (slash command, phone bridge, plan handoff) so the chat surface can't
  // re-appear while the flag is down. The launcher tile is already gone
  // from the pickers; this is the render-path half of the lockstep.
  if (!AURA_MANAGER_ENABLED) return;
  // When a split is active it takes render precedence over the manager-tab
  // branch in WorkSurface, so just setting activeManagerId leaves the chat
  // invisible ("clicking Aura Manager does nothing"). Mirror openAgent/
  // openTerminal: focus the manager ref INTO the split (adding it if absent)
  // so the chat surfaces in a pane. No split → plain set.
  const mgrRef: WorkPaneRef = { kind: "manager", id: sessionId };
  const splitLayout = state.splitLayout
    ? focusRefInLayout(state.splitLayout, mgrRef)
    : state.splitLayout;
  const existing = state.managerTabs.find((t) => t.sessionId === sessionId);
  if (existing) {
    if (existing.label !== label) {
      // Refresh label (objective may have been edited) without losing focus.
      const idx = state.managerTabs.findIndex((t) => t.sessionId === sessionId);
      const next = state.managerTabs.slice();
      next[idx] = { ...existing, label };
      setState({
        ...state,
        managerTabs: next,
        splitLayout,
        activeManagerId: sessionId,
        activePath: null,
        activeAgentId: null,
        activeTermId: null,
        activeInspector: false,
        activeReplay: false,
        activePlanBuilder: false,
        activeProve: false,
        activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false, activePlanId: null,
      });
      return;
    }
    setState({
      ...state,
      splitLayout,
      activeManagerId: sessionId,
      activePath: null,
      activeAgentId: null,
      activeTermId: null,
      activeInspector: false,
      activeReplay: false,
      activePlanBuilder: false,
      activeProve: false,
      activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false, activePlanId: null,
    });
    return;
  }
  const tab: ManagerTab = { sessionId, label };
  setState({
    ...state,
    managerTabs: [...state.managerTabs, tab],
    splitLayout,
    activeManagerId: sessionId,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false, activePlanId: null,
  });
}

/** Imperative open of a past Aura conversation — the same path the header
 *  history dropdown uses, exposed for callers that can't reach the hook-bound
 *  `editor.openManager` (e.g. the `/resume` slash card's action router, where
 *  the `editor` binding is out of lexical scope). Mirrors `getActiveWorkspaceRoot`. */
export function openManagerSession(sessionId: string, label: string): void {
  openManager(sessionId, label);
}

function closeManager(sessionId: string) {
  const idx = state.managerTabs.findIndex((t) => t.sessionId === sessionId);
  if (idx < 0) return;
  const next = state.managerTabs.slice();
  next.splice(idx, 1);
  let activeManagerId = state.activeManagerId;
  let activePath = state.activePath;
  let activeAgentId = state.activeAgentId;
  let activeTermId = state.activeTermId;
  if (activeManagerId === sessionId) {
    const prev = next[Math.max(0, idx - 1)] ?? null;
    if (prev) {
      activeManagerId = prev.sessionId;
    } else if (state.files.length > 0) {
      activeManagerId = null;
      activePath = state.files[state.files.length - 1].path;
    } else if (state.agentTabs.length > 0) {
      activeManagerId = null;
      activeAgentId = state.agentTabs[state.agentTabs.length - 1].sessionId;
    } else if (state.terminalTabs.length > 0) {
      activeManagerId = null;
      activeTermId = state.terminalTabs[state.terminalTabs.length - 1].termId;
    } else {
      activeManagerId = null;
    }
  }
  setState({
    ...state,
    managerTabs: next,
    splitLayout: state.splitLayout
      ? treeRemove(state.splitLayout, { kind: "manager", id: sessionId })
      : null,
    activeManagerId,
    activePath,
    activeAgentId,
    activeTermId,
  });
}

function setActiveManager(sessionId: string) {
  if (
    state.activeManagerId === sessionId &&
    state.activePath === null &&
    state.activeAgentId === null &&
    state.activeTermId === null &&
    state.activePlanId === null &&
    !state.activeInspector &&
    !state.activeReplay &&
    !state.activePlanBuilder &&
    !state.activeProve &&
    !state.activeGraph
  )
    return;
  setState({
    ...state,
    splitLayout: state.splitLayout
      ? focusRefInLayout(state.splitLayout, { kind: "manager", id: sessionId })
      : state.splitLayout,
    activeManagerId: sessionId,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false, activePlanId: null,
    activePrTabId: null,
  });
}

// ── Plan tabs (Stage 11.4) ─────────────────────────────────────────
//
// Plans flow: Manager brain runs `aura propose-plan` → frontend renders
// `PlanCard` inline. User clicks "Open" → openPlan registers a
// PlanTabData snapshot and mounts a full `WorkPaneRef { kind: "plan" }`
// in the active leaf. Plans are session-only — sanitizeRefForPersist
// drops them, same as terminals.

function openPlan(
  plan: {
    id: string;
    title: string;
    summary: string;
    objective?: string;
    baseline?: string;
    architectureMermaid?: string;
    phases?: PlanPhase[];
    deliverables?: string[];
    tests?: string[];
    pendingPlanId?: string | null;
    todos: {
      description: string;
      agent: string | null;
      fileRefs?: string[];
      assignee?: string | null;
      suggestedProvider?: {
        providerId: string;
        score: number;
        sampleCount: number;
      } | null;
      goal?: string | null;
      acceptance?: string[];
      subtasks?: {
        description: string;
        agent?: string | null;
        goal?: string | null;
        acceptance?: string[];
      }[];
    }[];
  },
  repoRoot: string | null = null,
  sessionId: string | null = null,
) {
  const existing = state.planTabs.find((p) => p.id === plan.id);
  const ref: WorkPaneRef = { kind: "plan", id: plan.id };
  if (existing) {
    // Already registered — just route focus.
    if (state.splitLayout) {
      const owner = treeFindLeafByRef(state.splitLayout, ref);
      if (owner) {
        const idx = owner.tabs.findIndex((r) => samePaneRef(r, ref));
        setState({
          ...state,
          splitLayout: treeSetActiveTab(state.splitLayout, owner.paneId, idx),
          activePlanId: plan.id,
          activePath: null,
          activeAgentId: null,
          activeTermId: null,
          activeManagerId: null,
          activeInspector: false,
          activeReplay: false,
          activePlanBuilder: false,
          activeProve: false,
          activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false,
        });
        return;
      }
    }
    setState({
      ...state,
      activePlanId: plan.id,
      activePath: null,
      activeAgentId: null,
      activeTermId: null,
      activeManagerId: null,
      activeInspector: false,
      activeReplay: false,
      activePlanBuilder: false,
      activeProve: false,
      activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false,
    });
    return;
  }
  const data: PlanTabData = {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
    objective: plan.objective,
    baseline: plan.baseline,
    architectureMermaid: plan.architectureMermaid,
    phases: plan.phases,
    deliverables: plan.deliverables,
    tests: plan.tests,
    todos: plan.todos.map((t) => ({
      description: t.description,
      agent: t.agent,
      done: false,
      fileRefs: t.fileRefs,
      assignee: t.assignee ?? null,
      suggestedProvider: t.suggestedProvider ?? null,
      goal: t.goal ?? null,
      acceptance: t.acceptance ?? [],
      subtasks: t.subtasks,
    })),
    pendingPlanId: plan.pendingPlanId ?? null,
    repoRoot,
    sessionId,
    at: Date.now(),
  };
  let nextLayout = state.splitLayout;
  if (nextLayout) {
    const leaves = treeLeafNodes(nextLayout);
    const targetPaneId = leaves[0]?.paneId;
    if (targetPaneId) {
      nextLayout = treeAddTab(nextLayout, targetPaneId, ref);
    }
  }
  setState({
    ...state,
    planTabs: [...state.planTabs, data],
    activePlanId: plan.id,
    splitLayout: nextLayout,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false,
  });
}

function closePlan(planId: string) {
  const idx = state.planTabs.findIndex((p) => p.id === planId);
  if (idx < 0) return;
  const next = state.planTabs.slice();
  next.splice(idx, 1);
  let activePlanId = state.activePlanId;
  let activePath = state.activePath;
  let activeAgentId = state.activeAgentId;
  let activeTermId = state.activeTermId;
  let activeManagerId = state.activeManagerId;
  let splitLayout = state.splitLayout;
  if (splitLayout) {
    const after = treeRemove(splitLayout, { kind: "plan", id: planId });
    if (!after) {
      splitLayout = null;
    } else if (after.kind === "leaf" && after !== splitLayout) {
      const survivor = after.tabs[after.activeIndex];
      const flatCapable =
        !!survivor &&
        (survivor.kind === "file" ||
          survivor.kind === "agent" ||
          survivor.kind === "terminal" ||
          survivor.kind === "manager" ||
          survivor.kind === "plan");
      // Collapse back to the flat strip ONLY when exactly one flat-capable tab
      // is left. A multi-tab leaf IS the unified strip, so dropping to flat
      // here would silently discard the surviving siblings — mirror the same
      // guard closeTabInPane uses so closing a plan never eats its neighbours.
      if (after.tabs.length === 1 && flatCapable) {
        splitLayout = null;
        activePath = survivor?.kind === "file" ? survivor.path : null;
        activeAgentId = survivor?.kind === "agent" ? survivor.id : null;
        activeTermId = survivor?.kind === "terminal" ? survivor.id : null;
        activeManagerId = survivor?.kind === "manager" ? survivor.id : null;
        activePlanId = survivor?.kind === "plan" ? survivor.id : null;
      } else {
        splitLayout = after;
      }
    } else {
      splitLayout = after;
    }
  }
  if (activePlanId === planId) {
    const prev = next[Math.max(0, idx - 1)] ?? null;
    if (prev) {
      activePlanId = prev.id;
    } else if (state.files.length > 0) {
      activePlanId = null;
      activePath = state.files[state.files.length - 1].path;
    } else if (state.managerTabs.length > 0) {
      activePlanId = null;
      activeManagerId = state.managerTabs[state.managerTabs.length - 1].sessionId;
    } else if (state.agentTabs.length > 0) {
      activePlanId = null;
      activeAgentId = state.agentTabs[state.agentTabs.length - 1].sessionId;
    } else if (state.terminalTabs.length > 0) {
      activePlanId = null;
      activeTermId = state.terminalTabs[state.terminalTabs.length - 1].termId;
    } else {
      activePlanId = null;
    }
  }
  setState({
    ...state,
    planTabs: next,
    activePlanId,
    activePath,
    activeAgentId,
    activeTermId,
    activeManagerId,
    splitLayout,
  });
}

function setActivePlan(planId: string) {
  if (
    state.activePlanId === planId &&
    state.activePath === null &&
    state.activeAgentId === null &&
    state.activeTermId === null &&
    state.activeManagerId === null &&
    !state.activeInspector &&
    !state.activeReplay &&
    !state.activePlanBuilder &&
    !state.activeProve &&
    !state.activeGraph
  )
    return;
  setState({
    ...state,
    activePlanId: planId,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false,
    activePrTabId: null,
  });
}

function togglePlanTodo(planId: string, todoIndex: number) {
  const idx = state.planTabs.findIndex((p) => p.id === planId);
  if (idx < 0) return;
  const plan = state.planTabs[idx];
  if (todoIndex < 0 || todoIndex >= plan.todos.length) return;
  const todos = plan.todos.slice();
  todos[todoIndex] = { ...todos[todoIndex], done: !todos[todoIndex].done };
  const nextTabs = state.planTabs.slice();
  nextTabs[idx] = { ...plan, todos };
  setState({ ...state, planTabs: nextTabs });
}

// ── Intent Inspector (singleton) ───────────────────────────────────
//
// One pane at most; toggling open from anywhere just routes to it. Like
// Manager tabs, Inspector is global to the shell — not workspace-bound
// — so a workspace switch keeps it open. The pane itself queries
// `aura intent-vs-actual` against whatever workspace is currently
// active when it renders.

// Intent↔AST inspector opens as a workpane tab (singleton, constant id)
// that sits beside the agent/Tasks/trace tabs instead of taking over the
// whole center. `activeInspector` survives as the Trace rail's highlight
// mirror, kept in sync by traceFieldsForRef as the active leaf tab changes.
function openInspector() {
  const ref: WorkPaneRef = { kind: "inspector", id: "inspector" };
  setState({
    ...state,
    splitLayout: layoutWithRef(ref),
    inspectorOpen: false,
    inboxOpen: false, activeInbox: false,
    activePath: null, activeAgentId: null, activeTermId: null, activeManagerId: null,
    activePlanBuilder: false, activeDashboard: false, activePlanId: null, activePrTabId: null,
    ...traceFieldsForRef(ref),
  });
}

function closeInspector() {
  const ref: WorkPaneRef = { kind: "inspector", id: "inspector" };
  const layout = state.splitLayout ? treeRemove(state.splitLayout, ref) : null;
  setState({ ...state, splitLayout: layout, inspectorOpen: false, activeInspector: false });
}

function setActiveInspector() {
  openInspector();
}

// ── Provenance Replay (singleton) ──────────────────────────────────
//
// Mirrors the Inspector pattern. The pane probes
// `.aura/manifest{,s}/<sha>.json` + `.aura/blocks/<sha>.json` on
// demand and shells `aura keys sigstore-verify` when the user clicks
// Verify, so no per-instance state lives here.

// Provenance Replay opens as a workpane tab — same singleton-tab shape as
// the Inspector. `activeReplay` is the Trace rail's highlight mirror.
function openReplay() {
  const ref: WorkPaneRef = { kind: "replay", id: "replay" };
  setState({
    ...state,
    splitLayout: layoutWithRef(ref),
    replayOpen: false,
    inboxOpen: false, activeInbox: false,
    activePath: null, activeAgentId: null, activeTermId: null, activeManagerId: null,
    activePlanBuilder: false, activeDashboard: false, activePlanId: null, activePrTabId: null,
    ...traceFieldsForRef(ref),
  });
}

function closeReplay() {
  const ref: WorkPaneRef = { kind: "replay", id: "replay" };
  const layout = state.splitLayout ? treeRemove(state.splitLayout, ref) : null;
  setState({ ...state, splitLayout: layout, replayOpen: false, activeReplay: false });
}

function setActiveReplay() {
  openReplay();
}

// ── Plan Builder (singleton) ───────────────────────────────────────
//
// Multi-step wizard that walks the user from a free-form goal to a
// committed plan XML on disk. The wizard's per-step buffer + plan
// preview live inside the surface component (no per-instance state in
// the store) — same shape as Inspector / Replay.

function openPlanBuilder() {
  setState({
    ...state,
    planBuilderOpen: true,
    activePlanBuilder: true,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activeProve: false,
    activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false, activePlanId: null,
  });
}

function closePlanBuilder() {
  if (!state.planBuilderOpen) return;
  let activePath = state.activePath;
  let activeAgentId = state.activeAgentId;
  let activeTermId = state.activeTermId;
  let activeManagerId = state.activeManagerId;
  let activeInspector = state.activeInspector;
  let activeReplay = state.activeReplay;
  let activeProve = state.activeProve;
  if (state.activePlanBuilder) {
    if (state.inspectorOpen) {
      activeInspector = true;
    } else if (state.replayOpen) {
      activeReplay = true;
    } else if (state.proveOpen) {
      activeProve = true;
    } else if (state.files.length > 0) {
      activePath = state.files[state.files.length - 1].path;
    } else if (state.agentTabs.length > 0) {
      activeAgentId = state.agentTabs[state.agentTabs.length - 1].sessionId;
    } else if (state.terminalTabs.length > 0) {
      activeTermId = state.terminalTabs[state.terminalTabs.length - 1].termId;
    } else if (state.managerTabs.length > 0) {
      activeManagerId = state.managerTabs[state.managerTabs.length - 1].sessionId;
    }
  }
  setState({
    ...state,
    planBuilderOpen: false,
    activePlanBuilder: false,
    activePath,
    activeAgentId,
    activeTermId,
    activeManagerId,
    activeInspector,
    activeReplay,
    activeProve,
  });
}

function setActivePlanBuilder() {
  if (state.activePlanBuilder && state.planBuilderOpen) return;
  setState({
    ...state,
    planBuilderOpen: true,
    activePlanBuilder: true,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activeProve: false,
    activeGraph: false, activeInbox: false, activeSessions: false, traceTool: null, activeDashboard: false, activePlanId: null,
  });
}

// ── Prove (singleton) ──────────────────────────────────────────────
//
// Same shape as Inspector / Replay / Plan Builder. The pane shells
// `aura prove --goal <text>` on demand and renders the result locally —
// no per-instance state in the store.

// Prove (Goals) opens as a workpane tab — same singleton-tab shape as the
// Inspector. `activeProve` is the Trace rail's highlight mirror.
function openProve() {
  const ref: WorkPaneRef = { kind: "prove", id: "prove" };
  setState({
    ...state,
    splitLayout: layoutWithRef(ref),
    proveOpen: false,
    inboxOpen: false, activeInbox: false,
    activePath: null, activeAgentId: null, activeTermId: null, activeManagerId: null,
    activePlanBuilder: false, activeDashboard: false, activePlanId: null, activePrTabId: null,
    ...traceFieldsForRef(ref),
  });
}

function closeProve() {
  const ref: WorkPaneRef = { kind: "prove", id: "prove" };
  const layout = state.splitLayout ? treeRemove(state.splitLayout, ref) : null;
  setState({ ...state, splitLayout: layout, proveOpen: false, activeProve: false });
}

function setActiveProve() {
  openProve();
}

// Semantic Graph (Code Map) opens as a workpane tab — same singleton-tab
// shape as the Inspector. `activeGraph` is the Trace rail's highlight mirror.
function openGraph() {
  if (!CODE_MAP_ENABLED) return; // Code Map quarantined — freezes the app.
  const ref: WorkPaneRef = { kind: "graph", id: "graph" };
  setState({
    ...state,
    splitLayout: layoutWithRef(ref),
    graphOpen: false,
    inboxOpen: false, activeInbox: false,
    activePath: null, activeAgentId: null, activeTermId: null, activeManagerId: null,
    activePlanBuilder: false, activeDashboard: false, activePlanId: null, activePrTabId: null,
    ...traceFieldsForRef(ref),
  });
}

function closeGraph() {
  const ref: WorkPaneRef = { kind: "graph", id: "graph" };
  const layout = state.splitLayout ? treeRemove(state.splitLayout, ref) : null;
  setState({ ...state, splitLayout: layout, graphOpen: false, activeGraph: false });
}

function setActiveGraph() {
  openGraph();
}

function setActiveDashboard() {
  if (state.activeDashboard) return;
  setState({
    ...state,
    activeDashboard: true,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activePrTabId: null,
    activeInbox: false, activeSessions: false, traceTool: null,
  });
}

// ── Tasks / Standup workpane tabs (Stage v0.2.12 — #266) ───────────
//
// Both are keyed entirely by repoRoot; no per-tab data registry needed.
// Open behaves like a split-pane tab: focus existing or append to the
// first leaf. Close removes the ref from the layout and falls back to a
// reasonable sibling.

// Pure: compute the layout that has `ref` present + focused, without
// committing it. When no layout exists yet, migrate every open
// agent/terminal/manager/file tab into the first leaf alongside `ref`
// so the strip stays continuous — the user sees
// [Claude Code | Gemini CLI | … | Tasks] as one row instead of having
// their workspace tabs disappear behind the new tab. Shared by
// focusOrAppendRef (Tasks/Pages/Standup/…) and openTraceTool.
// Pure: given an EXISTING layout, return it with `ref` present and
// focused — focus the owning leaf's tab if it's already there, else
// append to the first leaf. This is what keeps a freshly-opened or
// re-focused agent/terminal from vanishing behind a workpane tab: the
// split path hides the global strip, so anything launched after the
// split was created has to be folded into a leaf to stay visible.
function focusRefInLayout(
  layout: WorkSplitTree,
  ref: WorkPaneRef,
): WorkSplitTree {
  if (treeContains(layout, ref)) {
    const owner = treeFindLeafByRef(layout, ref);
    if (owner) {
      const idx = owner.tabs.findIndex((r) => samePaneRef(r, ref));
      return treeSetActiveTab(layout, owner.paneId, idx);
    }
    return layout;
  }
  const leaves = treeLeafNodes(layout);
  const targetPaneId = leaves[0]?.paneId;
  if (targetPaneId) {
    return treeAddTab(layout, targetPaneId, ref, true);
  }
  return layout;
}

function layoutWithRef(ref: WorkPaneRef): WorkSplitTree {
  if (state.splitLayout) {
    return focusRefInLayout(state.splitLayout, ref);
  }
  const initialTabs: WorkPaneRef[] = [];
  for (const a of state.agentTabs) {
    initialTabs.push({ kind: "agent", id: a.sessionId });
  }
  for (const t of state.terminalTabs) {
    initialTabs.push({ kind: "terminal", id: t.termId });
  }
  for (const m of state.managerTabs) {
    initialTabs.push({ kind: "manager", id: m.sessionId });
  }
  for (const f of state.files) {
    initialTabs.push({ kind: "file", path: f.path });
  }
  initialTabs.push(ref);
  return {
    kind: "leaf",
    paneId: generatePaneId(),
    tabs: initialTabs,
    activeIndex: initialTabs.length - 1,
  };
}

function focusOrAppendRef(ref: WorkPaneRef): void {
  setState({
    ...state,
    splitLayout: layoutWithRef(ref),
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activeInbox: false, activeSessions: false, traceTool: null, traceToolArg: null,
    activeDashboard: false,
    activePrTabId: null,
    activePlanId: null,
  });
}

function removeRefFromLayout(ref: WorkPaneRef): void {
  let layout = state.splitLayout;
  if (!layout) return;
  const after = treeRemove(layout, ref);
  if (!after) {
    layout = null;
  } else {
    layout = after;
  }
  setState({ ...state, splitLayout: layout });
}

function openTasks(repoRoot: string) {
  focusOrAppendRef({ kind: "tasks", id: repoRoot });
}

function closeTasks(repoRoot: string) {
  removeRefFromLayout({ kind: "tasks", id: repoRoot });
}

function openTaskDetail(taskId: string, repoRoot: string) {
  focusOrAppendRef({ kind: "task", id: taskId, repoRoot });
  dispatchDetailTabOpened();
}

// SS.2 — fired whenever the user drills from a list-style sidebar into
// a single-record detail tab (PR, task, page). App.tsx listens and
// auto-collapses the surface sidebar on viewports under 1400px so the
// detail surface gets the breathing room. Wide screens (>=1400px) keep
// the list-sidebar visible so the user can scan and re-pick without a
// toggle. Manual ⌘B / sidebar toggle always wins thereafter.
function dispatchDetailTabOpened() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("aura:detail-tab-opened"));
}

function closeTaskDetail(taskId: string) {
  // repoRoot doesn't participate in samePaneRef equality (id alone
  // identifies the tab), so a placeholder value here is harmless.
  removeRefFromLayout({ kind: "task", id: taskId, repoRoot: "" });
}

// Edit-intent handoff from the read-mode detail pane to TasksBoard's
// stepped editor. The detail can be mounted board-local (default card
// click — TasksBoard is already alive) OR as its own workpane tab
// (shift-click promotion — TasksBoard may be unmounted, since a split
// leaf only renders its active tab). So we both stash the id module-side
// AND fire an event: an already-mounted board reacts to the event
// instantly; a board that mounts fresh consumes the pending id. The
// event handler also clears the pending id so a later remount doesn't
// re-trigger a stale edit.
let pendingTaskEdit: { taskId: string; repoRoot: string } | null = null;

function requestTaskEdit(taskId: string, repoRoot: string) {
  pendingTaskEdit = { taskId, repoRoot };
  // Mount/focus the board so a workpane-tab detail has something to
  // promote into; a no-op when the board is already the active surface.
  openTasks(repoRoot);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("aura:tasks:edit", { detail: { id: taskId, repoRoot } }),
    );
  }
}

function consumePendingTaskEdit(repoRoot: string): string | null {
  if (pendingTaskEdit && pendingTaskEdit.repoRoot === repoRoot) {
    const id = pendingTaskEdit.taskId;
    pendingTaskEdit = null;
    return id;
  }
  return null;
}

function openStandup(repoRoot: string) {
  focusOrAppendRef({ kind: "standup", id: repoRoot });
}

function closeStandup(repoRoot: string) {
  removeRefFromLayout({ kind: "standup", id: repoRoot });
}

function openAutomations(repoRoot: string) {
  focusOrAppendRef({ kind: "automations", id: repoRoot });
}

function closeAutomations(repoRoot: string) {
  removeRefFromLayout({ kind: "automations", id: repoRoot });
}

function openChannels(repoRoot: string) {
  focusOrAppendRef({ kind: "channels", id: repoRoot });
}

function closeChannels(repoRoot: string) {
  removeRefFromLayout({ kind: "channels", id: repoRoot });
}

function openCommons(repoRoot: string) {
  // Commons (community platform) is gated off — never mount its center pane.
  if (!COMMONS_ENABLED) return;
  focusOrAppendRef({ kind: "commons", id: repoRoot });
}

function openApp(appKey: string) {
  // Mini-apps live inside Commons; when the platform is hidden, so are they.
  if (!COMMONS_ENABLED) return;
  focusOrAppendRef({ kind: "app", id: appKey });
}

function closeApp(appKey: string) {
  removeRefFromLayout({ kind: "app", id: appKey });
}

function closeCommons(repoRoot: string) {
  removeRefFromLayout({ kind: "commons", id: repoRoot });
}

// V.Y.4 — open the active-huddle screenshare as a full workpane tab.
// `huddleKey` is the same `<repoRoot>::<channel>` shape produced by
// callScreenshareWorkpaneId, so one tab per huddle. Re-opening just
// re-focuses (focusOrAppendRef is idempotent on the same ref).
function openScreenshare(huddleKey: string) {
  focusOrAppendRef({ kind: "screenshare", id: huddleKey });
}

function closeScreenshare(huddleKey: string) {
  removeRefFromLayout({ kind: "screenshare", id: huddleKey });
}

// RR.3 — Pages as a first-class workpane tab. id is the repo root
// (one tab per repo, same shape as openTasks/openStandup). Replaces
// the legacy full-screen overlay that lived in App.tsx.
function openPages(repoRoot: string) {
  focusOrAppendRef({ kind: "pages", id: repoRoot });
}

function closePages(repoRoot: string) {
  removeRefFromLayout({ kind: "pages", id: repoRoot });
}

// ── PR Detail (Stage 8N tab kind, was singleton in Stage 7A) ───────
//
// Each open PR is one entry in `prTabs[]`; `activePrTabId` is the one
// the user is currently looking at. PRDetailPane reads `selectedPr`
// (= the active tab's data via the derived shim) and re-fetches when
// it changes. Inbox + PR-stack views call openPrDetail(...) which
// pushes a new tab or focuses an existing one.

function tabIdForPr(repoRoot: string, number: number): string {
  return `${repoRoot}#${number}`;
}

function openPrDetail(repoRoot: string, number: number, title: string) {
  const tabId = tabIdForPr(repoRoot, number);
  const existing = state.prTabs.find((t) => t.tabId === tabId);
  const fromInbox = state.activeInbox || existing?.fromInbox || false;
  const nextTabs: PrTab[] = existing
    ? state.prTabs.map((t) =>
        t.tabId === tabId ? { ...t, title, fromInbox } : t,
      )
    : [...state.prTabs, { tabId, repoRoot, number, title, fromInbox }];
  setState({
    ...state,
    prTabs: nextTabs,
    activePrTabId: tabId,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activeInbox: false, activeSessions: false, traceTool: null,
    activeDashboard: false,
  });
  dispatchDetailTabOpened();
}

function closePrDetail() {
  // Closes whichever PR tab is currently active. If the active tab was
  // opened from the Inbox, falls back to the Inbox; otherwise picks
  // the next-most-recent surface (other PR tab, file, agent, manager,
  // dashboard). Tab-strip X-button uses closePrTab(tabId) instead.
  if (state.activePrTabId == null) return;
  const activeTab = state.prTabs.find((t) => t.tabId === state.activePrTabId);
  if (!activeTab) return;
  const remaining = state.prTabs.filter((t) => t.tabId !== state.activePrTabId);

  if (activeTab.fromInbox) {
    setState({
      ...state,
      prTabs: remaining,
      activePrTabId: null,
      inboxOpen: true,
      activeInbox: true,
      activeDashboard: false,
    });
    return;
  }
  // No inbox-back behaviour: pick the next surface to focus.
  let activePath = state.activePath;
  let activeAgentId = state.activeAgentId;
  let activeTermId = state.activeTermId;
  let activeManagerId = state.activeManagerId;
  let activePrTabId: string | null = null;
  let activeDashboard = state.activeDashboard;
  if (remaining.length > 0) {
    activePrTabId = remaining[remaining.length - 1].tabId;
  } else if (state.files.length > 0) {
    activePath = state.files[state.files.length - 1].path;
  } else if (state.agentTabs.length > 0) {
    activeAgentId = state.agentTabs[state.agentTabs.length - 1].sessionId;
  } else if (state.terminalTabs.length > 0) {
    activeTermId = state.terminalTabs[state.terminalTabs.length - 1].termId;
  } else if (state.managerTabs.length > 0) {
    activeManagerId = state.managerTabs[state.managerTabs.length - 1].sessionId;
  } else {
    activeDashboard = true;
  }
  setState({
    ...state,
    prTabs: remaining,
    activePrTabId,
    activePath,
    activeAgentId,
    activeTermId,
    activeManagerId,
    activeDashboard,
  });
}

function closePrTab(tabId: string) {
  // Tab-strip X click. Drops the tab; if it was active, falls through
  // to the next surface (delegating to closePrDetail's logic when the
  // tab being closed is the active one).
  if (state.activePrTabId === tabId) {
    closePrDetail();
    return;
  }
  setState({
    ...state,
    prTabs: state.prTabs.filter((t) => t.tabId !== tabId),
  });
}

function setActivePrTab(tabId: string) {
  if (!state.prTabs.some((t) => t.tabId === tabId)) return;
  if (state.activePrTabId === tabId) return;
  setState({
    ...state,
    activePrTabId: tabId,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activeInbox: false, activeSessions: false, traceTool: null,
    activeDashboard: false,
  });
}

function setActivePrDetail() {
  // Compatibility shim — pre-tab callers (none should remain after
  // Stage 8N) used this to re-focus the singleton PR detail. Now
  // delegates to the most recent PR tab if one exists.
  if (state.prTabs.length === 0) return;
  const tabId = state.prTabs[state.prTabs.length - 1].tabId;
  if (state.activePrTabId === tabId) return;
  setActivePrTab(tabId);
  return;
}

// ── Inbox (singleton, Stage 8A) ────────────────────────────────────
//
// Graphite-style PR triage list. Same shape as the other singleton
// panes — InboxPane reads `repoRoot` from the WorkSurface prop and
// re-fetches PRs on open.

function openInbox() {
  setState({
    ...state,
    inboxOpen: true,
    activeInbox: true,
    activeSessions: false,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activePrTabId: null,
    activeDashboard: false,
  });
}

function closeInbox() {
  if (!state.inboxOpen) return;
  let activePath = state.activePath;
  let activeAgentId = state.activeAgentId;
  let activeTermId = state.activeTermId;
  let activeManagerId = state.activeManagerId;
  let activeDashboard = state.activeDashboard;
  if (state.activeInbox) {
    if (state.files.length > 0) {
      activePath = state.files[state.files.length - 1].path;
    } else if (state.agentTabs.length > 0) {
      activeAgentId = state.agentTabs[state.agentTabs.length - 1].sessionId;
    } else if (state.terminalTabs.length > 0) {
      activeTermId = state.terminalTabs[state.terminalTabs.length - 1].termId;
    } else if (state.managerTabs.length > 0) {
      activeManagerId = state.managerTabs[state.managerTabs.length - 1].sessionId;
    } else {
      activeDashboard = true;
    }
  }
  setState({
    ...state,
    inboxOpen: false,
    activeInbox: false, activeSessions: false, traceTool: null,
    activePath,
    activeAgentId,
    activeTermId,
    activeManagerId,
    activeDashboard,
  });
}

// ── Sessions (Trace v2 singleton, gated by TRACE_V2) ───────────────────
//
// The per-run list spine + its session detail. Same singleton shape as
// the other center panes; the list↔detail navigation lives inside the
// pane, so the store only flips this one active flag.

function openSessions(view: TraceView = "overview") {
  if (!TRACE_V2) return; // Trace v2 surface gated off.
  // One singleton tab PER view (id = `sessions:<view>`): Overview, My
  // sessions, Team activity, and Cost & usage are now four real, separately
  // openable/closable tabs instead of segments of one pane. `activeSessions`
  // stays as the Trace rail's highlight mirror; `traceView` tracks the
  // focused view so the rail row + tab label stay in sync. Opening a view
  // focuses its tab (creating it if absent); the surface reads its repo root
  // from WorkSurface scope and its view from the ref id.
  const ref: WorkPaneRef = { kind: "sessions", id: sessionsTabId(view) };
  const layout = layoutWithRef(ref);
  setState({
    ...state,
    splitLayout: layout,
    activeSessions: true,
    traceView: view,
    traceTool: null,
    traceToolArg: null,
    inboxOpen: false,
    activeInbox: false,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activePrTabId: null,
    activePlanId: null,
    activeDashboard: false,
  });
}

// ── Trace verify tools (singleton page) ────────────────────────────
//
// Review / Rewind / Attestations / Doctor render as one center page at
// a time instead of modal dialogs. Same shape as Prove — open clears
// every other surface so the page owns the canvas; close falls back to
// the most recent surface (or the empty state).

function openTraceTool(tool: TraceToolKind, arg?: { identifier?: string; file?: string }) {
  // The tool is a tab in the unified leaf (one per tool; id === tool), so
  // it sits beside the agent/Tasks/Pages tabs and survives switching to
  // them — opening Memory no longer hides Tasks, and clicking Claude Code
  // no longer closes Memory. `treeReplace` refreshes the ref so a second
  // open with a new Rewind prefill (symbol/file) actually updates it.
  const ref: WorkPaneRef = { kind: "trace", id: tool, tool, arg };
  const layout = treeReplace(layoutWithRef(ref), ref, ref);
  // `traceTool` / `traceToolArg` stay as the flat mirror the Trace rail
  // reads to highlight the active sub-tool; setActiveTabInPane /
  // closeTabInPane keep them in sync as the active leaf tab changes.
  setState({
    ...state,
    splitLayout: layout,
    traceTool: tool,
    traceToolArg: arg ?? null,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activeInbox: false,
    activeSessions: false,
    activeDashboard: false,
    activePlanId: null,
    activePrTabId: null,
  });
}

function closeTraceTool() {
  if (!state.traceTool) return;
  // Drop the trace tab from the layout. removeRefFromLayout reseats the
  // leaf's active index, and its setState re-syncs traceTool via the
  // post-mutation path below; we clear the flat mirror here too so the
  // rail highlight drops immediately even if the layout is now empty.
  const ref: WorkPaneRef = { kind: "trace", id: state.traceTool, tool: state.traceTool };
  const layout = state.splitLayout ? treeRemove(state.splitLayout, ref) : null;
  setState({
    ...state,
    splitLayout: layout,
    traceTool: null,
    traceToolArg: null,
  });
}

function setActiveInbox() {
  if (state.activeInbox && state.inboxOpen) return;
  setState({
    ...state,
    inboxOpen: true,
    activeInbox: true,
    activeSessions: false,
    activePath: null,
    activeAgentId: null,
    activeTermId: null,
    activeManagerId: null,
    activeInspector: false,
    activeReplay: false,
    activePlanBuilder: false,
    activeProve: false,
    activeGraph: false,
    activePrTabId: null,
    activeDashboard: false,
  });
}

function setAgentView(sessionId: string, view: "ui" | "terminal") {
  const idx = state.agentTabs.findIndex((t) => t.sessionId === sessionId);
  if (idx < 0) return;
  const cur = state.agentTabs[idx];
  if (cur.view === view) return;
  const next = state.agentTabs.slice();
  next[idx] = { ...cur, view };
  setState({ ...state, agentTabs: next });
}
