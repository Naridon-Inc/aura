// Manager session surface. The primary view is the chat surface
// (`ManagerChatView`) — the brain (Anthropic Messages API + tool calling
// on the Rust side) takes the user prompt, narrates progress in bubbles,
// and dispatches subagent work via tool_use cards. Details (DAG / ribbon /
// per-task drilldown) live in a side pane the user opts into.
//
// Visual chrome is the shared parts: the header's icon buttons and its
// More menu are library buttons and the library dropdown; the opening,
// broken and gone screens are the shared states; Details and Loop open as
// the task detail's side column, where each task is a board card and the
// session's events are a timeline.

import { useEffect, useRef, useState } from "react";
import { requestRenameChat } from "../chat/rename/renameChat";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import {
  getManagerSession,
  retryManagerSession,
  useManagerLoadError,
  useManagerSession,
} from "../../lib/managerStore";
// AURA-1296 — tab-menu actions: fork, mark unread, reset chat (+ files).
import { copyChatTranscript } from "../../lib/chatTranscriptCopy";
import { forkChatFromTab } from "../../lib/forkFromTab";
import { clearTabUnread, markTabUnread } from "../../lib/tabUnread";
import { resetChatFromTab } from "../../lib/resetChat";
import { peekUncommittedCount, resetFilesLabel } from "../../lib/uncommittedCount";
import { useEditorStore } from "../../lib/editorStore";
import { stripSteeringDirective } from "../../lib/steeringDirective";
import {
  api,
  type AgentDescriptor,
  type AgentInfo,
  type ManagerOverrideMode,
  type ManagerSession,
  type ManagerTask,
  type ManagerTaskStatus,
  type RibbonEntry,
  type UsageReport,
} from "../../lib/api";
import { listen } from "@tauri-apps/api/event";
import { DagView } from "./DagView";
import { ManagerChatView } from "./ManagerChatView";
import "../agent/chatView.css";
import { LoopPanel } from "./LoopPanel";
import { MemoryBadge } from "./MemoryBadge";
import { ChatIconsSprite } from "./ChatIconsSprite";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowUp,
  Columns2,
  GitBranch,
  MessageSquareOff,
  MoreHorizontal,
  Plus,
  Radio,
  RotateCcw,
  Rows2,
  SquareArrowOutUpRight,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { TaskBoardCard, TaskCardContent, TaskFact } from "../ui/tasks-board";
import { TaskDetailMeta, TaskDetailNote, TaskDetailSection } from "../ui/tasks-detail";
import { TaskStatusBadge } from "../ui/tasks-status";
import { Textarea } from "../ui/textarea";
import { Timeline } from "../ui/timeline";
import { CodeMessage } from "../ui/transcript-content";
import type { WorkspaceStage } from "../ui/workspace-preview-card";
import { AgentIcon } from "../agent/AgentIcon";
import { ResumeElsewhere } from "./chat/ResumeElsewhere";
import { computeResumePortability } from "./chat/resumePortability";
import { plainLine, plainPreview } from "../../lib/plainPreview";
import { canRemoveTaskCopy, removeTaskCopyWith } from "../../lib/taskCopyRemoval";
import { askConfirm } from "../ui/ask";
import { compactNumber } from "../../lib/compactNumber";
import { formatCost } from "../../lib/money";
import { openChatHistory } from "../../lib/chatHistoryEvent";
import { readAgentsList } from "../../lib/agentsListCache";

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
  | "cancel"
  // AURA-1296 — Reset chat needs the store hook to close the old tab, which
  // only the live surface holds; the two reset flavours ride the bridge.
  | "reset-chat"
  | "reset-chat-files";

export type ManagerPaneActionDetail = {
  sessionId: string;
  action: ManagerPaneAction;
};

// Placeholder shown while the session snapshot is still loading. A session
// hydrated from a large CLI transcript can take a beat to come back over IPC;
// this must never read as a frozen dead-end. So: a live spinner + elapsed
// counter, and after a long wait an escape hatch (close the tab and reopen)
// so the user is never trapped staring at "Loading…" with nothing to do.
//
// And when the snapshot isn't slow but BROKEN, this says so. The store used to
// swallow every fetch failure, which made "still loading" the only state a
// conversation could ever be in — we watched one sit at 420s with the app idle,
// the backend answering nothing, and no way to find out why. A load that has
// missed three times running has stopped being slow, so the spinner gives way
// to the actual reason and a Try again.
function LoadingSession({ sessionId }: { sessionId: string }) {
  const editor = useEditorStore();
  const failure = useManagerLoadError(sessionId);
  const [elapsed, setElapsed] = useState(0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // Three misses ≈ 6s of the 2s watchdog — past the window where a session
  // created moments ago is legitimately not on disk yet.
  const broken = (failure?.failures ?? 0) >= 3;
  const slow = elapsed >= 12;

  const retry = async () => {
    setRetrying(true);
    // A fresh attempt starts a fresh clock. Left running, pressing Try again
    // dropped straight back to "Loading conversation… · 57s" — the elapsed of
    // the attempt that had already failed, which reads as if the button did
    // nothing.
    setElapsed(0);
    try {
      await retryManagerSession(sessionId);
    } finally {
      setRetrying(false);
    }
  };

  // Two different screens, because they are two different facts. A read that
  // keeps failing might come good — that one gets a retry count and a Try
  // again. A file that is not on disk will not come good, and saying "Aura
  // asked 4 times" describes our asking rather than the answer.
  const gone = failure?.gone ?? false;

  if (gone) {
    return (
      <div className="flex h-full w-full items-center" style={{ background: "var(--ui-bg)" }}>
        <EmptyState
          icon={MessageSquareOff}
          title="This conversation is gone"
          body="It isn’t saved on this device any more, so there’s nothing to reopen. Aura has stopped trying to restore it — it won’t come back the next time you open the app. Your other conversations aren’t affected."
          action={{ label: "Close tab", onClick: () => editor.closeManager(sessionId) }}
          footnote={failure?.message}
        />
      </div>
    );
  }

  if (broken) {
    // No blanket "nothing has been lost" here: the read may be failing for a
    // reason that leaves the file intact, and a reassurance that turns out to
    // be false is worse than none. What IS always true is that this is one
    // conversation, not the app. The raw backend message rides underneath —
    // not the headline, because it is written for whoever has to fix it, but
    // present, since it is the one line that says whether the file is
    // missing, the disk is unreadable, or the app can no longer parse it.
    // Try again comes from the shared error state and re-runs this load.
    return (
      <div className="flex h-full w-full items-center" style={{ background: "var(--ui-bg)" }}>
        <ErrorState
          title="This conversation didn’t open"
          message={
            <>
              Aura asked {failure?.failures === 1 ? "once" : `${failure?.failures} times`} and
              got nothing back. Your other conversations aren’t affected.
            </>
          }
          onRetry={retry}
          retrying={retrying}
          action={{ label: "Close tab", onClick: () => editor.closeManager(sessionId) }}
          footnote={failure?.message}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center" style={{ background: "var(--ui-bg)" }}>
      <LoadingState
        size="md"
        label={`Loading conversation…${elapsed >= 3 ? ` · ${elapsed}s` : ""}`}
        action={slow ? { label: "Close tab", onClick: () => editor.closeManager(sessionId) } : undefined}
        footnote={
          slow
            ? "A long session can take a moment to open. You can keep waiting, or close this tab and reopen it."
            : undefined
        }
      />
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
      /** The chord that does the same thing, printed at the row's right edge. */
      shortcut?: string;
    };

/** Build the chat-tab right-click menu. It opens with the chat tab's own
 *  items — read state and fork, then the two transcript copies — and
 *  goes on with Aura's own controls: History/Memory open their global
 *  popovers; the rest fire at the live surface via the pane-action bridge.
 *  The tab strip adds Move to pane and the close block after these. */
export function buildManagerTabMenuItems(opts: {
  sessionId: string;
  /** The tab's title, named in the toast after a transcript copy. */
  title?: string;
  /** Suppress "Cancel session" once the session has finished/cancelled. */
  isTerminal?: boolean;
  /** The tab is flagged unread, so the menu offers "Mark as read". */
  unread?: boolean;
}): ManagerTabMenuItem[] {
  const fire = (action: ManagerPaneAction) => () =>
    dispatchManagerPaneAction(opts.sessionId, action);
  const items: ManagerTabMenuItem[] = [];
  // AURA-1296 — mark unread, fork in place. Neither needs anything from the
  // live surface, so they act directly.
  const unread = opts.unread ?? false;
  items.push({
    kind: "item",
    label: unread ? "Mark as read" : "Mark as unread",
    onSelect: () =>
      unread ? clearTabUnread(opts.sessionId) : markTabUnread(opts.sessionId),
  });
  items.push({
    kind: "item",
    label: "Rename chat",
    onSelect: () => requestRenameChat(opts.sessionId, opts.title ?? ""),
  });
  items.push({
    kind: "item",
    label: "Fork to new tab",
    shortcut: "⌘⌥↵",
    onSelect: () => void forkChatFromTab(opts.sessionId),
  });
  items.push({ kind: "separator" });
  items.push({
    kind: "item",
    label: "Copy concise transcript",
    shortcut: "⌘⌥C",
    onSelect: () => void copyChatTranscript(opts.sessionId, opts.title ?? "", "concise"),
  });
  items.push({
    kind: "item",
    label: "Copy full transcript",
    onSelect: () => void copyChatTranscript(opts.sessionId, opts.title ?? "", "complete"),
  });
  items.push({ kind: "separator" });
  items.push({
    kind: "item",
    label: "Chat history",
    onSelect: () => openChatHistory(opts.sessionId),
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
  // Starting over rides the bridge (see ManagerPaneAction). The files row
  // names how many uncommitted files the chat's project has, when that's
  // known yet.
  items.push({ kind: "separator" });
  items.push({ kind: "item", label: "Reset chat…", onSelect: fire("reset-chat") });
  items.push({
    kind: "item",
    label: resetFilesLabel(
      peekUncommittedCount(getManagerSession(opts.sessionId)?.projects[0]?.root),
    ),
    onSelect: fire("reset-chat-files"),
    tone: "danger",
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
  /** Optional — when provided, the `+` button in the header starts
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
  // "Resume this chat elsewhere" sheet — carries this conversation into a real
  // agent CLI's own resume list (single-agent → that one CLI cleanly;
  // multi-agent → replicated into every agent it used). The sheet loads the
  // installed-agent list itself.
  const [showResume, setShowResume] = useState(false);
  // Installed-agent list, only so the header can offer a one-click "take this
  // agent out" when the chat ran on exactly one resumable CLI. Loaded once;
  // the portability read below is pure over (chat, agents).
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);

  useEffect(() => {
    let live = true;
    void readAgentsList()
      .then((list) => {
        if (live) setAgents(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(DETAILS_PREF, showDetails ? "1" : "0");
  }, [showDetails]);

  useEffect(() => {
    localStorage.setItem(LOOP_PREF, showLoop ? "1" : "0");
  }, [showLoop]);

  // AURA-1296 — the pane-action listener below is bound once per session;
  // the store hook's closer is read through a ref so it stays current.
  const editorStore = useEditorStore();
  const closeManagerRef = useRef(editorStore.closeManager);
  closeManagerRef.current = editorStore.closeManager;

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
        // AURA-1296 — start over. The fresh chat is opened by resetChat; the
        // old tab closes here, through the hook, once that has succeeded.
        case "reset-chat":
        case "reset-chat-files": {
          const alsoFiles = detail.action === "reset-chat-files";
          const root = getManagerSession(sessionId)?.projects[0]?.root;
          void resetChatFromTab(sessionId, {
            alsoFiles,
            fileCount: alsoFiles ? peekUncommittedCount(root) : null,
          }).then((fresh) => {
            if (fresh) closeManagerRef.current(sessionId);
          });
          break;
        }
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
  const activityLabel = status === "running" || inFlight > 0 ? "Working" : status === "completed" ? "Completed" : status === "cancelled" ? "Cancelled" : "";

  // "Take them out" fast path: when this chat ran on exactly ONE resumable CLI
  // (Claude / Gemini / Codex, installed), offer a first-class header button to
  // pop that single agent out into its own standalone session — which also
  // writes it into that CLI's native resume store (`chat_export_for_agent`), so
  // it shows up in e.g. `claude --resume`. The `aura:open-chat-in-agent` event
  // is the same one the "Resume this chat elsewhere" sheet fires; App.tsx both
  // exports to the CLI store and opens the standalone agent tab. The ⋯ menu keeps
  // the full sheet for the multi-agent / advanced case.
  const portability = computeResumePortability(session.chat ?? [], agents);
  const soloAgent =
    portability.kind === "single" && portability.used[0]?.canResume
      ? portability.used[0]
      : null;

  return (
    <div className="aura-chat panel h-full w-full">
      <ChatIconsSprite />
      {tabChrome && (
      <div className="chat-heading manager-chat-heading">
        <div className="chat-identity" title={tabLabel}>
          <AgentIcon agentId="aura-manager" size={17} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {tabLabel}
          </span>
        </div>
        <span className="chat-state" role="status">{activityLabel}</span>
        <MemoryBadge repoRoot={session.projects[0]?.root ?? null} />
        <UsageChip session={session} />
        {onSplit && (
          <>
            <Button
              variant="ghost"
              size="iconSm"
              title="Split right"
              aria-label="Split right"
              onClick={() => onSplit("row")}
            >
              <Columns2 />
            </Button>
            <Button
              variant="ghost"
              size="iconSm"
              title="Split down"
              aria-label="Split down"
              onClick={() => onSplit("column")}
            >
              <Rows2 />
            </Button>
          </>
        )}
        {onNewThread && (
          <Button
            variant="ghost"
            size="iconSm"
            title="New thread"
            aria-label="New thread"
            onClick={onNewThread}
          >
            <Plus />
          </Button>
        )}
        {soloAgent && (
          // A box with an arrow leaving it — "take this one out".
          <Button
            variant="ghost"
            size="iconSm"
            title={`Take ${soloAgent.label} out. Reopens as a standalone ${soloAgent.label} session, and shows up in its CLI resume list`}
            aria-label={`Take ${soloAgent.label} out`}
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("aura:open-chat-in-agent", {
                  detail: {
                    sessionId,
                    agentId: soloAgent.agentId,
                    agentLabel: soloAgent.label,
                  },
                }),
              );
            }}
          >
            <SquareArrowOutUpRight />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="iconSm" title="More" aria-label="More">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem checked={showDetails} onCheckedChange={setShowDetails}>
              Show details
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showLoop} onCheckedChange={setShowLoop}>
              Show loop
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => window.dispatchEvent(new CustomEvent("aura:open-compare"))}
            >
              Compare parallel copies…
            </DropdownMenuItem>
            {/* Carry this conversation into a real coding-agent CLI's own
                resume list so it's never stranded inside Aura. The sheet
                reads how many agents ran the chat and frames it: single-agent
                → move cleanly into that CLI; multi-agent → replicate into
                every agent it used as an imported transcript. */}
            <DropdownMenuItem onSelect={() => setShowResume(true)}>
              Resume this chat elsewhere…
            </DropdownMenuItem>
            {!isTerminal && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => api.managerCancel(sessionId)}>
                  Cancel session
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
          <aside className="ui-tasks-detail-aside" aria-label="Details">
            <DetailsPane
              session={session}
              sessionId={sessionId}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onHide={() => setShowDetails(false)}
            />
          </aside>
        )}
        {showLoop && (
          <aside className="ui-tasks-detail-aside" aria-label="Loop">
            <LoopPanel repoRoot={session.projects[0]?.root ?? null} />
          </aside>
        )}
      </div>

      {/* No own header bar (rendered inside the shared tab strip): Memory
          lives as a headless popover anchored top-right, opened from the chat
          tab's right-click menu via a window event. Chat history lives in the
          composer's toolbar and answers the same kind of event. */}
      {!tabChrome && (
        <>
          <MemoryBadge
            headless
            repoRoot={session.projects[0]?.root ?? null}
          />
        </>
      )}
    </div>
  );
}

function DetailsPane({
  session,
  sessionId,
  selectedTaskId,
  onSelectTask,
  onHide,
}: {
  session: ManagerSession;
  sessionId: string;
  selectedTaskId: number | null;
  onSelectTask: (id: number | null) => void;
  onHide: () => void;
}) {
  const selected = selectedTaskId
    ? session.tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;
  const hide = (
    <Button variant="ghost" size="iconXs" title="Hide details" aria-label="Hide details" onClick={onHide}>
      <X />
    </Button>
  );

  if (selected) {
    return (
      <TaskDetailPanel
        task={selected}
        sessionId={sessionId}
        onClose={() => onSelectTask(null)}
        hide={hide}
      />
    );
  }

  // The aside's own sections: the plan as a graph, then what has happened.
  // One scroll for both, so a long plan never squeezes the log to a sliver.
  return (
    <>
      <TaskDetailSection title="Tasks" count={session.tasks.length} action={hide}>
        {session.tasks.length === 0 ? (
          <TaskDetailNote>No tasks yet. Ask the Manager to do something.</TaskDetailNote>
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
      </TaskDetailSection>
      <TaskDetailSection title="Activity" count={session.ribbon.length}>
        <RibbonList ribbon={session.ribbon} />
      </TaskDetailSection>
    </>
  );
}

// Live token + cost chip — aggregates `aura usage today --json --project`
// across every project the session touches. Refreshes every 12s while the
// session is Running.
function UsageChip({ session }: { session: ManagerSession }) {
  const [agg, setAgg] = useState<UsageReport | null>(null);
  const projectKey = session.projects.map((p) => p.root).sort().join("|");
  // Cmd-Tab away and the poll kept spawning a CLI process per project for a
  // chip nobody can see. Re-entering the effect on the visible edge also buys
  // a catch-up fetch, so the chip is current the moment it is looked at.
  const visible = useDocumentVisibility();
  // The effect is keyed by `projectKey` — roots, not the session object, which
  // the store re-creates on every snapshot. Read the live list through a ref
  // so the fetch can't close over a stale one.
  const projectsRef = useRef(session.projects);
  projectsRef.current = session.projects;
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const fetch = async () => {
      const reports = await Promise.all(
        projectsRef.current.map((p) => api.auraUsageReport(p.root, "today")),
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
          cacheCostUsd: acc.cacheCostUsd + r.cacheCostUsd,
          measuredCostUsd: acc.measuredCostUsd + r.measuredCostUsd,
          unattributedCostUsd: acc.unattributedCostUsd + r.unattributedCostUsd,
          // Every project's report says the same thing about what it
          // measures, so the merged one keeps a single copy rather than
          // repeating it once per project.
          measurementNotes: acc.measurementNotes,
          sessionCount: acc.sessionCount + r.sessionCount,
          byModel: mergeByModel(acc.byModel, r.byModel),
          // Per-dev rows are (month, developer, agent) buckets per project —
          // concatenation is the honest cross-project merge.
          byDeveloper: [...acc.byDeveloper, ...r.byDeveloper],
        };
      }, null);
      // Nothing moved since the last poll — swallow it. Today's spend is
      // flat whenever no agent is burning tokens, and re-setting state here
      // re-rendered the session header (and everything under it) every 12s
      // for a chip whose pixels were identical.
      setAgg((prev) =>
        usageSignature(prev) === usageSignature(merged) ? prev : merged,
      );
    };
    void fetch();
    const isLive = session.status === "running" || session.status === "paused";
    if (!isLive) {
      return () => {
        cancelled = true;
      };
    }
    const id = setInterval(fetch, 12000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectKey, session.status, visible]);

  if (!agg || agg.totalCostUsd < 0.0001) return null;

  const total = agg.totalInputTokens + agg.totalOutputTokens;
  const cacheRead = agg.totalCacheReadTokens;
  const tooltip = [
    `Today across ${session.projects.length} repositor${session.projects.length === 1 ? "y" : "ies"}`,
    `${compactNumber(agg.totalInputTokens)} in · ${compactNumber(agg.totalOutputTokens)} out`,
    // Cache reads are cheap, not free, and the figure beside them now
    // charges for them. Calling them "saved" here while billing for them
    // there described the same tokens two incompatible ways.
    cacheRead > 0
      ? `${compactNumber(cacheRead)} read from cache · ${formatCost(agg.cacheCostUsd)}`
      : null,
    "",
    ...agg.byModel.map(
      (m) =>
        `${m.model}: ${compactNumber(m.inputTokens + m.outputTokens)} · ${formatCost(m.costUsd)}`,
    ),
  ]
    .filter((s) => s !== null)
    .join("\n");

  return (
    <Badge variant="outline" title={tooltip} className="tabular-nums">
      {compactNumber(total)} · {formatCost(agg.totalCostUsd)}
    </Badge>
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

/** Everything the chip actually draws — the two numbers plus the per-model
 *  tooltip rows — flattened so two polls that read the same thing compare
 *  equal. Deliberately NOT a deep compare of the report: `byDeveloper` never
 *  reaches the screen here, and it grows on every project the session adds. */
function usageSignature(r: UsageReport | null): string {
  if (!r) return "";
  return [
    r.totalCostUsd,
    r.totalInputTokens,
    r.totalOutputTokens,
    r.totalCacheReadTokens,
    r.sessionCount,
    ...r.byModel.map(
      (m) => `${m.model}:${m.inputTokens}:${m.outputTokens}:${m.costUsd}`,
    ),
  ].join("|");
}

// A task's status, said with the workspace lifecycle glyphs the board uses.
// "Needs you" is review-shaped: the work stopped and is waiting on a person.
const TASK_STAGE: Record<ManagerTaskStatus, { stage: WorkspaceStage; label: string; color?: string }> = {
  pending: { stage: "backlog", label: "Waiting" },
  running: { stage: "in-progress", label: "Running" },
  manual_pending: { stage: "in-review", label: "Needs you" },
  done: { stage: "done", label: "Done" },
  failed: { stage: "canceled", label: "Failed", color: "var(--ui-red)" },
  skipped: { stage: "canceled", label: "Skipped" },
};

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
  const snapshots = task.pre_dispatch_snapshot_ids?.length ?? 0;
  const terminal = task.status === "done" || task.status === "failed" || task.status === "skipped";
  return (
    // DagView draws its edges from each card's box, so the ref sits on a
    // wrapper the board card fills.
    <div ref={cardRef} className="w-[240px] max-w-full">
      <TaskBoardCard
        label={`Task #${task.id}: ${plainLine(task.description)}`}
        taskId={String(task.id)}
        selected={selected}
        onOpen={onSelect}
      >
        <TaskCardContent
          handle={`#${task.id} · ${task.agent_id ?? "auto"}`}
          stage={<TaskStatusBadge {...TASK_STAGE[task.status]} />}
          title={plainPreview(task.description)}
          footer={
            <>
              {task.depends_on.length > 0 && (
                <TaskFact
                  icon={<ArrowUp />}
                  title={`Waits for ${task.depends_on.length === 1 ? "task" : "tasks"} ${task.depends_on.join(", ")} to finish first`}
                >
                  {task.depends_on.join(",")}
                </TaskFact>
              )}
              {task.worktree_path && (
                <TaskFact icon={<GitBranch />} title={`Isolated copy: ${task.worktree_path}`}>
                  {task.worktree_path.split("/").slice(-1)[0]}
                </TaskFact>
              )}
              {task.a2a_task_id && (
                <TaskFact
                  icon={<ArrowLeftRight />}
                  title={`Tracked as an agent-to-agent (A2A) task · ${task.a2a_task_id}`}
                >
                  a2a:{task.a2a_task_id.split("-")[0]}
                </TaskFact>
              )}
              {snapshots > 0 && (
                <TaskFact
                  icon={<RotateCcw />}
                  title={`Auto-snapshotted ${snapshots} file(s) before dispatch. Recoverable via 'aura rewind --task ${task.id}'`}
                >
                  {snapshots} snapshot{snapshots === 1 ? "" : "s"}
                </TaskFact>
              )}
              {liveCount > 0 && (
                <TaskFact
                  icon={<span className="ui-status-dot" data-status={pulse ? "working" : undefined} aria-hidden />}
                  title={
                    task.status === "running"
                      ? `Live stream · ${liveCount} lines so far. Click to expand.`
                      : `Captured ${liveCount} lines while running.`
                  }
                >
                  ≈{liveCount} lines
                </TaskFact>
              )}
              {task.blocked_reason && (
                <TaskFact tone="alert" icon={<TriangleAlert />} title={task.blocked_reason}>
                  {task.blocked_reason}
                </TaskFact>
              )}
              {/* The card opens on any click; these two answer for themselves.
                  The menu's items are portalled, and React still bubbles
                  their clicks through here, so the stop covers them too. */}
              <span className="ml-auto inline-flex items-center" onClick={(e) => e.stopPropagation()}>
                {terminal && <RatingButtons sessionId={sessionId} task={task} />}
                <TaskActions sessionId={sessionId} task={task} />
              </span>
            </>
          }
        />
      </TaskBoardCard>
    </div>
  );
}

/// Bucket F2 — thumbs shown only on terminal tasks. Optimistic click: flips
/// the local state immediately, fires the Tauri command in the background,
/// snapshot reload reconciles. The current vote is read from
/// `task.pending_skill.user_rating`, which the backend persists across
/// reloads. The vote that stands is the filled button.
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
  const fire = (rating: -1 | 1) => {
    setOptimistic(rating);
    api
      .managerRateTask(sessionId, task.id, rating)
      .catch((err) => {
        console.warn("[manager] rate failed:", err);
        setOptimistic(null);
      });
  };
  return (
    <>
      <Button
        variant={current === 1 ? "secondary" : "ghost"}
        size="iconXs"
        aria-pressed={current === 1}
        onClick={() => fire(1)}
        title="This came out well. Aura remembers which brain did it and reaches for that one on work like this."
        aria-label="Thumbs up"
      >
        <ThumbsUp />
      </Button>
      <Button
        variant={current === -1 ? "secondary" : "ghost"}
        size="iconXs"
        aria-pressed={current === -1}
        onClick={() => fire(-1)}
        title="This didn't come out well. Aura remembers, and reaches for a different brain on work like this."
        aria-label="Thumbs down"
      >
        <ThumbsDown />
      </Button>
    </>
  );
}

function TaskActions({
  sessionId,
  task,
}: {
  sessionId: string;
  task: ManagerTask;
}) {
  // Null until the Reassign submenu first opens: discovery spawns a probe per
  // installed CLI, which nobody should pay for just by opening the menu.
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const loadAgents = (open: boolean) => {
    if (!open || agents !== null) return;
    api.agentDiscover().then(setAgents).catch(() => setAgents([]));
  };

  const fire = (mode: ManagerOverrideMode, agentId?: string) => {
    api
      .managerOverride(sessionId, task.id, mode, agentId)
      .catch((e) => console.warn("[manager] override failed:", e));
  };

  const removeCopy = () => {
    const path = task.worktree_path;
    if (!path) return;
    removeTaskCopyWith(path, {
      remove: (force) => api.managerRemoveTaskWorktree(sessionId, task.id, force),
      confirm: (body) =>
        askConfirm({ title: "Remove this task's copy?", body, confirmLabel: "Remove", tone: "danger" }),
    }).catch((e) => console.warn("[manager] removing the task's copy failed:", e));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="iconXs" title="More actions" aria-label={`More actions for task #${task.id}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => fire("rerun")}>Rerun</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => fire("skip")}>Skip</DropdownMenuItem>
        <DropdownMenuSub onOpenChange={loadAgents}>
          <DropdownMenuSubTrigger>Reassign</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {agents === null ? (
              <DropdownMenuItem disabled>Finding your agents…</DropdownMenuItem>
            ) : agents.length === 0 ? (
              <DropdownMenuItem disabled>No other agents found</DropdownMenuItem>
            ) : (
              agents.map((a) => (
                <DropdownMenuItem key={a.id} onSelect={() => fire("reassign", a.id)}>
                  {a.label}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => fire("take_over")}>Take over</DropdownMenuItem>
        {canRemoveTaskCopy(task) && (
          <DropdownMenuItem onSelect={removeCopy}>Remove isolated copy</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskDetailPanel({
  task,
  sessionId,
  onClose,
  hide,
}: {
  task: ManagerTask;
  sessionId: string;
  onClose: () => void;
  /** The aside's own close, kept beside Back so leaving the task isn't the
   *  only way out of the column. */
  hide: React.ReactNode;
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
    <>
      <TaskDetailSection
        title={`Task #${task.id}`}
        action={
          <span className="inline-flex items-center">
            <Button variant="ghost" size="iconXs" title="Back to all tasks" aria-label="Back to all tasks" onClick={onClose}>
              <ArrowLeft />
            </Button>
            {hide}
          </span>
        }
      >
        <p className="ui-tasks-detail-objective">{plainLine(task.description)}</p>
        <TaskDetailMeta
          parts={[<TaskStatusBadge {...TASK_STAGE[task.status]} />, task.agent_id ?? "auto"]}
        />
      </TaskDetailSection>
      <TaskDetailSection>
        <CodeMessage language="Output">{shown}</CodeMessage>
      </TaskDetailSection>
      {(task.status === "manual_pending" || task.status === "failed") && (
        <TaskDetailSection title="Mark done manually">
          <div className="flex flex-col gap-2">
            <Textarea
              rows={3}
              value={manualOutput}
              onChange={(e) => setManualOutput(e.target.value)}
              placeholder="What did you do? (becomes the task's relay summary)"
            />
            <Button
              size="xs"
              className="self-end"
              onClick={submitManual}
              disabled={submitting || !manualOutput.trim()}
            >
              {submitting ? "Saving…" : "Mark done"}
            </Button>
          </div>
        </TaskDetailSection>
      )}
    </>
  );
}

function RibbonList({ ribbon }: { ribbon: RibbonEntry[] }) {
  if (ribbon.length === 0) {
    return (
      <EmptyState
        icon={Radio}
        title="Nothing yet"
        body="A running commentary of what your agents are doing appears here as it happens."
        size="sm"
      />
    );
  }
  // Newest first, and the newest one's marker is filled: it is where the
  // session is now.
  const entries = [...ribbon].reverse().map((entry, idx) => ({
    id: `${entry.at}-${idx}`,
    title: describeEvent(entry),
    detail: formatTime(entry.at),
    tone: idx === 0 ? ("active" as const) : ("neutral" as const),
  }));
  return <Timeline entries={entries} />;
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
      return `Zone collision on #${ev.task_id}. Claimed by ${ev.claimer}`;
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
