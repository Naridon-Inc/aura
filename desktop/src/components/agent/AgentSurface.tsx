// Tab body for an agent session. PTY-only as of the bubble-UI cutover:
// every coding-agent CLI we ship (claude/gemini/codex/cursor) is a
// full TUI, so we host the agent in xterm.js and let it drive its
// own native surface (slash commands, vim mode, file picker). The
// stream-json bubble path was retired because the parser kept
// drifting on every claude version bump — a bug factory for
// chat-turn glue, stale resume crashes, and lost tool renders.
//
// AgentTerminalView hooks the raw `agent-pty:<id>` events into xterm.
// The chat-bubble UI was removed — every supported agent CLI is a TUI
// that mangles when rendered as parsed blocks, so terminal is the
// only view.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../lib/api";
import { openPopout } from "../../lib/popout";
import type { AgentTab, WorkSplitDirection } from "../../lib/editorStore";
import { treeLeaves, treePaneCount, useEditorStore } from "../../lib/editorStore";
import { forgetAgentSession } from "../../lib/agentSessionStore";
import { forgetAgentEvent } from "../../lib/agentEventStore";
import {
  isOwnWorktreeSession,
  ownWorktreeSessions,
  releaseResume,
  tryClaimResume,
} from "../../lib/agentSessionScope";
import {
  bindChannelMeta,
  forgetAgentStream,
  persistLastSession,
  pushEvent,
  readPersistedSession,
  streamChannel,
} from "../../lib/agentStreamStore";
import { AgentTerminalView } from "./AgentTerminalView";
import { AgentBlocksView } from "./AgentBlocksView";
import { OpenAiCompatChatView } from "./OpenAiCompatChatView";
import { NormalizedTranscript } from "./normalized/NormalizedTranscript";
import { canNormalize } from "../../lib/agentProtocol";

// Pane-action bridge. The agent-pane controls used to live in a header
// bar inside this surface; they now live in the agent TAB's right-click
// menu (Tabs.tsx), which is rendered far from this component's local
// state (split-in-flight flags, exited/restarting, the Blocks drawer
// toggle). Rather than thread every handler through props across
// WorkSurface, the tab menu dispatches a scoped window event and the
// live surface — which owns those handlers and that state — executes it.
// One event, sessionId-scoped so only the targeted pane reacts (multiple
// agent tabs subscribe to the same window event bus).
export const AGENT_PANE_ACTION_EVENT = "aura:agent-pane-action";

export type AgentPaneAction =
  | "split-right"
  | "split-down"
  | "detach"
  | "close-pane"
  | "leave-split"
  | "open-story"
  | "toggle-blocks"
  | "toggle-transcript"
  | "restart"
  | "stop";

export type AgentPaneActionDetail = {
  sessionId: string;
  action: AgentPaneAction;
};

/** Fire a pane action at the live AgentSurface that owns `sessionId`. */
export function dispatchAgentPaneAction(
  sessionId: string,
  action: AgentPaneAction,
) {
  window.dispatchEvent(
    new CustomEvent<AgentPaneActionDetail>(AGENT_PANE_ACTION_EVENT, {
      detail: { sessionId, action },
    }),
  );
}

/** One descriptor in the agent-tab context menu. Rendered by Tabs.tsx as
 *  ContextMenuItems; produced here so the surface stays the single source
 *  of truth for which actions exist and how they fire. */
export type AgentTabMenuItem =
  | { kind: "separator" }
  | {
      kind: "item";
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      tone?: "danger";
    };

/** Build the agent-tab right-click menu for a given tab. Mirrors the
 *  controls the old header bar carried (Memory/history, splits, detach,
 *  close pane, leave split, story, blocks, restart, stop) with the SAME
 *  behaviors — splits/detach/blocks/restart/stop are dispatched to the
 *  live surface via the pane-action bridge; Memory opens the History
 *  sidebar exactly as the header's AuraChip rows did. */
export function buildAgentTabMenuItems(opts: {
  sessionId: string;
  /** True when this tab participates in the active split layout. Gates
   *  the "Leave split view" item the way the old header did. */
  inSplit: boolean;
  /** True when the split has >2 panes and this one can be dropped on
   *  its own — gates "Close this pane". */
  canClosePane: boolean;
}): AgentTabMenuItem[] {
  const fire = (action: AgentPaneAction) => () =>
    dispatchAgentPaneAction(opts.sessionId, action);
  const items: AgentTabMenuItem[] = [];
  items.push({
    kind: "item",
    label: "Memory — open history",
    onSelect: () => window.dispatchEvent(new Event("aura:open-history")),
  });
  items.push({ kind: "separator" });
  items.push({ kind: "item", label: "Split right", onSelect: fire("split-right") });
  items.push({ kind: "item", label: "Split down", onSelect: fire("split-down") });
  items.push({
    kind: "item",
    label: "Detach to window",
    onSelect: fire("detach"),
  });
  if (opts.canClosePane) {
    items.push({
      kind: "item",
      label: "Close this pane",
      onSelect: fire("close-pane"),
    });
  }
  if (opts.inSplit) {
    items.push({
      kind: "item",
      label: "Leave split view",
      onSelect: fire("leave-split"),
    });
  }
  items.push({ kind: "separator" });
  items.push({ kind: "item", label: "Open Story", onSelect: fire("open-story") });
  items.push({
    kind: "item",
    label: "Readable chat ⇄ Terminal",
    onSelect: fire("toggle-transcript"),
  });
  items.push({
    kind: "item",
    label: "Show / hide Blocks",
    onSelect: fire("toggle-blocks"),
  });
  items.push({ kind: "separator" });
  items.push({
    kind: "item",
    label: "Restart agent",
    onSelect: fire("restart"),
  });
  items.push({
    kind: "item",
    label: "Stop session",
    onSelect: fire("stop"),
    tone: "danger",
  });
  return items;
}

type AgentSurfaceProps = {
  tab: AgentTab;
  /** Strict-mode posture is no longer rendered here (the bubble UI's
   *  SessionInfoCard owned that pill). Kept on the prop for caller
   *  back-compat — the WorkSurface still threads it through. */
  strictMode?: import("../../lib/api").StrictModeInfo["mode"];
  /** Index of this surface inside an N-pane split. When undefined,
   *  the surface owns the full work area (no Close-pane button). */
  paneIndex?: number;
  /** Drop this pane from the active split. Only present when the
   *  surface is rendered inside a split layout. */
  onClosePane?: () => void;
};

export function AgentSurface({ tab, paneIndex, onClosePane }: AgentSurfaceProps) {
  // `chat` mode = HTTP chat-completions adapter (Ollama / HF / Together /
  // Groq / OpenRouter / vLLM). Hosted entirely in JS, no PTY — so it
  // gets its own surface instead of the xterm-backed PtySurface. Every
  // other mode (the legacy "stream" + the canonical "pty") falls
  // through to the PTY surface; "stream" is no longer reachable from
  // any user gesture, kept for defensively rehydrating an old tab.
  if (tab.mode === "chat") {
    return <OpenAiCompatChatView tab={tab} />;
  }
  return <PtySurface tab={tab} paneIndex={paneIndex} onClosePane={onClosePane} />;
}

function PtySurface({ tab, onClosePane }: AgentSurfaceProps) {
  const store = useEditorStore();
  const channel = streamChannel(tab.agentId, tab.repoRoot);
  // The dead-PTY "Agent exited · Restart" banner lives in AgentTerminalView
  // (it owns its own exit listener), so the surface no longer mirrors that
  // state here — it only tracks an in-flight Restart to debounce double-fires.
  const [restarting, setRestarting] = useState(false);
  const [splitting, setSplitting] = useState<WorkSplitDirection | null>(null);
  // Optional raw event drawer. Product context lives in the right-rail
  // Story tab and concrete git review lives in Source Control, so the
  // terminal keeps full width by default.
  const [sideView, setSideView] = useState<"blocks" | null>(null);
  // Main view: the live xterm (default — agent CLIs are full TUIs) or the
  // engine-agnostic readable transcript built from the PARSED stream (clean,
  // not raw bytes). The terminal stays mounted under the transcript so the
  // PTY keeps streaming and answering happens there. Only offered when this
  // agent has a wired normalizer (Claude today; more as adapters land).
  const canChat = canNormalize(tab.agentId);
  const [mainView, setMainView] = useState<"terminal" | "chat">("terminal");

  useEffect(() => {
    bindChannelMeta(channel, { agentId: tab.agentId, repoRoot: tab.repoRoot });
  }, [channel, tab.agentId, tab.repoRoot]);

  // Restored-tab respawn. After a shell restart the persisted tab
  // still carries the prior PTY's handle id, but the actual child is
  // dead. Check the handle first so an explicit new agent launch does
  // not immediately duplicate itself when the surface mounts.
  //
  // For Claude we resume the most recent session for this repo so the
  // prior conversation is intact instead of starting blank. The id we
  // need is Claude's OWN session id (the JSONL file stem under
  // `~/.claude/projects/<encoded-repo>/`), NOT the Tauri tab id we
  // assigned — those are different uuid spaces. `claudeListSessions`
  // returns the on-disk stems sorted newest-first, so the head is the
  // one whose conversation the user just left.
  //
  // Gemini / Codex / Cursor have no cross-process resume protocol, so
  // we just spawn a fresh PTY in the same workspace and leave the CLI
  // to do whatever it can with its own local state.
  useEffect(() => {
    // Cold restore: a tab rehydrated from a workspace snapshot comes back
    // dormant and must NOT auto-respawn — the user resumes it explicitly
    // from the AgentTerminalView "Start agent" overlay. Without this gate
    // the resume-spawn below relaunches every restored agent on reopen,
    // which is the swarm-of-Claude-instances bug this whole change fixes.
    if (tab.dormant) return;
    let cancelled = false;
    (async () => {
      // Held across the resume spawn so a sibling tab restoring in the same
      // burst can't `--resume` the same session (released in the finally).
      let claimedResume: string | null = null;
      try {
        const alive = await api.agentPtyIsAlive(tab.sessionId);
        console.log("[resume] mount", {
          agent: tab.agentId,
          repo: tab.repoRoot,
          oldSid: tab.sessionId,
          alive,
        });
        if (cancelled || alive) return;

        let resumeId: string | undefined;
        if (tab.agentId === "claude") {
          // Resume ONLY a session launched from THIS worktree. `claude_list_sessions`
          // unions sibling worktrees + the main checkout (so the manual /resume
          // picker can find any transcript), but auto-resume must not inherit
          // that union — an unscoped resume let a `granada` tab silently reopen
          // a `zagreb` (or main-repo) session, and several tabs collapse onto
          // the one newest-on-disk file. See lib/agentSessionScope.
          //
          // Prefer the session THIS exact tab was bound to (durable, per-tab —
          // the live-tail effect stamps `tab.resumeSessionId` with the JSONL
          // this tab actually appends to), then the channel pin — but a
          // candidate is honoured only if it belongs to this worktree. A
          // foreign or missing candidate → fresh, never a sibling's convo.
          const own = await ownWorktreeSessions(tab.repoRoot);
          if (cancelled) return;
          const ownIds = new Set(own.map((s) => s.session_id));
          let cand: string | undefined;
          if (tab.resumeSessionId) cand = tab.resumeSessionId;
          if (!cand) {
            const pinned = readPersistedSession(channel);
            if (pinned?.session_id) cand = pinned.session_id;
          }
          if (cand && ownIds.has(cand)) {
            resumeId = cand;
          } else if (!cand) {
            // No binding/pin of our own: fall back to this worktree's newest
            // meaningful session (skip empty single-greeting leftovers), never
            // a sibling's.
            const meaningful = own.find((s) => s.turn_count >= 2) ?? own[0];
            if (meaningful?.session_id) resumeId = meaningful.session_id;
          }
          // Two tabs restoring together must not `--resume` the SAME session
          // (two PTYs, one conversation). First to claim it keeps it; a sibling
          // that lands on an in-flight id starts fresh. Released in the finally.
          if (resumeId) {
            if (tryClaimResume(tab.repoRoot, resumeId)) claimedResume = resumeId;
            else resumeId = undefined;
          }
        } else if (tab.agentId === "gemini") {
          // Gemini's `--resume <id|index|latest>` is in the official CLI;
          // "latest" loads the most recent session for the current
          // project, which is what we want on a desktop restart. The
          // provider also writes per-project session files under
          // `~/.gemini/tmp/<hash>/chats/` so the lookup is automatic.
          resumeId = "latest";
        }

        console.log("[resume] spawning", {
          agent: tab.agentId,
          resumeId,
        });
        const handle = await api.agentPtyOpen(
          tab.agentId,
          tab.repoRoot,
          80,
          24,
          resumeId,
          true,
        );
        if (cancelled || handle.id === tab.sessionId) return;
        // Drop the dead session's per-session caches before the id swap.
        // Both stores are keyed by sessionId and the old id is about to
        // be orphaned by replaceAgent — without this its Entry (event
        // store) and block state (session store) linger in their module
        // Maps for the life of the app, the way stop()/restart() already
        // avoid. (Not forgetAgentStream: it's keyed by agent+repo, which
        // the resumed session reuses, so wiping it would drop the very
        // stream state we just restored.)
        forgetAgentSession(tab.sessionId);
        forgetAgentEvent(tab.sessionId);
        store.replaceAgent(tab.sessionId, {
          sessionId: handle.id,
          agentId: tab.agentId,
          agentLabel: tab.agentLabel,
          agentMonogram: tab.agentMonogram,
          repoRoot: tab.repoRoot,
          mode: "pty",
          resumeSessionId: tab.resumeSessionId,
        });
        // Carry the durable per-tab binding onto the new session id so the
        // next restart resumes THIS conversation again, not the repo's newest.
        // (replaceAgent also carries it forward; this re-asserts it against the
        // freshly-resolved id for the case where it came from the fallback.)
        if (tab.agentId === "claude" && resumeId) {
          store.bindAgentResumeSession(handle.id, resumeId);
        }
      } catch (e) {
        console.warn("[pty] respawn failed:", e);
      } finally {
        if (claimedResume) releaseResume(tab.repoRoot, claimedResume);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally only on first mount — reactive runs would respawn
    // on every label/icon edit. The replaceAgent path will rerender
    // with the fresh sessionId on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-tail Claude's own session log so the UI view stays in sync
  // with what the user types into the terminal. We discover the
  // session JSONL by picking the most recently modified file under
  // ~/.claude/projects/<encoded-repo>/ — the PTY child has just
  // appended to it, so the newest one is ours. Then back-end watcher
  // emits StreamEvents on `claude-session:<sid>`; we forward them
  // into the agent stream channel so AgentStreamView sees them.
  useEffect(() => {
    if (tab.agentId !== "claude") return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    // Holds the in-flight watch-registration promise so cleanup can
    // sequence the unwatch *after* it settles. A bare boolean would miss
    // the window where the tab unmounts mid-`await` (flag still false →
    // unwatch skipped → backend polling task leaks).
    let watchStarted: Promise<unknown> | null = null;

    (async () => {
      // Tiny grace period — gives claude a moment to write its first
      // line so claudeListSessions surfaces the right file.
      await new Promise((r) => setTimeout(r, 500));
      if (cancelled) return;
      try {
        const list = await api.claudeListSessions(tab.repoRoot);
        if (cancelled) return;
        // Follow/bind ONLY a session launched from THIS worktree. The list
        // unions sibling worktrees + the main checkout, and binding to a
        // sibling's newest file is exactly what made a `granada` tab silently
        // reopen `zagreb`'s conversation. If this tab resumed a known own
        // session, that file is ours by id. Otherwise (a fresh tab) take this
        // worktree's newest own session that no sibling tab already claims, so
        // two fresh tabs launched together don't both grab the one newest file.
        const takenBySiblings = new Set(
          store.agentTabs
            .filter(
              (x) => x.sessionId !== tab.sessionId && x.repoRoot === tab.repoRoot,
            )
            .map((x) => x.resumeSessionId)
            .filter((v): v is string => !!v),
        );
        const boundOwn = tab.resumeSessionId
          ? list.find(
              (s) =>
                s.session_id === tab.resumeSessionId &&
                isOwnWorktreeSession(s, tab.repoRoot),
            )
          : undefined;
        const mine =
          boundOwn ??
          list.find(
            (s) =>
              isOwnWorktreeSession(s, tab.repoRoot) &&
              !takenBySiblings.has(s.session_id),
          ) ??
          list.find((s) => isOwnWorktreeSession(s, tab.repoRoot));
        // Nothing authored in this worktree yet (e.g. claude is still writing
        // its first line, or the tab is on a sibling's convo we won't adopt) —
        // leave the tab unbound rather than stamp a foreign session onto it.
        if (!mine) return;
        // Pin this tab's live session so a later shell restart resumes exactly
        // it (the mount-resume effect reads this first).
        persistLastSession(channel, mine);
        // Also stamp the DURABLE per-tab binding. Unlike the channel pin
        // (shared by every same-repo Claude tab), this rides on the tab
        // itself and is persisted with it — so "Start all" reopens each tab's
        // own conversation. This is the load-bearing write for the fix.
        store.bindAgentResumeSession(tab.sessionId, mine.session_id);
        unlisten = await listen<import("../../lib/api").StreamEvent>(
          `claude-session:${tab.sessionId}`,
          (e) => pushEvent(channel, e.payload),
        );
        if (cancelled) {
          unlisten?.();
          return;
        }
        watchStarted = api.claudeSessionWatch(tab.sessionId, mine.file_path);
        await watchStarted;
      } catch {
        /* best-effort */
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      // Sequence the unwatch *after* the registration settles. If the tab
      // unmounts while `claudeSessionWatch` is still in flight, firing
      // unwatch now would either no-op (watcher not yet in the map) or be
      // skipped entirely — both leak the 500ms polling task, which keeps
      // tailing the JSONL and pushing to cloud for the app's lifetime.
      // Chaining off the promise guarantees watch-then-unwatch ordering.
      if (watchStarted) {
        watchStarted
          .catch(() => {})
          .then(() => api.claudeSessionUnwatch(tab.sessionId))
          .catch(() => {});
      }
    };
  }, [tab.sessionId, tab.repoRoot, tab.agentId, channel]);

  // Clear the in-flight Restart flag whenever the tab's sessionId changes —
  // a successful restart() swaps in a fresh child id, and that transition is
  // what releases the debounce (restart() only self-clears on failure).
  useEffect(() => {
    setRestarting(false);
  }, [tab.sessionId]);

  // BlockCard's re-run action dispatches `aura:rerun-prompt` with the
  // original prompt text. Inject it into this PTY via the same
  // bracketed-paste path the Composer uses, but only when the event
  // targets THIS session — multiple agent tabs subscribe to the same
  // window event.
  useEffect(() => {
    function onRerun(e: Event) {
      const detail = (e as CustomEvent<{ sessionId: string; text: string }>).detail;
      if (!detail || detail.sessionId !== tab.sessionId) return;
      api.agentPtySendPrompt(tab.sessionId, detail.text).catch((err) => {
        console.warn("[pty] rerun failed:", err);
      });
    }
    window.addEventListener("aura:rerun-prompt", onRerun);
    return () => window.removeEventListener("aura:rerun-prompt", onRerun);
  }, [tab.sessionId]);

  function stop() {
    api.agentPtyClose(tab.sessionId).catch(() => {});
    api.claudeSessionUnwatch(tab.sessionId).catch(() => {});
    forgetAgentSession(tab.sessionId);
    forgetAgentEvent(tab.sessionId);
    forgetAgentStream(channel);
    store.closeAgent(tab.sessionId);
  }

  // Re-spawn the agent CLI in this same tab. agent_pty_close purges the
  // stale registry entry so the subsequent agent_pty_open returns a
  // fresh session id (instead of the cached dead one). replaceAgent
  // swaps the tab's sessionId in place so AgentTerminalView remounts on
  // the new id without closing the tab.
  async function restart() {
    setRestarting(true);
    try {
      await api.agentPtyClose(tab.sessionId);
      forgetAgentSession(tab.sessionId);
      forgetAgentEvent(tab.sessionId);
      forgetAgentStream(channel);
      const handle = await api.agentPtyOpen(
        tab.agentId,
        tab.repoRoot,
        80,
        24,
        undefined,
        true,
      );
      store.replaceAgent(tab.sessionId, {
        sessionId: handle.id,
        agentId: tab.agentId,
        agentLabel: tab.agentLabel,
        agentMonogram: tab.agentMonogram,
        repoRoot: tab.repoRoot,
        mode: "pty",
      });
    } catch (e) {
      console.warn("[pty] restart failed:", e);
      setRestarting(false);
    }
  }

  function splitAgent(direction: WorkSplitDirection) {
    // The split now drops an empty sibling pane; the user picks what
    // goes there from the EmptyPanePicker (cross-workspace agents,
    // terminals, files, managers, or spawn-new).
    if (splitting) return;
    setSplitting(direction);
    try {
      store.splitWithEmpty({ kind: "agent", id: tab.sessionId }, direction);
    } finally {
      setSplitting(null);
    }
  }

  // Resume (or fresh-spawn) the agent CLI for a specific tab and swap its
  // sessionId in place. Shared by the dormant-tab Start affordances so a
  // cold restore resumes the prior conversation instead of booting blank
  // — same claude/gemini resume logic as the live-tab mount respawn
  // above, but parameterised by tab so "Start all" can drive every paused
  // agent, not just this one.
  async function spawnTab(t: AgentTab, claimed?: Set<string>) {
    try {
      await api.agentPtyClose(t.sessionId).catch(() => {});
      forgetAgentSession(t.sessionId);
      forgetAgentEvent(t.sessionId);
      const tabChannel = streamChannel(t.agentId, t.repoRoot);
      forgetAgentStream(tabChannel);
      let resumeId: string | undefined;
      if (t.agentId === "claude") {
        // Precedence MUST match the mount-resume path (see the mount effect):
        //   1. this tab's OWN durable binding (`t.resumeSessionId`), then
        //   2. the channel pin as a fallback.
        // The channel pin (`aura.lastSession.<agent@repo>`) is keyed by
        // agent+repo, so every same-repo Claude tab reads the SAME value —
        // reading it first is exactly why "Start all" snapped every tab onto
        // one session (the swarm-of-clones bug). Reading the per-tab id first
        // gives each tab back its own conversation.
        //
        // We deliberately DROP the old "newest meaningful session in the repo"
        // fallback here: a tab with no binding of its own must start FRESH, not
        // clone whichever sibling happens to be newest on disk. Without a
        // resumeId, agent_pty_open boots a brand-new session.
        //
        // And — like the mount path — a candidate is honoured ONLY if it was
        // launched from THIS worktree. `claude_list_sessions` unions sibling
        // worktrees, so an unscoped resume let a `granada` tab reopen a
        // `zagreb` session. A foreign candidate → fresh. See agentSessionScope.
        let cand: string | undefined;
        if (t.resumeSessionId) cand = t.resumeSessionId;
        if (!cand) {
          const pinned = readPersistedSession(tabChannel);
          if (pinned?.session_id) cand = pinned.session_id;
        }
        if (cand) {
          const own = await ownWorktreeSessions(t.repoRoot);
          if (own.some((s) => s.session_id === cand)) resumeId = cand;
        }
      } else if (t.agentId === "gemini") {
        resumeId = "latest";
      }
      // No two tabs in a single "Start all" pass may resume the SAME session.
      // Tabs without their own `resumeSessionId` all fall back to the shared
      // per-repo channel pin, so — even with per-tab id read first — every
      // bindingless Claude tab would still resolve onto ONE conversation (the
      // swarm-of-clones bug, now narrowed to unbound tabs). Dedup on the
      // resolved id: the first tab to claim it keeps it; any later tab that
      // lands on an already-claimed id starts FRESH instead of cloning it.
      // Passed only by startAllDormant — a lone single-tab respawn keeps its
      // pin-resume (no set → no dedup).
      if (resumeId && claimed) {
        if (claimed.has(resumeId)) resumeId = undefined;
        else claimed.add(resumeId);
      }
      const handle = await api.agentPtyOpen(
        t.agentId,
        t.repoRoot,
        80,
        24,
        resumeId,
        true,
      );
      if (handle.id === t.sessionId) return;
      store.replaceAgent(t.sessionId, {
        sessionId: handle.id,
        agentId: t.agentId,
        agentLabel: t.agentLabel,
        agentMonogram: t.agentMonogram,
        repoRoot: t.repoRoot,
        mode: "pty",
        resumeSessionId: t.resumeSessionId,
      });
      // Carry the durable per-tab binding onto the freshly-resolved session id
      // so the NEXT restart resumes THIS conversation again — mirrors the
      // mount-resume path's post-swap re-bind.
      if (t.agentId === "claude" && resumeId) {
        store.bindAgentResumeSession(handle.id, resumeId);
      }
    } catch (e) {
      console.warn("[pty] spawn failed:", e);
    }
  }

  // Every paused (dormant) agent in the current workspace. Drives the
  // "Start all (N)" affordance on the overlay.
  const dormantTabs = store.agentTabs.filter((t) => t.dormant);
  async function startAllDormant() {
    // Sequential, not a thundering herd of simultaneous CLI launches —
    // each tab's view flips live as its replaceAgent lands. The shared
    // `claimed` set guarantees no two tabs in this pass resume the same
    // session — the fix for "Start all" snapping every tab onto one convo.
    const claimed = new Set<string>();
    for (const t of dormantTabs) {
      await spawnTab(t, claimed);
    }
  }

  const inSplit =
    !!store.splitLayout &&
    treeLeaves(store.splitLayout).some((p) => paneRefMatches(p, "agent", tab.sessionId));

  // Detach this live session into its own OS window. The PTY lives in the
  // Rust backend keyed by session id, so the popout re-attaches to the same
  // `agent-pty:<sid>` stream; we then drop the in-app tab so the session
  // "moves" rather than mirrors (two xterms would fight over PTY resize).
  // Open the window first so a creation failure never leaves the PTY
  // view-less.
  async function detach() {
    await openPopout({
      kind: "agent",
      root: tab.repoRoot,
      sessionId: tab.sessionId,
      agentId: tab.agentId,
      label: tab.agentLabel,
      title: `${tab.agentLabel} — ${shortRoot(tab.repoRoot)}`,
    });
    store.closeAgent(tab.sessionId);
  }

  // Pane-action bridge. The agent tab's right-click menu (Tabs.tsx) fires a
  // sessionId-scoped `aura:agent-pane-action`; the live surface that owns
  // these handlers + state executes it. This replaces the old header bar's
  // buttons — same behaviors, just relocated to the tab context menu.
  // Multiple agent tabs share the window bus, so we ignore events for
  // other sessions.
  useEffect(() => {
    function onPaneAction(e: Event) {
      const detail = (e as CustomEvent<AgentPaneActionDetail>).detail;
      if (!detail || detail.sessionId !== tab.sessionId) return;
      switch (detail.action) {
        case "split-right":
          splitAgent("row");
          break;
        case "split-down":
          splitAgent("column");
          break;
        case "detach":
          detach().catch((err) => console.warn("[pty] detach failed:", err));
          break;
        case "close-pane":
          if (
            inSplit &&
            onClosePane &&
            store.splitLayout &&
            treePaneCount(store.splitLayout) > 2
          ) {
            onClosePane();
          }
          break;
        case "leave-split":
          store.clearSplitLayout();
          break;
        case "open-story":
          openStory();
          break;
        case "toggle-blocks":
          setSideView((v) => (v === "blocks" ? null : "blocks"));
          break;
        case "toggle-transcript":
          if (canChat) setMainView((v) => (v === "chat" ? "terminal" : "chat"));
          break;
        case "restart":
          // restart() kills + re-spawns regardless of exited state, so it's
          // valid on a live session too; only block a concurrent restart.
          if (!restarting) restart();
          break;
        case "stop":
          stop();
          break;
      }
    }
    window.addEventListener(AGENT_PANE_ACTION_EVENT, onPaneAction);
    return () => window.removeEventListener(AGENT_PANE_ACTION_EVENT, onPaneAction);
    // Re-bind when the gating state changes so the handler closes over
    // fresh values (split membership, restarting flag, the close-pane
    // callback). splitAgent/stop/restart/detach read tab.sessionId, which
    // is in the dep list.
  }, [tab.sessionId, inSplit, restarting, onClosePane, store.splitLayout]);

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      {/* The agent header bar was removed — its controls (splits, detach,
          close pane, leave split, story, blocks, restart, stop, Memory)
          now live in the agent TAB's right-click menu, and live status
          shows as a dot on the tab itself. The surface is terminal +
          optional Blocks drawer, nothing else. */}

      {/* Terminal is the canonical surface — agent CLIs are full TUIs.
          Product context lives in the right-rail Story tab; the optional
          Blocks drawer is raw diagnostic context only. */}
      <div className="flex-1 min-h-0 relative flex">
        <div className="flex-1 min-w-0 relative">
          {/* The terminal stays MOUNTED even when the readable transcript is
              shown — hiding it via CSS keeps the PTY alive and streaming so
              the parsed events keep filling the transcript and answers can be
              typed the instant the user flips back. */}
          <div
            className="absolute inset-0"
            style={{ visibility: mainView === "chat" ? "hidden" : "visible" }}
          >
            <AgentTerminalView
              sessionId={tab.sessionId}
              dormant={tab.dormant}
              dormantCount={dormantTabs.length}
              onStartAll={dormantTabs.length > 1 ? startAllDormant : undefined}
              // Dead PTY detected at mount (dormant Start) or via mid-session
              // exit. spawnTab purges the stale registry entry, resumes the
              // prior conversation (claude/gemini) with a fresh agent_pty_open,
              // and replaceAgent swaps tab.sessionId so AgentTerminalView
              // remounts on the new id with no banner.
              onAutoRespawn={() => spawnTab(tab)}
            />
          </div>
          {mainView === "chat" && (
            <div className="absolute inset-0">
              <NormalizedTranscript
                channel={channel}
                agentId={tab.agentId}
                repoRoot={tab.repoRoot}
                ptySessionId={tab.sessionId}
                onRespondInTerminal={() => setMainView("terminal")}
              />
            </div>
          )}
          {canChat && (
            <div className="absolute top-2 right-2 z-10 flex items-center rounded-md overflow-hidden shadow-sm"
              style={{ border: "1px solid var(--color-line-soft)", background: "var(--color-bg-1)" }}
            >
              <ViewToggleButton
                active={mainView === "terminal"}
                onClick={() => setMainView("terminal")}
                label="Terminal"
              />
              <ViewToggleButton
                active={mainView === "chat"}
                onClick={() => setMainView("chat")}
                label="Chat"
              />
            </div>
          )}
        </div>
        {sideView === "blocks" && (
          <div
            className="flex-shrink-0 border-l border-line-soft bg-bg-1 overflow-y-auto"
            style={{ width: "min(420px, 40vw)" }}
          >
            <AgentBlocksView sessionId={tab.sessionId} />
          </div>
        )}
      </div>
    </div>
  );
}



/** Compact Terminal⇄Chat segmented toggle shown over the agent surface when the
 *  engine has a wired normalizer. Active = arctic-blue accent wash; inactive =
 *  muted text. Two of these sit flush in a single bordered group. */
function ViewToggleButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 h-6 text-[11px] font-medium transition-colors"
      style={{
        background: active
          ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
          : "transparent",
        color: active ? "var(--color-accent)" : "var(--color-text-3)",
      }}
    >
      {label}
    </button>
  );
}

function shortRoot(root: string): string {
  const parts = root.split("/").filter(Boolean);
  if (parts.length <= 2) return root;
  return ".../" + parts.slice(-2).join("/");
}

function openStory() {
  window.dispatchEvent(new CustomEvent("aura:open-story"));
}

function paneRefMatches(
  ref: { kind: string; id?: string; path?: string },
  kind: string,
  id: string,
): boolean {
  return ref.kind === kind && ref.id === id;
}
