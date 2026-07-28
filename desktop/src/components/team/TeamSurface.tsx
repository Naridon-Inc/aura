/** TeamSurface — the references-grade 3-pane Team center surface.
 *
 *  Owns the single `useTeamChat()` instance and composes the three panes:
 *  ConversationList (left) · ConversationView (center) · ContextPanel
 *  (right, collapsible). Pure-presentational panes take the hook bundle as a
 *  prop; this container owns the responsive layout and the context-panel
 *  routing the channel header drives.
 *
 *  Responsive on each mounted surface's measured width (a navigator and
 *  detail pane can coexist at different sizes; no CSS media queries),
 *  Layout.tsx):
 *    ≥1040px → three columns (list · view · context), both side columns
 *              drag-resizable and width-persisted; context collapses to a
 *              thin re-open rail in place.
 *    640–1040px → two columns (list · view); context becomes a right-edge
 *              slide-over with a dismiss scrim.
 *    <640px → one column (list OR view, swapped by selection); context is a
 *              full-width overlay.
 *
 *  Threads no longer take over the center: opening one routes through
 *  `chat.activeThread` into the context panel's Thread tab while the channel
 *  stream stays on screen. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bookmark,
  Clock3,
  Home,
  ListTodo,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";

import {
  useTeamChatContext,
  type TeamWorkspaceView,
} from "./application/TeamChatContext";
import type { TeamChatModel } from "./application/useTeamChat";
import { ConversationList } from "./presentation/ConversationList";
import { ConversationView } from "./presentation/ConversationView";
import { TasksBoard } from "../TasksBoard";
import { ContextPanel, type ContextTab } from "./presentation/ContextPanel";
import { IdentityChoiceDialog } from "../chat/IdentityChoiceDialog";
import { CreateChannelWizard } from "../chat/CreateChannelWizard";
import { AuraMark } from "../AuraMark";
import { Avatar } from "./presentation/Avatar";
import { previewBody, type Conversation, type Msg } from "./domain";

// Responsive column breakpoints (measured surface width, px).
const THREE_COL_MIN = 1040;
const TWO_COL_MIN = 640;

// Side-column resize bounds + defaults. Persisted under the `aura.team.*`
// keys, mirroring Layout.tsx's `aura.sidebar.w` precedent.
const LIST_KEY = "aura.team.list.w";
const LIST_MIN = 220;
const LIST_MAX = 420;
const LIST_DEFAULT = 252;
const CONTEXT_KEY = "aura.team.context.w";
const CONTEXT_MIN = 260;
const CONTEXT_MAX = 480;
const CONTEXT_DEFAULT = 320;

type TeamSurfaceProps = {
  repoRoot: string;
  projectName: string;
  /** Navigator stays in the app sidebar; detail renders only the selected
   * conversation in the workpane. Workspace retains the standalone layout. */
  mode?: "workspace" | "navigator" | "detail";
  /** Narrow-mount "open in main pane" affordance, forwarded to the channel
   *  header. Omitted by the wide center-pane mount (already expanded). */
  onExpand?: () => void;
};

export function TeamSurface({
  repoRoot,
  projectName,
  mode = "workspace",
  onExpand,
}: TeamSurfaceProps) {
  const { chat, workspaceView, setWorkspaceView } =
    useTeamChatContext(repoRoot);
  const { active, activeThread } = chat;
  const rootRef = useRef<HTMLDivElement>(null);
  const [panelW, setPanelW] = useState(900);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPanelW(entry.contentRect.width);
    });
    observer.observe(element);
    setPanelW(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const threeCol = panelW >= THREE_COL_MIN;
  const twoCol = panelW >= TWO_COL_MIN && panelW < THREE_COL_MIN;
  const oneCol = panelW < TWO_COL_MIN;

  const [listW, setListW] = usePersistentWidth(
    LIST_KEY,
    LIST_DEFAULT,
    LIST_MIN,
    LIST_MAX,
  );
  const [contextW, setContextW] = usePersistentWidth(
    CONTEXT_KEY,
    CONTEXT_DEFAULT,
    CONTEXT_MIN,
    CONTEXT_MAX,
  );
  // Context is opt-in, matching Slack's calm default. Each explicit header
  // action opens its own synchronized split pane, so details + canvas + a
  // thread can coexist. The panes intentionally follow `chat.active`: moving
  // to another person/channel updates every open pane instead of leaving stale
  // information from the previous conversation on screen.
  const [contextTabs, setContextTabs] = useState<ContextTab[]>([]);

  // Threads join the split workspace without replacing the conversation.
  useEffect(() => {
    if (activeThread) {
      setContextTabs((tabs) =>
        tabs.includes("thread") ? tabs : [...tabs, "thread"],
      );
    } else {
      setContextTabs((tabs) => tabs.filter((tab) => tab !== "thread"));
    }
  }, [activeThread]);

  // A DM has no channel canvas. Keep the user's other open detail panes and
  // restore Canvas automatically when they return to a channel.
  const visibleContextTabs = useMemo(
    () =>
      contextTabs.filter(
        (tab) => tab !== "canvas" || (!!active && active.kind !== "dm"),
      ),
    [active, contextTabs],
  );

  const selectContext = useCallback(
    (tab: ContextTab) => {
      setContextTabs((tabs) =>
        tabs.includes(tab) ? tabs.filter((item) => item !== tab) : [...tabs, tab],
      );
    },
    [],
  );

  const closeContext = useCallback((tab: ContextTab) => {
    if (tab === "thread") chat.setActiveThread(null);
    setContextTabs((tabs) => tabs.filter((item) => item !== tab));
  }, [chat]);

  const navigatorOnly = mode === "navigator";
  const detailOnly = mode === "detail";
  const hasCenter = workspaceView !== "conversation" || !!active;
  const showList = navigatorOnly || (!detailOnly && (threeCol || twoCol || (oneCol && !hasCenter)));
  const showView = detailOnly || (!navigatorOnly && (threeCol || twoCol || (oneCol && hasCenter)));
  const displayedContextTabs = oneCol
    ? visibleContextTabs.slice(-1)
    : visibleContextTabs;
  const slideWidth = oneCol
    ? "100%"
    : Math.min(contextW * Math.max(1, displayedContextTabs.length), panelW - 120);
  // Context/thread pane placement. Render it INLINE as a resizable sibling
  // column whenever there's real horizontal room for a side-by-side split:
  //  · the full 3-column layout, OR
  //  · a 2-column layout where the conversation list is hidden (the `detail`
  //    mount — Team opened in the editor workpane — where opening the app's
  //    left sidebar squeezes the surface below the 3-col threshold but there's
  //    still plenty of room to sit the thread beside the stream).
  // Only the genuinely narrow one-column case (or a 2-col surface that still
  // shows the list, where a third inline column would crush the stream) keeps
  // the slide-over overlay. Fixes the report that, with the app sidebar open,
  // the thread flipped to a cramped popover instead of the resizable pane —
  // now it opens as a proper inline pane the user can drag to resize.
  const contextInline = !navigatorOnly && (threeCol || (twoCol && !showList));

  return (
    <div
      ref={rootRef}
      className={`ade-team-surface slack-team-shell h-full w-full flex flex-col overflow-hidden ${
        oneCol || navigatorOnly ? "is-one-column" : ""
      }`}
    >
      {!detailOnly && <SlackTopbar chat={chat} projectName={projectName} />}
      <div className="flex-1 min-h-0 flex overflow-hidden relative slack-team-body">
        {mode === "workspace" && (
          <SlackAppRail
            chat={chat}
            workspaceView={workspaceView}
            onWorkspaceViewChange={setWorkspaceView}
          />
        )}
        {/* ── LEFT: conversation list ──────────────────────────────── */}
        {showList && (
          <ConversationList
            chat={chat}
            repoRoot={repoRoot}
            projectName={projectName}
            workspaceView={workspaceView}
            onWorkspaceViewChange={setWorkspaceView}
            onNavigate={navigatorOnly ? onExpand : undefined}
            width={oneCol || navigatorOnly ? "full" : listW}
          />
        )}
        {showList && showView && !oneCol && !navigatorOnly && !detailOnly && (
          <ColumnResizer
            edge="leading"
            width={listW}
            min={LIST_MIN}
            max={LIST_MAX}
            onResize={setListW}
          />
        )}

        {/* ── CENTER: active conversation ──────────────────────────── */}
        {showView &&
          (workspaceView === "conversation" ? (
            <ConversationView
              chat={chat}
              repoRoot={repoRoot}
              wide={panelW >= 520}
              onExpand={mode === "workspace" ? onExpand : undefined}
              contextTabs={visibleContextTabs}
              onSelectContext={selectContext}
            />
          ) : workspaceView === "tasks" ? (
            // The real project board, embedded inline. Its filters come from
            // the sidebar's TasksSidebar via the shared tasksFilterStore, the
            // same pairing the editor's Tasks surface uses.
            <TasksBoard
              repoRoot={repoRoot}
              embedded
              currentHandle={chat.selfHandle}
              onClose={() => setWorkspaceView("conversation")}
            />
          ) : (
            <SlackUtilityView
              chat={chat}
              view={workspaceView}
              onBack={() => setWorkspaceView("conversation")}
              onOpenConversation={(conv) => {
                chat.setActiveId(conv.id);
                chat.setRailFilter("all");
                setWorkspaceView("conversation");
              }}
            />
          ))}

        {/* ── RIGHT: synchronized split panes (inline at 3 columns) ──
            Never on the docked navigator mount — it's list-only, so the
            context panes (thread / members / canvas) belong to the detail
            surface. Without this guard the navigator painted a second
            (duplicate) thread panel over the left sidebar. */}
        {contextInline && workspaceView === "conversation" && active && displayedContextTabs.length > 0 && (
          <>
            <ColumnResizer
              edge="trailing"
              width={contextW}
              min={CONTEXT_MIN}
              max={CONTEXT_MAX}
              onResize={setContextW}
            />
            <div className="slack-context-stack h-full flex flex-shrink-0">
              {displayedContextTabs.map((tab) => (
                <div key={tab} className="slack-context-pane h-full" style={{ width: contextW }}>
                  <ContextPanel
                    chat={chat}
                    repoRoot={repoRoot}
                    tab={tab}
                    onTabChange={() => {}}
                    fixedTab={tab}
                    onClose={() => closeContext(tab)}
                  />
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── RIGHT: split panes slide over when there's no room inline ──
            Only when the thread can't be an inline sibling (`!contextInline`):
            the narrow one-column surface, or a two-column surface still
            showing the list. Same guard as above: the navigator mount must
            not slide a context pane (thread) over the docked list. */}
        {!navigatorOnly && !contextInline && displayedContextTabs.length > 0 && active && workspaceView === "conversation" && (
          <>
            <div
              className="absolute inset-0 z-20"
              onClick={() => setContextTabs([])}
              aria-hidden
            />
            <div
              className="slack-context-stack absolute right-0 inset-y-0 z-30 h-full flex shadow-[-8px_0_24px_rgba(0,0,0,0.28)]"
              style={{ width: slideWidth }}
            >
              {displayedContextTabs.map((tab) => (
                <div key={tab} className="slack-context-pane h-full flex-1 min-w-0">
                  <ContextPanel
                    chat={chat}
                    repoRoot={repoRoot}
                    tab={tab}
                    onTabChange={() => {}}
                    fixedTab={tab}
                    onClose={() => closeContext(tab)}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── shared modal layer ───────────────────────────────────────
          First-send identity picker (II.9) + full-screen channel-create
          wizard. Both gate on hook state, so they no-op for the common
          single-identity / not-creating case. */}
      {chat.identityPickerOpen && chat.doctorReport && (
        <IdentityChoiceDialog
          repoRoot={repoRoot}
          report={chat.doctorReport}
          manifest={chat.manifest}
          onPicked={() => {
            chat.setIdentityPickerOpen(false);
            chat.refreshDoctor();
          }}
          onClose={() => chat.setIdentityPickerOpen(false)}
        />
      )}
      {chat.creatingChannel && (
        <CreateChannelWizard
          onCancel={() => chat.setCreatingChannel(false)}
          onSubmit={chat.createChannel}
        />
      )}
    </div>
  );
}

function SlackTopbar({
  chat,
  projectName,
}: {
  chat: TeamChatModel;
  projectName: string;
}) {
  return (
    <div className="slack-team-topbar">
      <div className="slack-topbar-history" aria-hidden>
        <ArrowLeft size={17} />
        <ArrowRight size={17} />
        <Clock3 size={17} />
      </div>
      <label className="slack-team-search">
        <Search size={15} />
        <input
          value={chat.search}
          onChange={(event) => chat.setSearch(event.target.value)}
          placeholder={`Search ${projectName || "workspace"}`}
          aria-label={`Search ${projectName || "workspace"}`}
        />
      </label>
      <button type="button" className="slack-topbar-help" aria-label="Help">
        ?
      </button>
    </div>
  );
}

function SlackAppRail({
  chat,
  workspaceView,
  onWorkspaceViewChange,
}: {
  chat: TeamChatModel;
  workspaceView: TeamWorkspaceView;
  onWorkspaceViewChange: (view: TeamWorkspaceView) => void;
}) {
  const selfName = chat.myDevice?.display || chat.selfHandle || "You";
  const openConversation = (conv?: Conversation) => {
    if (conv) chat.setActiveId(conv.id);
    chat.setRailFilter("all");
    onWorkspaceViewChange("conversation");
  };
  return (
    <nav className="slack-app-rail" aria-label="Workspace navigation">
      <div className="slack-app-logo" title="Aura">
        <AuraMark size={25} />
      </div>
      <AppRailItem icon={<Home size={20} />} label="Home" active={workspaceView === "conversation"} onClick={() => openConversation(chat.active ?? chat.channelRows[0])} />
      <AppRailItem icon={<MessageCircle size={20} />} label="DMs" onClick={() => openConversation(chat.dmRows[0])} />
      <AppRailItem icon={<Bell size={20} />} label="Activity" active={workspaceView === "recap"} onClick={() => onWorkspaceViewChange("recap")} />
      <AppRailItem icon={<Bookmark size={20} />} label="Later" active={workspaceView === "drafts"} onClick={() => onWorkspaceViewChange("drafts")} />
      <AppRailItem icon={<ListTodo size={20} />} label="Tasks" active={workspaceView === "tasks"} onClick={() => onWorkspaceViewChange("tasks")} />
      <AppRailItem icon={<Sparkles size={20} />} label="Aura" onClick={() => openConversation(chat.allConvs.find((conv) => conv.name === "aura"))} />
      <AppRailItem icon={<MoreHorizontal size={21} />} label="More" />
      <div className="slack-app-rail-spacer" />
      <button type="button" className="slack-app-rail-add" aria-label="Add workspace">
        <Plus size={20} />
      </button>
      <Avatar name={selfName} size={34} presence="online" />
    </nav>
  );
}

function AppRailItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={`slack-app-rail-item ${active ? "is-active" : ""}`}>
      <span>{icon}</span>
      <small>{label}</small>
    </button>
  );
}

function SlackUtilityView({
  chat,
  view,
  onBack,
  onOpenConversation,
}: {
  chat: TeamChatModel;
  view: Exclude<TeamWorkspaceView, "conversation">;
  onBack: () => void;
  onOpenConversation: (conv: Conversation) => void;
}) {
  const allMessages = useMemo(
    () => Object.values(chat.msgs).flat().sort((a, b) => b.ts - a.ts),
    [chat.msgs],
  );
  const unreadConversations = chat.allConvs.filter((conv) => (conv.unread ?? 0) > 0);
  const replies = allMessages.filter((msg) => !!msg.thread_parent);
  const sent = allMessages.filter((msg) => msg.fromMe);

  const title =
    view === "unreads"
      ? "Unreads"
      : view === "recap"
        ? "Recap"
        : view === "threads"
          ? "Threads"
          : "Drafts & sent";

  return (
    <section className="slack-utility-view">
      <header className="slack-utility-header">
        <div className="slack-utility-heading">
          <button
            type="button"
            className="slack-utility-back"
            onClick={onBack}
            aria-label="Back to conversation"
            title="Back to conversation"
          >
            <ArrowLeft size={18} />
          </button>
          <h1>{title}</h1>
        </div>
        <button type="button" aria-label="More options"><MoreHorizontal size={19} /></button>
      </header>
      <div className="slack-utility-content">
        {view === "unreads" && (
          <UtilityConversationList
            conversations={unreadConversations}
            onOpen={onOpenConversation}
            empty="You're all caught up. New messages will appear here."
          />
        )}
        {view === "recap" && (
          <>
            <div className="slack-recap-hero">
              <span><Sparkles size={21} /></span>
              <div>
                <h2>Your workspace recap</h2>
                <p>{chat.totalUnread} unread messages across {unreadConversations.length} conversations.</p>
              </div>
            </div>
            <UtilityConversationList
              conversations={chat.allConvs.slice(0, 6)}
              onOpen={onOpenConversation}
              empty="Start a conversation to build your recap."
            />
          </>
        )}
        {view === "threads" && (
          <UtilityMessageList
            messages={replies}
            empty="Replies to threads you follow will appear here."
          />
        )}
        {view === "drafts" && (
          <>
            <div className="slack-drafts-empty">
              <FileDraftGlyph />
              <div><strong>No drafts</strong><span>Messages you start and save will appear here.</span></div>
            </div>
            <h2 className="slack-utility-section-title">Sent</h2>
            <UtilityMessageList messages={sent.slice(0, 20)} empty="Messages you send will appear here." />
          </>
        )}
      </div>
    </section>
  );
}

function UtilityConversationList({
  conversations,
  onOpen,
  empty,
}: {
  conversations: Conversation[];
  onOpen: (conv: Conversation) => void;
  empty: string;
}) {
  if (conversations.length === 0) return <UtilityEmpty>{empty}</UtilityEmpty>;
  return (
    <div className="slack-utility-list">
      {conversations.map((conv) => (
        <button key={conv.id} type="button" onClick={() => onOpen(conv)}>
          <span className="slack-utility-channel-mark">{conv.private ? "▣" : "#"}</span>
          <span className="slack-utility-row-copy">
            <strong>{conv.name}</strong>
            <small>{previewBody(conv.lastBody) || conv.hint || "Open conversation"}</small>
          </span>
          {(conv.unread ?? 0) > 0 && <b>{conv.unread}</b>}
        </button>
      ))}
    </div>
  );
}

function UtilityMessageList({ messages, empty }: { messages: Msg[]; empty: string }) {
  if (messages.length === 0) return <UtilityEmpty>{empty}</UtilityEmpty>;
  return (
    <div className="slack-utility-list slack-utility-message-list">
      {messages.slice(0, 30).map((msg) => (
        <div key={msg.id}>
          <Avatar name={msg.sender} size={34} />
          <span className="slack-utility-row-copy">
            <strong>{msg.sender}</strong>
            <small>{previewBody(msg.body)}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function UtilityEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="slack-utility-empty">
      <MessageCircle size={28} />
      <p>{children}</p>
    </div>
  );
}

function FileDraftGlyph() {
  return <span className="slack-draft-glyph">✎</span>;
}

// localStorage-backed, clamped column width. Mirrors Layout.tsx's sidebar
// persistence so a dragged Team layout survives reloads.
function usePersistentWidth(
  storageKey: string,
  initial: number,
  min: number,
  max: number,
) {
  const [w, setW] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
    } catch {
      /* private mode / quota — fall through to the default */
    }
    return initial;
  });
  const set = useCallback(
    (next: number) => {
      const clamped = Math.max(min, Math.min(max, next));
      setW(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {
        /* persistence is best-effort */
      }
    },
    [storageKey, min, max],
  );
  return [w, set] as const;
}

// 4px transparent column resizer with a ~6px hover catch area (negative
// margins keep panes flush against the hairline border). Self-contained:
// each drag attaches its own window pointer listeners and tears them down on
// release, so there's no shared drag-state plumbing. `edge="leading"` grows
// the pane on a rightward drag (the list); `"trailing"` grows it on a
// leftward drag (the context panel).
function ColumnResizer({
  width,
  onResize,
  edge,
  min,
  max,
}: {
  width: number;
  onResize: (next: number) => void;
  edge: "leading" | "trailing";
  min: number;
  max: number;
}) {
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const raw = edge === "leading" ? startW + dx : startW - dx;
      onResize(Math.max(min, Math.min(max, raw)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className="cursor-col-resize hover:bg-line"
      style={{
        width: 4,
        marginLeft: -2,
        marginRight: -2,
        background: "transparent",
        flexShrink: 0,
        zIndex: 5,
      }}
    />
  );
}
