// Manager session surface. The primary view is the chat surface
// (`ManagerChatView`) — the brain (Anthropic Messages API + tool calling
// on the Rust side) takes the user prompt, narrates progress in bubbles,
// and dispatches subagent work via tool_use cards. Details (DAG / ribbon /
// per-task drilldown) live in a side pane the user opts into.
//
// Visual chrome: ports the Forge Chat-States panel shell (Stage 11.6).
// The header is the prototype's `.p-tabs` strip — one active tab pill
// (status dot + objective summary) + new-thread/more icon buttons on
// the right. The session menu (Show details / Compare worktrees / Cancel)
// sits under the i-more button.

import { useCallback, useEffect, useRef, useState } from "react";
import { useManagerSession } from "../../lib/managerStore";
import { useEditorStore } from "../../lib/editorStore";
import { stripSteeringDirective } from "../../lib/steeringDirective";
import {
  api,
  type AgentInfo,
  type ClaudeSession,
  type ManagerOverrideMode,
  type ManagerSession,
  type ManagerStatus,
  type ManagerSummary,
  type ManagerTask,
  type ManagerTaskStatus,
  type RibbonEntry,
  type UsageReport,
} from "../../lib/api";
import { listen } from "@tauri-apps/api/event";
import { DagView } from "./DagView";
import { ManagerChatView } from "./ManagerChatView";
import { LoopPanel } from "./LoopPanel";
import { MemoryBadge } from "./MemoryBadge";
import { ChatIconsSprite } from "./ChatIconsSprite";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentIcon } from "../agent/AgentIcon";
import { ResumeElsewhere } from "./chat/ResumeElsewhere";

const DETAILS_PREF = "aura.manager.details_open";
const LOOP_PREF = "aura.manager.loop_open";

// ── Tab pane-action bridge ──────────────────────────────────────────────
// The chat surface no longer carries a dedicated header bar of controls.
// Split / details / loop / compare / cancel now live on the chat TAB's
// right-click menu (consistent with the agent tabs). A menu item can't reach
// into the live surface's React state directly, so it fires a sessionId-scoped
// window event the owning ManagerSurface listens for — the same pattern the
// agent surface uses (`aura:agent-pane-action`).
export const MANAGER_PANE_ACTION_EVENT = "aura:manager-pane-action";

export type ManagerPaneAction =
  | "split-right"
  | "split-down"
  | "toggle-details"
  | "toggle-loop"
  | "compare"
  | "cancel";

export type ManagerPaneActionDetail = {
  sessionId: string;
  action: ManagerPaneAction;
};

// Placeholder shown while the session snapshot is still loading. A session
// hydrated from a large CLI transcript can take a beat to come back over IPC;
// this must never read as a frozen dead-end. So: a live spinner + elapsed
// counter, and after a long wait an escape hatch (close the tab and reopen)
// so the user is never trapped staring at "Loading…" with nothing to do.
function LoadingSession({ sessionId }: { sessionId: string }) {
  const editor = useEditorStore();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const slow = elapsed >= 12;
  return (
    <div className="h-full w-full flex items-center justify-center bg-bg-0">
      <div className="flex max-w-[300px] flex-col items-center gap-3 px-6 text-center">
        <div className="h-5 w-5 rounded-full border-2 border-line border-t-text-3 animate-spin" />
        <div className="text-[13px] text-text-2">
          Loading conversation…
          {elapsed >= 3 && <span className="text-text-4"> · {elapsed}s</span>}
        </div>
        {slow && (
          <>
            <p className="text-[11.5px] leading-relaxed text-text-4">
              A long session can take a moment to open. You can keep waiting, or
              close this tab and reopen it.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => editor.closeManager(sessionId)}
            >
              Close tab
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Fire a pane action at the live ManagerSurface that owns `sessionId`. */
export function dispatchManagerPaneAction(
  sessionId: string,
  action: ManagerPaneAction,
) {
  window.dispatchEvent(
    new CustomEvent<ManagerPaneActionDetail>(MANAGER_PANE_ACTION_EVENT, {
      detail: { sessionId, action },
    }),
  );
}

/** One descriptor in the chat-tab context menu. Rendered by Tabs.tsx /
 *  WorkSurface as ContextMenuItems; produced here so the surface stays the
 *  single source of truth for which actions exist and how they fire. */
export type ManagerTabMenuItem =
  | { kind: "separator" }
  | {
      kind: "item";
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      tone?: "danger";
    };

/** Build the chat-tab right-click menu — the controls the old `.p-tabs`
 *  header bar carried. History/Memory open their global popovers; the rest
 *  fire at the live surface via the pane-action bridge. */
export function buildManagerTabMenuItems(opts: {
  sessionId: string;
  /** Suppress "Cancel session" once the session has finished/cancelled. */
  isTerminal?: boolean;
}): ManagerTabMenuItem[] {
  const fire = (action: ManagerPaneAction) => () =>
    dispatchManagerPaneAction(opts.sessionId, action);
  const items: ManagerTabMenuItem[] = [];
  items.push({
    kind: "item",
    label: "Chat history",
    onSelect: () =>
      window.dispatchEvent(new Event("aura:manager:open-history")),
  });
  items.push({
    kind: "item",
    label: "Memory bank",
    onSelect: () => window.dispatchEvent(new Event("aura:manager:open-memory")),
  });
  items.push({ kind: "separator" });
  items.push({ kind: "item", label: "Split right", onSelect: fire("split-right") });
  items.push({ kind: "item", label: "Split down", onSelect: fire("split-down") });
  items.push({ kind: "separator" });
  items.push({
    kind: "item",
    label: "Show / hide details",
    onSelect: fire("toggle-details"),
  });
  items.push({
    kind: "item",
    label: "Show / hide loop",
    onSelect: fire("toggle-loop"),
  });
  items.push({
    kind: "item",
    label: "Compare parallel copies…",
    onSelect: fire("compare"),
  });
  items.push({
    kind: "item",
    label: "Open this chat in Claude Code",
    onSelect: () =>
      window.dispatchEvent(
        new CustomEvent("aura:open-chat-in-claude-code", {
          detail: { sessionId: opts.sessionId },
        }),
      ),
  });
  if (!opts.isTerminal) {
    items.push({ kind: "separator" });
    items.push({
      kind: "item",
      label: "Cancel session",
      onSelect: fire("cancel"),
      tone: "danger",
    });
  }
  return items;
}

type Props = {
  sessionId: string;
  /** Optional — when provided, the `+` icon-btn in the tabs strip starts
   *  a fresh ambient thread (used by AuraRailPanel). When absent the
   *  button is hidden. */
  onNewThread?: () => void;
  /** Optional — fan this chat into a side-by-side split (VS Code parity:
   *  every tab kind, including the Aura chat, can be split). When absent
   *  the split buttons are hidden (e.g. the right-rail mini surface). */
  onSplit?: (direction: "row" | "column") => void;
  /** When false the surface drops its own `.p-tabs` header bar — used in the
   *  workpane, where the chat renders inside the shared `<Tabs>` strip and the
   *  tab's right-click menu carries the controls. The rail/popout (no tab
   *  strip) keep the header (default true). */
  tabChrome?: boolean;
};

export function ManagerSurface({
  sessionId,
  onNewThread,
  onSplit,
  tabChrome = true,
}: Props) {
  const session = useManagerSession(sessionId);
  const [showDetails, setShowDetails] = useState<boolean>(
    () => localStorage.getItem(DETAILS_PREF) === "1",
  );
  const [showLoop, setShowLoop] = useState<boolean>(
    () => localStorage.getItem(LOOP_PREF) === "1",
  );
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // "Resume this chat elsewhere" sheet — carries this conversation into a real
  // agent CLI's own resume list (single-agent → that one CLI cleanly;
  // multi-agent → replicated into every agent it used). The sheet loads the
  // installed-agent list itself.
  const [showResume, setShowResume] = useState(false);

  useEffect(() => {
    localStorage.setItem(DETAILS_PREF, showDetails ? "1" : "0");
  }, [showDetails]);

  useEffect(() => {
    localStorage.setItem(LOOP_PREF, showLoop ? "1" : "0");
  }, [showLoop]);

  // Click-outside / Esc closes the More menu.
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (menuRef.current && t && !menuRef.current.contains(t)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Chat-tab right-click actions arrive here as a sessionId-scoped window
  // event (the controls that used to live on the `.p-tabs` header bar). Only
  // the surface that owns this sessionId reacts.
  useEffect(() => {
    function onPaneAction(e: Event) {
      const detail = (e as CustomEvent<ManagerPaneActionDetail>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      switch (detail.action) {
        case "split-right":
          onSplit?.("row");
          break;
        case "split-down":
          onSplit?.("column");
          break;
        case "toggle-details":
          setShowDetails((v) => !v);
          break;
        case "toggle-loop":
          setShowLoop((v) => !v);
          break;
        case "compare":
          window.dispatchEvent(new CustomEvent("aura:open-compare"));
          break;
        case "cancel":
          api.managerCancel(sessionId);
          break;
      }
    }
    window.addEventListener(MANAGER_PANE_ACTION_EVENT, onPaneAction);
    return () =>
      window.removeEventListener(MANAGER_PANE_ACTION_EVENT, onPaneAction);
  }, [sessionId, onSplit]);

  if (!session) {
    return <LoadingSession sessionId={sessionId} />;
  }

  const status = session.status;
  const inFlight = session.tasks.filter((t) => t.status === "running").length;
  const isTerminal = status === "completed" || status === "cancelled";
  const tabLabel = stripSteeringDirective(session.objective ?? "").trim() || "Aura";
  const dotKind: "streaming" | "green" | "faint" =
    status === "running" || inFlight > 0
      ? "streaming"
      : status === "completed"
        ? "green"
        : "faint";

  return (
    <div className="aura-chat panel h-full w-full">
      <ChatIconsSprite />
      {tabChrome && (
      <div className="p-tabs">
        <div className="p-tab active" title={tabLabel}>
          <span className={`dot ${dotKind}`} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {tabLabel}
          </span>
        </div>
        <div className="spacer" />
        <MemoryBadge repoRoot={session.projects[0]?.root ?? null} />
        <UsageChip session={session} />
        <SessionHistoryButton
          currentSessionId={sessionId}
          repoRoot={session.projects[0]?.root ?? null}
        />
        {onSplit && (
          <>
            <button
              type="button"
              className="icon-btn"
              title="Split right"
              onClick={() => onSplit("row")}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <rect x="2.5" y="3" width="11" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
                <line x1="8" y1="3.5" x2="8" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Split down"
              onClick={() => onSplit("column")}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <rect x="2.5" y="3" width="11" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
                <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
          </>
        )}
        {onNewThread && (
          <button
            type="button"
            className="icon-btn"
            title="New thread"
            onClick={onNewThread}
          >
            <svg className="ico"><use href="#i-plus" /></svg>
          </button>
        )}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            className="icon-btn"
            title="More"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg className="ico"><use href="#i-more" /></svg>
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-7 z-20 bg-bg-3 border border-line-soft rounded shadow-lg py-1 text-xs min-w-[180px]"
              onClick={(e) => e.stopPropagation()}
            >
              <MenuItem
                label={showDetails ? "Hide details" : "Show details"}
                onClick={() => {
                  setShowDetails((v) => !v);
                  setMenuOpen(false);
                }}
              />
              <MenuItem
                label={showLoop ? "Hide loop" : "Show loop"}
                onClick={() => {
                  setShowLoop((v) => !v);
                  setMenuOpen(false);
                }}
              />
              <MenuItem
                label="Compare parallel copies…"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("aura:open-compare"));
                  setMenuOpen(false);
                }}
              />
              {/* Carry this conversation into a real coding-agent CLI's own
                  resume list so it's never stranded inside Aura. The sheet
                  reads how many agents ran the chat and frames it: single-agent
                  → move cleanly into that CLI; multi-agent → replicate into
                  every agent it used as an imported transcript. */}
              <MenuItem
                label="Resume this chat elsewhere…"
                onClick={() => {
                  setShowResume(true);
                  setMenuOpen(false);
                }}
              />
              {!isTerminal && (
                <MenuItem
                  label="Cancel session"
                  tone="danger"
                  onClick={() => {
                    api.managerCancel(sessionId);
                    setMenuOpen(false);
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>
      )}

      {showResume && (
        <ResumeElsewhere
          sessionId={sessionId}
          chat={session.chat ?? []}
          onOpenInAgent={(agentId, agentLabel) => {
            window.dispatchEvent(
              new CustomEvent("aura:open-chat-in-agent", {
                detail: { sessionId, agentId, agentLabel },
              }),
            );
            setShowResume(false);
          }}
          onClose={() => setShowResume(false)}
        />
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0">
          <ManagerChatView session={session} />
        </div>
        {showDetails && (
          <div className="w-[360px] border-l border-line-soft min-h-0 flex flex-col bg-bg-0">
            <div className="px-3 py-1.5 border-b border-line-soft text-[10px] uppercase tracking-wider text-text-3 flex items-center justify-between">
              <span>Details</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-text-3 hover:text-text-1"
                onClick={() => setShowDetails(false)}
              >
                ✕
              </Button>
            </div>
            <DetailsPane
              session={session}
              sessionId={sessionId}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
            />
          </div>
        )}
        {showLoop && (
          <div className="w-[320px] border-l border-line-soft min-h-0 flex flex-col bg-bg-0">
            <LoopPanel repoRoot={session.projects[0]?.root ?? null} />
          </div>
        )}
      </div>

      {/* No own header bar (rendered inside the shared tab strip): History +
          Memory live as headless popovers anchored top-right, opened from the
          chat tab's right-click menu via window events. */}
      {!tabChrome && (
        <>
          <SessionHistoryButton
            headless
            currentSessionId={sessionId}
            repoRoot={session.projects[0]?.root ?? null}
          />
          <MemoryBadge
            headless
            repoRoot={session.projects[0]?.root ?? null}
          />
        </>
      )}
    </div>
  );
}

// History clock in the tabs strip — the answer to "how do I get back to a
// previous conversation?". Lists every Aura session (live + persisted, via
// `manager_list`), most-recent first; picking one re-homes it into the
// center workpane through `openManager`. Also opens when the `/resume`
// slash command fires the `aura:manager:open-history` event.
function SessionHistoryButton({
  currentSessionId,
  repoRoot,
  headless = false,
}: {
  currentSessionId: string;
  repoRoot: string | null;
  /** When true, render no trigger button — the popover is driven purely by
   *  the `aura:manager:open-history` event (the chat-tab right-click menu),
   *  anchored top-right. Used when the surface has no own header bar. */
  headless?: boolean;
}) {
  const editor = useEditorStore();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ManagerSummary[] | null>(null);
  // Cross-agent continuity — Claude Code CLI sessions for this workspace,
  // importable into a native Aura chat (full history hydrated as bubbles).
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[] | null>(
    null,
  );
  const [importing, setImporting] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    setSessions(null);
    // Scope native Aura sessions to the open workspace — a session from a
    // different workspace (e.g. New Git while Mixrank is open) must never
    // appear here, let alone be resumable into and touched. Claude sessions
    // below are already repoRoot-scoped.
    api
      .managerList(repoRoot)
      .then(setSessions)
      .catch(() => setSessions([]));
    if (repoRoot) {
      setClaudeSessions(null);
      api
        .claudeListSessions(repoRoot)
        .then(setClaudeSessions)
        .catch(() => setClaudeSessions([]));
    } else {
      setClaudeSessions([]);
    }
  }, [repoRoot]);

  // Import a Claude Code transcript into a fresh native Aura session, then
  // re-home it into the center workpane — same open path as picking an
  // existing Aura conversation, so history lands in the bubble view.
  const importClaude = (sess: ClaudeSession) => {
    if (!repoRoot || importing) return;
    setImporting(sess.session_id);
    api
      .managerImportAgentSession("claude", repoRoot, sess.session_id)
      .then((newSid) => {
        const label = (sess.last_prompt || sess.first_prompt || "Claude Code")
          .trim()
          .slice(0, 80);
        editor.openManager(newSid, label || "Claude Code");
        setOpen(false);
      })
      .catch((e) => console.warn("[manager] import claude session failed", e))
      .finally(() => setImporting(null));
  };

  // `/resume` (and aliases) dispatch this so the slash command and the
  // header button open the same surface.
  useEffect(() => {
    function onOpen() {
      setOpen(true);
      load();
    }
    window.addEventListener("aura:manager:open-history", onOpen);
    return () => window.removeEventListener("aura:manager:open-history", onOpen);
  }, [load]);

  // Click-outside / Esc closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (ref.current && t && !ref.current.contains(t)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((v) => {
      if (!v) load();
      return !v;
    });
  };

  const pick = (s: ManagerSummary) => {
    editor.openManager(s.id, stripSteeringDirective(s.objective ?? "").trim() || "Aura");
    setOpen(false);
  };

  return (
    <div
      ref={ref}
      className={headless ? "fixed top-11 right-3 z-40" : "relative"}
    >
      {!headless && (
        <button
          type="button"
          className="icon-btn"
          title="Chat history — resume a past conversation"
          onClick={toggle}
        >
          <svg className="ico"><use href="#i-history" /></svg>
        </button>
      )}
      {open && (
        <div className="absolute right-0 top-7 z-30 bg-bg-3 border border-line-soft rounded-lg shadow-xl py-1 text-xs w-[320px] max-h-[420px] overflow-auto">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-4">
            Resume a conversation
          </div>
          {sessions === null ? (
            <div className="px-3 py-3 text-text-3">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="px-3 py-3 text-text-3">No past conversations yet.</div>
          ) : (
            sessions.map((s) => {
              const isCurrent = s.id === currentSessionId;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={isCurrent}
                  onClick={() => pick(s)}
                  className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors ${
                    isCurrent ? "opacity-50 cursor-default" : "hover:bg-bg-2"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 rounded-full flex-none ${
                        HISTORY_DOT[s.status] ?? "bg-text-4"
                      }`}
                    />
                    <span className="flex-1 truncate text-text-1">
                      {s.objective?.trim() || "Untitled chat"}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] text-accent flex-none">current</span>
                    )}
                  </div>
                  <div className="pl-3.5 flex items-center gap-1.5 text-[10.5px] text-text-4">
                    <span>{relTime(s.updated_at)}</span>
                    {s.task_count > 0 && (
                      <span>· {s.done_count}/{s.task_count} tasks</span>
                    )}
                  </div>
                </button>
              );
            })
          )}
          {claudeSessions && claudeSessions.length > 0 && (
            <>
              <div className="mt-1 border-t border-line-soft" />
              <div className="px-3 py-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-4">
                <AgentIcon agentId="claude" size={11} />
                Resume from Claude Code
              </div>
              {claudeSessions.map((sess) => {
                const busy = importing === sess.session_id;
                const label =
                  (sess.last_prompt || sess.first_prompt || "").trim() ||
                  "Claude session";
                return (
                  <button
                    key={sess.session_id}
                    type="button"
                    disabled={importing != null}
                    onClick={() => importClaude(sess)}
                    className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors ${
                      importing != null && !busy
                        ? "opacity-50 cursor-default"
                        : "hover:bg-bg-2"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <AgentIcon agentId="claude" size={13} />
                      <span className="flex-1 truncate text-text-1">{label}</span>
                      {busy && (
                        <span className="text-[10px] text-accent flex-none">
                          importing…
                        </span>
                      )}
                    </div>
                    <div className="pl-[1.35rem] flex items-center gap-1.5 text-[10.5px] text-text-4">
                      <span>{relTime(sess.mtime)}</span>
                      {sess.turn_count > 0 && <span>· {sess.turn_count} turns</span>}
                      {sess.cwd_rel && (
                        <span className="truncate">· {sess.cwd_rel}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const HISTORY_DOT: Record<ManagerStatus, string> = {
  awaiting_approval: "bg-amber-400",
  running: "bg-sky-400",
  paused: "bg-text-4",
  completed: "bg-emerald-400",
  cancelled: "bg-rose-400",
};

// Compact relative time for session rows. `secs` is a unix-seconds stamp
// (created_at / updated_at), matching the backend's serialization.
function relTime(secs: number): string {
  const delta = Math.max(0, Date.now() / 1000 - secs);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 604800) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(secs * 1000).toLocaleDateString();
}

function MenuItem({
  label,
  onClick,
  tone,
}: {
  label: string;
  onClick: () => void;
  tone?: "danger";
}) {
  const cls =
    tone === "danger"
      ? "text-rose-300 hover:bg-rose-500/10"
      : "text-fg-strong hover:bg-bg-elev";
  return (
    <button className={`block w-full text-left px-3 py-1.5 ${cls}`} onClick={onClick}>
      {label}
    </button>
  );
}

function DetailsPane({
  session,
  sessionId,
  selectedTaskId,
  onSelectTask,
}: {
  session: ManagerSession;
  sessionId: string;
  selectedTaskId: number | null;
  onSelectTask: (id: number | null) => void;
}) {
  const selected = selectedTaskId
    ? session.tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  if (selected) {
    return (
      <TaskDetailPanel
        task={selected}
        sessionId={sessionId}
        onClose={() => onSelectTask(null)}
      />
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto p-3 border-b border-line-soft">
        {session.tasks.length === 0 ? (
          <div className="text-fg-muted text-xs">
            No tasks yet. Ask the Manager to do something.
          </div>
        ) : (
          <DagView
            tasks={session.tasks}
            sessionId={sessionId}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
            renderCard={(t, ref) => (
              <TaskCard
                key={t.id}
                task={t}
                sessionId={sessionId}
                selected={selectedTaskId === t.id}
                onSelect={() => onSelectTask(t.id)}
                cardRef={ref}
              />
            )}
          />
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3">
        <RibbonList ribbon={session.ribbon} />
      </div>
    </div>
  );
}

// Live token + cost chip — aggregates `aura usage today --json --project`
// across every project the session touches. Refreshes every 12s while the
// session is Running.
function UsageChip({ session }: { session: ManagerSession }) {
  const [agg, setAgg] = useState<UsageReport | null>(null);
  const projectKey = session.projects.map((p) => p.root).sort().join("|");
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      const reports = await Promise.all(
        session.projects.map((p) => api.auraUsageReport(p.root, "today")),
      );
      if (cancelled) return;
      const merged = reports.reduce<UsageReport | null>((acc, r) => {
        if (!r) return acc;
        if (!acc) return { ...r, byModel: [...r.byModel] };
        return {
          period: r.period,
          totalCostUsd: acc.totalCostUsd + r.totalCostUsd,
          totalInputTokens: acc.totalInputTokens + r.totalInputTokens,
          totalOutputTokens: acc.totalOutputTokens + r.totalOutputTokens,
          totalCacheReadTokens:
            acc.totalCacheReadTokens + r.totalCacheReadTokens,
          sessionCount: acc.sessionCount + r.sessionCount,
          byModel: mergeByModel(acc.byModel, r.byModel),
          // Per-dev rows are (month, developer, agent) buckets per project —
          // concatenation is the honest cross-project merge.
          byDeveloper: [...acc.byDeveloper, ...r.byDeveloper],
        };
      }, null);
      setAgg(merged);
    };
    void fetch();
    const isLive = session.status === "running" || session.status === "paused";
    if (!isLive) return;
    const id = setInterval(fetch, 12000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectKey, session.status]);

  if (!agg || agg.totalCostUsd < 0.0001) return null;

  const total = agg.totalInputTokens + agg.totalOutputTokens;
  const cacheSavings = agg.totalCacheReadTokens;
  const tooltip = [
    `Today across ${session.projects.length} project${session.projects.length === 1 ? "" : "s"}`,
    `${formatTokens(agg.totalInputTokens)} in · ${formatTokens(agg.totalOutputTokens)} out`,
    cacheSavings > 0 ? `${formatTokens(cacheSavings)} cache-read (saved)` : null,
    "",
    ...agg.byModel.map(
      (m) =>
        `${m.model}: ${formatTokens(m.inputTokens + m.outputTokens)} · ${formatCost(m.costUsd)}`,
    ),
  ]
    .filter((s) => s !== null)
    .join("\n");

  return (
    <div
      title={tooltip}
      className="flex items-center gap-1.5 text-[10.5px] px-2 py-0.5 rounded border border-line-soft"
    >
      <span className="font-medium text-fg-strong tabular-nums">
        {formatTokens(total)}
      </span>
      <span className="text-fg-muted">·</span>
      <span className="font-medium text-emerald-300 tabular-nums">
        {formatCost(agg.totalCostUsd)}
      </span>
    </div>
  );
}

function mergeByModel(
  a: UsageReport["byModel"],
  b: UsageReport["byModel"],
): UsageReport["byModel"] {
  const map = new Map<string, UsageReport["byModel"][number]>();
  for (const m of [...a, ...b]) {
    const cur = map.get(m.model);
    if (!cur) {
      map.set(m.model, { ...m });
      continue;
    }
    cur.inputTokens += m.inputTokens;
    cur.outputTokens += m.outputTokens;
    cur.costUsd += m.costUsd;
    cur.sessions += m.sessions;
  }
  return Array.from(map.values()).sort((x, y) => y.costUsd - x.costUsd);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function TaskCard({
  task,
  sessionId,
  selected,
  onSelect,
  cardRef,
}: {
  task: ManagerTask;
  sessionId: string;
  selected: boolean;
  onSelect: () => void;
  cardRef?: (el: HTMLDivElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  // Bucket O — live line counter + activity pulse. Subscribes to the
  // per-task stream channel `manager-task-stream:<sid>:<tid>` and
  // increments locally on each line; the persisted `task.line_count`
  // is the source of truth on first paint / after reload.
  const [liveCount, setLiveCount] = useState<number>(task.line_count ?? 0);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    setLiveCount(task.line_count ?? 0);
  }, [task.line_count]);
  useEffect(() => {
    if (task.status !== "running") return;
    const channel = `manager-task-stream:${sessionId}:${task.id}`;
    let cancelled = false;
    let pulseTimer: number | undefined;
    const unlistenP = listen<{ stream: string; line: string; ts: number }>(
      channel,
      () => {
        if (cancelled) return;
        setLiveCount((n) => n + 1);
        setPulse(true);
        if (pulseTimer) window.clearTimeout(pulseTimer);
        pulseTimer = window.setTimeout(() => setPulse(false), 350);
      }
    );
    return () => {
      cancelled = true;
      if (pulseTimer) window.clearTimeout(pulseTimer);
      unlistenP.then((u) => u()).catch(() => {});
    };
  }, [sessionId, task.id, task.status]);
  const ringClass = selected ? "ring-1 ring-emerald-400/60" : "";
  return (
    <div
      ref={cardRef}
      className={`relative rounded border ${TASK_BORDER[task.status] ?? "border-line-soft"} ${ringClass} bg-bg-elev p-2 min-w-[180px] max-w-[260px] cursor-pointer hover:bg-bg-chrome`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className={`h-2 w-2 rounded-full flex-none ${TASK_DOT[task.status] ?? "bg-fg-muted"}`} />
          <Badge variant="muted">{task.agent_id ?? "auto"}</Badge>
        </div>
        <button
          className="flex items-center justify-center w-5 h-5 rounded text-fg-muted hover:text-fg-strong hover:bg-bg-2 flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          title="More actions"
        >
          <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
            <circle cx="2" cy="5" r="0.9" />
            <circle cx="5" cy="5" r="0.9" />
            <circle cx="8" cy="5" r="0.9" />
          </svg>
        </button>
      </div>
      <div className="text-fg-strong t-sm mt-1.5 line-clamp-3">{task.description}</div>
      {(task.depends_on.length > 0 ||
        task.worktree_path ||
        task.a2a_task_id ||
        (task.pre_dispatch_snapshot_ids?.length ?? 0) > 0 ||
        liveCount > 0) && (
        <div className="flex flex-wrap items-center gap-1 mt-1.5">
          {task.depends_on.length > 0 && (
            <Badge variant="muted" title="Upstream task ids">
              ↑ {task.depends_on.join(",")}
            </Badge>
          )}
          {task.worktree_path && (
            <Badge variant="muted" title={`Isolated copy: ${task.worktree_path}`}>
              ⎇ {task.worktree_path.split("/").slice(-1)[0]}
            </Badge>
          )}
          {task.a2a_task_id && (
            <Badge variant="default" title={`A2A v1.2 task ${task.a2a_task_id}`}>
              ⇆ a2a:{task.a2a_task_id.split("-")[0]}
            </Badge>
          )}
          {(task.pre_dispatch_snapshot_ids?.length ?? 0) > 0 && (
            <Badge
              variant="muted"
              title={`Auto-snapshotted ${task.pre_dispatch_snapshot_ids!.length} file(s) before dispatch — recoverable via 'aura rewind --task ${task.id}'`}
            >
              ↺ {task.pre_dispatch_snapshot_ids!.length} snapshot
              {task.pre_dispatch_snapshot_ids!.length === 1 ? "" : "s"}
            </Badge>
          )}
          {liveCount > 0 && (
            <Badge
              variant="muted"
              title={
                task.status === "running"
                  ? `Live stream — ${liveCount} lines so far. Click to expand.`
                  : `Captured ${liveCount} lines while running.`
              }
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full mr-1 align-middle ${
                  pulse ? "bg-emerald-400" : "bg-fg-muted"
                } ${pulse ? "animate-pulse" : ""}`}
              />
              ≈{liveCount} lines
            </Badge>
          )}
        </div>
      )}
      {task.blocked_reason && (
        <div className="mt-1.5">
          <Badge variant="warn" title={task.blocked_reason}>
            ⚠ {task.blocked_reason}
          </Badge>
        </div>
      )}
      {(task.status === "done" ||
        task.status === "failed" ||
        task.status === "skipped") && (
        <RatingButtons sessionId={sessionId} task={task} />
      )}
      {open && (
        <TaskActions
          sessionId={sessionId}
          task={task}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/// Bucket F2 — thumbs row shown only on terminal tasks. Optimistic
/// click: flips the local state immediately, fires the Tauri command in
/// the background, snapshot reload reconciles. The current vote is read
/// from `task.pending_skill.user_rating`, which the backend persists
/// across reloads.
function RatingButtons({
  sessionId,
  task,
}: {
  sessionId: string;
  task: ManagerTask;
}) {
  const persisted = task.pending_skill?.user_rating ?? null;
  const [optimistic, setOptimistic] = useState<-1 | 1 | null>(null);
  const current = optimistic ?? (persisted === 1 || persisted === -1 ? persisted : null);
  const fire = (rating: -1 | 1, e: React.MouseEvent) => {
    e.stopPropagation();
    setOptimistic(rating);
    api
      .managerRateTask(sessionId, task.id, rating)
      .catch((err) => {
        console.warn("[manager] rate failed:", err);
        setOptimistic(null);
      });
  };
  const baseCls =
    "inline-flex items-center justify-center h-5 w-5 rounded text-fg-muted hover:text-fg-strong hover:bg-bg-chrome transition-colors";
  return (
    <div className="flex items-center gap-1 mt-1.5" onClick={(e) => e.stopPropagation()}>
      <button
        className={`${baseCls} ${current === 1 ? "text-emerald-400 hover:text-emerald-300" : ""}`}
        onClick={(e) => fire(1, e)}
        title="Mark this task's output as good — feeds the cross-project skill ledger"
        aria-label="Thumbs up"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 10v12" />
          <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
        </svg>
      </button>
      <button
        className={`${baseCls} ${current === -1 ? "text-rose-400 hover:text-rose-300" : ""}`}
        onClick={(e) => fire(-1, e)}
        title="Mark this task's output as bad — feeds the cross-project skill ledger"
        aria-label="Thumbs down"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 14V2" />
          <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
        </svg>
      </button>
    </div>
  );
}

const TASK_BORDER: Record<ManagerTaskStatus, string> = {
  pending: "border-line-soft",
  running: "border-sky-500/50",
  done: "border-emerald-500/40",
  failed: "border-rose-500/50",
  manual_pending: "border-amber-500/50",
  skipped: "border-fg-muted/30",
};

const TASK_DOT: Record<ManagerTaskStatus, string> = {
  pending: "bg-fg-muted/40",
  running: "bg-sky-400 animate-pulse",
  done: "bg-emerald-400",
  failed: "bg-rose-400",
  manual_pending: "bg-amber-400",
  skipped: "bg-fg-muted/40",
};

function TaskActions({
  sessionId,
  task,
  onClose,
}: {
  sessionId: string;
  task: ManagerTask;
  onClose: () => void;
}) {
  const [reassignOpen, setReassignOpen] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    if (reassignOpen && agents.length === 0) {
      api.agentDiscover().then(setAgents).catch(() => setAgents([]));
    }
  }, [reassignOpen, agents.length]);

  const fire = (mode: ManagerOverrideMode, agentId?: string) => {
    api
      .managerOverride(sessionId, task.id, mode, agentId)
      .then(onClose)
      .catch((e) => console.warn("[manager] override failed:", e));
  };

  return (
    <div
      className="absolute right-1 top-7 z-10 bg-bg-chrome border border-line-soft rounded shadow-lg p-1 text-xs min-w-[140px]"
      onClick={(e) => e.stopPropagation()}
    >
      {reassignOpen ? (
        <>
          <div className="px-2 py-1 text-fg-muted">Pick agent:</div>
          {agents.length === 0 ? (
            <div className="px-2 py-1 text-fg-muted">Loading…</div>
          ) : (
            agents.map((a) => (
              <button
                key={a.id}
                className="block w-full text-left px-2 py-1 hover:bg-bg-elev"
                onClick={() => fire("reassign", a.id)}
              >
                {a.label}
              </button>
            ))
          )}
          <button className="block w-full text-left px-2 py-1 hover:bg-bg-elev" onClick={() => setReassignOpen(false)}>
            Back
          </button>
        </>
      ) : (
        <>
          <button className="block w-full text-left px-2 py-1 hover:bg-bg-elev" onClick={() => fire("rerun")}>
            Rerun
          </button>
          <button className="block w-full text-left px-2 py-1 hover:bg-bg-elev" onClick={() => fire("skip")}>
            Skip
          </button>
          <button className="block w-full text-left px-2 py-1 hover:bg-bg-elev" onClick={() => setReassignOpen(true)}>
            Reassign…
          </button>
          <button className="block w-full text-left px-2 py-1 hover:bg-bg-elev" onClick={() => fire("take_over")}>
            Take over
          </button>
          <button className="block w-full text-left px-2 py-1 hover:bg-bg-elev" onClick={onClose}>
            Close
          </button>
        </>
      )}
    </div>
  );
}

function TaskDetailPanel({
  task,
  sessionId,
  onClose,
}: {
  task: ManagerTask;
  sessionId: string;
  onClose: () => void;
}) {
  const [liveOutput, setLiveOutput] = useState("");
  const [manualOutput, setManualOutput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setLiveOutput("");
    if (!task.stream_channel) return;
    const eventName = `agent-stream:${task.stream_channel}`;
    let alive = true;
    const unlistenP = listen<string>(eventName, (e) => {
      if (!alive) return;
      setLiveOutput((cur) => cur + e.payload + "\n");
    });
    return () => {
      alive = false;
      unlistenP.then((un) => un()).catch(() => {});
    };
  }, [task.stream_channel]);

  const persistedOutput = task.output ?? "";
  const shown = liveOutput || persistedOutput || "(no output yet)";

  const submitManual = async () => {
    if (!manualOutput.trim()) return;
    setSubmitting(true);
    try {
      await api.managerCompleteManual(sessionId, task.id, manualOutput.trim());
      setManualOutput("");
    } catch (e) {
      console.warn("[manager] complete_manual failed:", e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line-soft bg-bg-chrome">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-fg-muted">Task #{task.id}</span>
          <span className="text-fg-strong text-sm truncate">{task.description}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-fg-muted hover:text-fg-strong text-xs"
          onClick={onClose}
        >
          ✕
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3">
        <pre className="text-xs text-fg-strong whitespace-pre-wrap font-mono">{shown}</pre>
      </div>
      {(task.status === "manual_pending" || task.status === "failed") && (
        <div className="border-t border-line-soft p-3 flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wide text-fg-muted">
            Mark done manually
          </div>
          <textarea
            className="w-full bg-bg-elev text-fg-strong text-xs rounded border border-line-soft px-2 py-1 outline-none focus:border-line"
            rows={3}
            value={manualOutput}
            onChange={(e) => setManualOutput(e.target.value)}
            placeholder="What did you do? (becomes the task's relay summary)"
          />
          <button
            className="self-end text-xs px-3 py-1 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
            onClick={submitManual}
            disabled={submitting || !manualOutput.trim()}
          >
            {submitting ? "Saving…" : "Mark done"}
          </button>
        </div>
      )}
    </div>
  );
}

function RibbonList({ ribbon }: { ribbon: RibbonEntry[] }) {
  if (ribbon.length === 0) {
    return <div className="text-fg-muted text-sm">No events yet.</div>;
  }
  return (
    <ol className="flex flex-col gap-1 text-xs">
      {[...ribbon].reverse().map((entry, idx) => (
        <li key={idx} className="flex items-start gap-2 py-0.5">
          <span className="text-fg-muted shrink-0 w-14">{formatTime(entry.at)}</span>
          <span className="text-fg-strong">{describeEvent(entry)}</span>
        </li>
      ))}
    </ol>
  );
}

function describeEvent(entry: RibbonEntry): string {
  const ev = entry.event;
  switch (ev.kind) {
    case "plan_ready":
      return "Plan ready";
    case "task_dispatched":
      return `Dispatched #${ev.task_id} → ${ev.agent_id}`;
    case "task_completed":
      return `Task #${ev.task_id} completed (exit ${ev.exit_code})`;
    case "task_failed":
      return `Task #${ev.task_id} failed: ${ev.error}`;
    case "zone_collision":
      return `Zone collision on #${ev.task_id} — claimed by ${ev.claimer}`;
    case "manual_override":
      return `Override #${ev.task_id}: ${ev.mode}`;
    case "rebase_conflict":
      return `Rebase conflict on #${ev.task_id} (${ev.onto_ref})`;
    case "semantic_alert":
      return `Aura flagged ${ev.deletions.length} deletion(s) on #${ev.task_id}`;
    case "manager_speech":
      return ev.text;
    case "paused":
      return "Paused";
    case "resumed":
      return "Resumed";
    case "cancelled":
      return "Cancelled";
  }
}

function formatTime(secs: number): string {
  const d = new Date(secs * 1000);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
