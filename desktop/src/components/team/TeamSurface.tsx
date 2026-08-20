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
} from "react";
import {
  ArrowLeft,
  AtSign,
  CheckCheck,
  CornerDownRight,
  Inbox,
  MessagesSquare,
  PencilLine,
  Send,
  Sparkles,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import {
  useTeamChatContext,
  type TeamWorkspaceView,
} from "./application/TeamChatContext";
import type { TeamChatModel } from "./application/useTeamChat";
import { PlacePage } from "../places/PlacePage";
import { PaneResizer, usePaneSize } from "../ui/resizable";
import { teamColumns } from "./teamColumns";
import { ConversationList, ConversationGlyph } from "./presentation/ConversationList";
import { ConversationView } from "./presentation/ConversationView";
import { ContextPanel, type ContextTab } from "./presentation/ContextPanel";
import { IdentityChoiceDialog } from "../chat/IdentityChoiceDialog";
import { CreateChannelWizard } from "../chat/CreateChannelWizard";
import { Avatar } from "./presentation/Avatar";
import {
  findMember,
  relativeTime,
  senderLabel,
  type NamedMember,
} from "./presentation/messageHelpers";
import { EmptyState } from "../ui/state";
import {
  clearDraft,
  loadAllDrafts,
  prettyName,
  previewBody,
  isHumanBody,
  type Conversation,
  type Draft,
  type Msg,
} from "./domain";

// Context-column resize bounds + default. Persisted under the `aura.team.*`
// keys, mirroring Layout.tsx's `aura.sidebar.w` precedent.
//
// `aura.team.list.w` was here too — the conversation list was a drag-resizable
// 220–420px column (252 by default). On the page mount it is now the place
// rail, at the one width every place rail uses, so there is nothing left to
// drag: see `isPlace` below.
const CONTEXT_KEY = "aura.team.context.w";
const CONTEXT_MIN = 260;
const CONTEXT_MAX = 480;
const CONTEXT_DEFAULT = 320;

type TeamSurfaceProps = {
  repoRoot: string;
  /** Navigator stays in the app sidebar; detail renders only the selected
   * conversation in the workpane; full mounts the list and the view together.
   *
   * There is no longer a "workspace" mode. It differed from `full` by adding
   * Slack's own application chrome — a purple 40px title bar with browser
   * back/forward arrows, and a 74px icon rail carrying Home / DMs / Activity
   * / Drafts / Tasks / Aura. Every one of those is a destination this app
   * already reaches from its own sidebar, and both bands were `display:none`
   * in all three real mounts. A second navigation system that no one could
   * see is still a second navigation system. */
  mode?: "full" | "navigator" | "detail";
  /** Narrow-mount "open in main pane" affordance, forwarded to the channel
   *  header. Omitted by the wide center-pane mount (already expanded). */
  onExpand?: () => void;
};

export function TeamSurface({
  repoRoot,
  mode = "full",
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

  const [contextW, setContextW] = usePaneSize(
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

  // Canvas used to be filterable out of here for DMs; it now lives only in
  // the conversation's own tab strip, so every remaining context tab applies
  // to channels and DMs alike.
  const visibleContextTabs = contextTabs;

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
  const hasCenter = workspaceView !== "conversation" || !!active;

  // Which columns are on screen, at this width, on this mount — see
  // `teamColumns` for the whole argument, including why the page mount is a
  // place and the other two are not.
  //
  // The short version: the page owns the window, so its navigation goes where
  // every place puts it — the right-hand rail `PlacePage` gives Pages and
  // Tasks. Team was the last surface standing its own 252px list of rows
  // immediately against the app's 248px rail of rows.
  const { isPlace, showList, showView, contextInline, oneCol } = teamColumns(
    mode,
    panelW,
    hasCenter,
  );

  const displayedContextTabs = oneCol
    ? visibleContextTabs.slice(-1)
    : visibleContextTabs;
  const slideWidth = oneCol
    ? "100%"
    : Math.min(contextW * Math.max(1, displayedContextTabs.length), panelW - 120);

  return (
    <div
      ref={rootRef}
      className={`ade-team-surface slack-team-shell h-full w-full flex flex-col overflow-hidden ${
        oneCol || navigatorOnly ? "is-one-column" : ""
      }`}
    >
      <TeamShell
        rail={
          isPlace ? (
            <ConversationList
              chat={chat}
              repoRoot={repoRoot}
              workspaceView={workspaceView}
              onWorkspaceViewChange={setWorkspaceView}
              width="full"
              asRail
              showScope
            />
          ) : undefined
        }
      >
        {/* ── LEFT: conversation list ───────────────────────────────
            Only where Team is NOT a place: docked in the app sidebar as the
            navigator, or folded to one column on a narrow surface. The page
            mount hands this same component to the rail above instead. */}
        {showList && (
          <ConversationList
            chat={chat}
            repoRoot={repoRoot}
            workspaceView={workspaceView}
            onWorkspaceViewChange={setWorkspaceView}
            onNavigate={navigatorOnly ? onExpand : undefined}
            width="full"
            asPage={oneCol && mode === "full"}
            showScope={mode === "full"}
          />
        )}

        {/* ── CENTER: active conversation ──────────────────────────── */}
        {showView &&
          (workspaceView === "conversation" ? (
            <ConversationView
              chat={chat}
              repoRoot={repoRoot}
              wide={panelW >= 520}
              onExpand={mode === "full" ? onExpand : undefined}
              contextTabs={visibleContextTabs}
              onSelectContext={selectContext}
            />
          ) : (
            <SlackUtilityView
              chat={chat}
              view={workspaceView}
              onSelectView={(next) => {
                chat.setRailFilter(next === "unreads" ? "unread" : "all");
                setWorkspaceView(next);
              }}
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
            <PaneResizer
              orientation="vertical"
              edge="trailing"
              size={contextW}
              min={CONTEXT_MIN}
              max={CONTEXT_MAX}
              onResize={setContextW}
              label="Resize panel"
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
      </TeamShell>

      {/* ── shared modal layer ───────────────────────────────────────
          First-send identity picker (II.9) + full-screen channel-create
          wizard. Both gate on hook state, so they no-op for the common
          single-identity / not-creating case. */}
      {chat.identityPickerOpen && chat.doctorReport && (
        <IdentityChoiceDialog
          repoRoot={repoRoot}
          report={chat.doctorReport}
          manifest={chat.manifest}
          account={chat.cloudAccount}
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

/** The row Team's columns lay out in — and, on the page mount, the place shell
 *  around it.
 *
 *  With a rail, this is `PlacePage`: the same two-column shell Pages and Tasks
 *  get, so Team's navigation opens on the same edge, at the same width, on the
 *  same ground as theirs. Without one, it's the bare row, because the navigator
 *  (docked in the app sidebar) and the workpane `detail` mount are columns of
 *  somebody else's layout, not places of their own.
 *
 *  The row keeps `relative`: the context stack slides over it when there isn't
 *  room inline, and it must stop at the rail rather than cover it. */
function TeamShell({
  rail,
  children,
}: {
  rail?: ReactNode;
  children: ReactNode;
}) {
  const row = (
    <div className="flex-1 min-h-0 flex overflow-hidden relative slack-team-body">
      {children}
    </div>
  );
  if (!rail) return row;
  // `PlacePage` is the shell — it brings its own flex row and its own fill.
  // There used to be another flex row wrapped around it here, which made the
  // shell a flex item that sized itself to its content instead of the window.
  return <PlacePage rail={rail}>{row}</PlacePage>;
}

/* Slack's application chrome lived here: `SlackTopbar` (a purple 40px band
 * with back / forward / history arrows, a search field and a "?" button) and
 * `SlackAppRail` (a 74px icon column: Home, DMs, Activity, Drafts, Tasks,
 * Aura). Both are gone.
 *
 * The arrows and the "?" never had a handler — the arrows were even
 * `aria-hidden`, so they took a click and returned nothing to anyone. The
 * app rail duplicated six destinations the app's own sidebar already holds,
 * and `.is-one-column` hid it in every mount that exists. The search field
 * was the one live control, and what it did was filter this rail's
 * conversation list — under a placeholder reading "Search <project>", the
 * same words as the sidebar magnifier two hundred pixels above it. It is a
 * filter now, it says so, and it opens only when you ask for it
 * (ConversationList). */

/** The four readings of "what happened while I was somewhere else": which
 *  conversations are waiting, the messages themselves, replies aimed at me,
 *  and what I wrote. They were four rows in the sidebar, stacked above the
 *  conversations they summarise. They are lenses on one screen, so the screen
 *  carries the switch — the same place every other lens in this app lives —
 *  and the rail keeps one row for the ask: how much is waiting. */
const CATCH_UP_LENSES: {
  value: CatchUpView;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "unreads", label: "Unread", icon: Inbox },
  { value: "recap", label: "Recap", icon: Sparkles },
  { value: "threads", label: "Replies to you", icon: AtSign },
  { value: "drafts", label: "Drafts & sent", icon: PencilLine },
];

type CatchUpView = Exclude<TeamWorkspaceView, "conversation">;

function SlackUtilityView({
  chat,
  view,
  onBack,
  onSelectView,
  onOpenConversation,
}: {
  chat: TeamChatModel;
  view: Exclude<TeamWorkspaceView, "conversation">;
  onBack: () => void;
  onSelectView: (view: CatchUpView) => void;
  onOpenConversation: (conv: Conversation) => void;
}) {
  // Every message across every conversation, each still carrying the
  // conversation it came from — flattening that away is what left the lists
  // below unable to say where a message went, or to take you back to it.
  const allMessages = useMemo(
    () =>
      Object.entries(chat.msgs)
        .flatMap(([convId, list]) => list.map((msg) => ({ convId, msg })))
        .sort((a, b) => b.msg.ts - a.msg.ts),
    [chat.msgs],
  );
  const convById = useMemo(() => {
    const map = new Map<string, Conversation>();
    for (const conv of chat.allConvs) map.set(conv.id, conv);
    return map;
  }, [chat.allConvs]);
  const unreadConversations = chat.allConvs.filter((conv) => (conv.unread ?? 0) > 0);
  // The messages themselves, not just which conversations are waiting — this
  // is what makes Recap a different screen from Unreads rather than a second
  // copy of it. Same arithmetic the rail badges use, so the count in the
  // sentence above the list is the length of the list.
  const missed = useMemo(
    () =>
      allMessages.filter(
        (row) =>
          !row.msg.fromMe &&
          row.msg.ts > (chat.lastRead[row.convId] ?? 0) &&
          isHumanBody(row.msg.body),
      ),
    [allMessages, chat.lastRead],
  );
  // Answers somebody wrote. `thread_parent` alone is not "a reply" — the
  // project feed also hangs each session's later intents off its first one to
  // group them, so this screen, which says "when someone answers in a thread",
  // was almost entirely one agent's own work log talking to itself. `derived`
  // marks those; an agent's genuine chat reply is not derived and stays.
  //
  // `fromMe` goes too: the screen promises "when *someone* answers in a thread
  // you're following", and your own reply is not someone answering you. Two of
  // the five rows here were mine. Unreads and Recap both draw this line
  // already; Threads was the one list that didn't.
  const replies = allMessages.filter(
    (row) =>
      !!row.msg.thread_parent &&
      row.msg.kind === "msg" &&
      !row.msg.derived &&
      !row.msg.fromMe &&
      isHumanBody(row.msg.body),
  );
  // Every message by id, so a reply row can name the thread it's answering.
  // Without it each row showed only its channel, and five answers to five
  // different questions read as one flat stream — the thread being exactly
  // what a screen called Threads is meant to be organised by.
  const msgById = useMemo(() => {
    const map = new Map<string, Msg>();
    for (const { msg } of allMessages) map.set(msg.id, msg);
    return map;
  }, [allMessages]);
  // "Sent" means things you typed and sent — not everything that ever went out
  // under your name. It used to be `fromMe` alone, so the machine traffic that
  // rides the same channels landed here too: activity rows, and the raw sync
  // envelopes the notes/pages sync posts, which rendered as
  // `{"v":1,"op":"upsert","scope":"team",…}` attributed to you as if you had
  // typed it. `kind === "msg"` drops the activity rows; `isHumanBody` drops
  // the envelopes, including any future one, without enumerating producers.
  const sent = allMessages.filter(
    (row) => row.msg.fromMe && row.msg.kind === "msg" && isHumanBody(row.msg.body),
  );

  // Drafts live in localStorage, written by the composer as you type, so
  // they are read fresh each time this view opens rather than subscribed
  // to — nothing else can change them while you are looking at the list.
  const [drafts, setDrafts] = useState<Draft[]>([]);
  useEffect(() => {
    if (view === "drafts") setDrafts(loadAllDrafts());
  }, [view]);
  const discardDraft = useCallback((convId: string) => {
    clearDraft(convId);
    setDrafts((rows) => rows.filter((row) => row.convId !== convId));
  }, []);

  // These four screens used to open with a 49px band carrying a 17px/900
  // title — "Unreads" printed 25px under the lit "Unreads" row in the rail
  // beside it. The rail says which one you are on. What the rail cannot say
  // is where the back arrow goes, so that is all this line does now, and it
  // names the conversation instead of pointing a bare arrow at it.
  const backTo = chat.active ? prettyName(chat.active) : null;

  return (
    <section className="slack-utility-view">
      <div className="slack-utility-content">
        <div className="slack-utility-lenses">
          <button type="button" className="slack-utility-back" onClick={onBack}>
            <ArrowLeft size={13} />
            {backTo ? `Back to ${backTo}` : "Back to conversation"}
          </button>
          {/* Same cell shape as the right rail's tabs: the lens you're on
              spells its name, the others keep their mark and give the word
              back, so four lenses fit a narrow pane without a single one
              scrolling off the end. */}
          <div className="ade-seg ade-seg--row" role="tablist" aria-label="Catch up">
            {CATCH_UP_LENSES.map((lens) => {
              const on = view === lens.value;
              const count = lens.value === "unreads" ? chat.totalUnread : 0;
              const name = count > 0 ? `${lens.label} · ${count}` : lens.label;
              return (
                <button
                  key={lens.value}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-label={name}
                  title={name}
                  className={on ? "active" : "mark-only"}
                  onClick={() => onSelectView(lens.value)}
                >
                  <lens.icon size={13} />
                  {on && lens.label}
                  {count > 0 && (
                    <span className="text-2xs tabular-nums rounded px-1 bg-state-hover text-text-3">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {view === "unreads" && (
          <UtilityConversationList
            conversations={unreadConversations}
            onOpen={onOpenConversation}
            emptyIcon={CheckCheck}
            emptyTitle="You’re all caught up"
            empty="Nothing is waiting on you. Anything new lands here first."
          />
        )}
        {view === "recap" && (
          <>
            <div className="slack-recap-hero">
              <span><Sparkles size={21} /></span>
              <div>
                <h2>What you missed</h2>
                {/* This used to say "N unread across M conversations" over a
                    list of the first six conversations in the rail, unread or
                    not — so the sentence and the list disagreed, and rows with
                    nothing new in them sat under a heading about catching up.
                    The sentence now describes the list directly. */}
                <p>{recapLine(missed.length, unreadConversations.length)}</p>
              </div>
            </div>
            <UtilityMessageList
              rows={missed}
              convById={convById}
              onOpen={onOpenConversation}
              members={chat.members}
              myDisplay={chat.myDevice?.display}
              emptyIcon={Sparkles}
              emptyTitle="Nothing to catch up on"
              empty="When people write while you’re away, their messages collect here so you can read them in one pass."
            />
          </>
        )}
        {view === "threads" && (
          <UtilityMessageList
            rows={replies}
            convById={convById}
            onOpen={onOpenConversation}
            members={chat.members}
            myDisplay={chat.myDevice?.display}
            threadRootById={msgById}
            emptyIcon={MessagesSquare}
            emptyTitle="No replies yet"
            empty="When someone answers in a thread you’re following, it shows up here instead of you having to go looking."
          />
        )}
        {view === "drafts" && (
          <>
            {/* Two lists, two headings. "Sent" used to be the only one, which
                made it read as the label for everything above it as well. */}
            <h2 className="slack-utility-section-title">Drafts</h2>
            <UtilityDraftList
              drafts={drafts}
              conversations={chat.allConvs}
              onOpen={onOpenConversation}
              onDiscard={discardDraft}
            />
            <h2 className="slack-utility-section-title">Sent</h2>
            <UtilityMessageList
              rows={sent.slice(0, 20)}
              convById={convById}
              onOpen={onOpenConversation}
              members={chat.members}
              myDisplay={chat.myDevice?.display}
              // Everything here is by you, so your own name on all twenty rows
              // says nothing. Where it went is the thing you came to find.
              lead="destination"
              emptyIcon={Send}
              emptyTitle="Nothing sent yet"
              empty="Messages you send appear here, so you can find one again without hunting through channels."
            />
          </>
        )}
      </div>
    </section>
  );
}

/** The sentence over the recap list. Counts are read at a glance and then
 *  trusted, so it says exactly what the list holds — and says nothing about
 *  conversations when there is only one. */
function recapLine(messages: number, conversations: number): string {
  if (messages === 0) return "You’re all caught up.";
  const msgPart = messages === 1 ? "1 message" : `${messages} messages`;
  if (conversations <= 1) return `${msgPart} while you were away.`;
  return `${msgPart} across ${conversations} conversations.`;
}

/** How a conversation is named in running text — the trailing "where did this
 *  happen" label. The drawn mark comes from `ConversationGlyph`, the same one
 *  the rail uses; this is its text equivalent for places a glyph won't fit. */
function convMark(conv: Conversation): string {
  if (conv.kind === "dm") return "@";
  if (conv.kind === "project") return "✦ ";
  return "#";
}

/** The mark at the head of a utility row. Channels, the project and system
 *  conversations get the rail's own glyph; a DM gets the person's face, both
 *  at the 16px the glyph column is everywhere else in the app — the 34px
 *  tile these used made an avatar row half again as tall as a channel row,
 *  so one list had two row heights. */
function UtilityMark({ conv }: { conv: Conversation | null }) {
  if (!conv) return <span className="slack-utility-channel-mark">#</span>;
  if (conv.kind === "dm") return <Avatar name={conv.name} size={20} />;
  return (
    <span className="slack-utility-channel-mark">
      <ConversationGlyph conv={conv} />
    </span>
  );
}

function UtilityConversationList({
  conversations,
  onOpen,
  emptyIcon,
  emptyTitle,
  empty,
}: {
  conversations: Conversation[];
  onOpen: (conv: Conversation) => void;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  empty: string;
}) {
  if (conversations.length === 0)
    return (
      <UtilityEmpty icon={emptyIcon} title={emptyTitle}>
        {empty}
      </UtilityEmpty>
    );
  return (
    <div className="slack-utility-list">
      {conversations.map((conv) => (
        <button key={conv.id} type="button" onClick={() => onOpen(conv)}>
          <UtilityMark conv={conv} />
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

/** Unsent messages, newest first. Each row opens the conversation it
 *  belongs to with the text already back in the composer — which is the
 *  only thing anybody wants from a drafts list. */
function UtilityDraftList({
  drafts,
  conversations,
  onOpen,
  onDiscard,
}: {
  drafts: Draft[];
  conversations: Conversation[];
  onOpen: (conv: Conversation) => void;
  onDiscard: (convId: string) => void;
}) {
  if (drafts.length === 0)
    return (
      <UtilityEmpty icon={PencilLine} title="No drafts">
        Start a message and leave it unsent, and it waits for you here.
      </UtilityEmpty>
    );
  return (
    <div className="slack-utility-list">
      {drafts.map((draft) => {
        // A draft outlives the conversation list it was written in — you
        // can leave a channel, or open a project whose channels haven't
        // loaded yet. Rather than hide the row, name what we know.
        const conv = conversations.find((c) => c.id === draft.convId) ?? null;
        return (
          <div key={draft.convId} className="slack-utility-row">
            <button
              type="button"
              className="slack-utility-row-open"
              onClick={() => conv && onOpen(conv)}
              disabled={!conv}
              title={conv ? `Open ${conv.name}` : "This conversation isn’t open right now"}
            >
              <UtilityMark conv={conv} />
              <span className="slack-utility-row-copy">
                <strong>{conv?.name ?? draft.convId}</strong>
                <small>{previewBody(draft.body)}</small>
              </span>
              {/* `Draft.ts` is documented as the field that "orders the list
                  and dates the row" — it only ever did the first half, so an
                  unsent message gave no clue whether you abandoned it a minute
                  or a month ago, while the Sent list directly below dated
                  every row. Drafts are stamped in milliseconds. */}
              <span className="slack-utility-row-meta">
                <span className="slack-utility-row-when">
                  {relativeTime(Math.floor(draft.ts / 1000))}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={`Discard draft in ${conv?.name ?? draft.convId}`}
              title="Discard this draft"
              className="slack-utility-row-action"
              onClick={() => onDiscard(draft.convId)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** A message plus the conversation it lives in. */
type MsgRow = { convId: string; msg: Msg };

function UtilityMessageList({
  rows,
  convById,
  onOpen,
  lead = "sender",
  members,
  myDisplay,
  threadRootById,
  emptyIcon,
  emptyTitle,
  empty,
}: {
  rows: MsgRow[];
  convById: Map<string, Conversation>;
  onOpen: (conv: Conversation) => void;
  /** Which fact leads the row. Replies lead with who answered; the sent list
   *  leads with where it went, because the who is always you. */
  lead?: "sender" | "destination";
  /** The roster, so a row can print a person's name rather than their git
   *  login. Every list here rendered `msg.sender` raw. */
  members: readonly NamedMember[];
  /** What this device calls us, for our own rows when the roster has no
   *  name for us. */
  myDisplay?: string | null;
  /** Given a reply, the message it answers. Only Threads passes this — it's
   *  the one list whose rows are about something else on screen. */
  threadRootById?: Map<string, Msg>;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  empty: string;
}) {
  if (rows.length === 0)
    return (
      <UtilityEmpty icon={emptyIcon} title={emptyTitle}>
        {empty}
      </UtilityEmpty>
    );
  return (
    <div className="slack-utility-list slack-utility-message-list">
      {rows.slice(0, 30).map(({ convId, msg }) => {
        // The conversation can be missing — a channel you have since left, or
        // one that hasn't loaded yet. The row still shows what was said; it
        // just can't take you anywhere, and says so rather than dead-clicking.
        const conv = convById.get(convId) ?? null;
        const where = conv ? `${convMark(conv)}${conv.name}` : convId;
        const who = senderLabel(msg.sender, findMember(members, msg.sender), {
          fromMe: msg.fromMe,
          myDisplay,
        });
        // The message this one is answering, when the list is about replies.
        const root = msg.thread_parent
          ? threadRootById?.get(msg.thread_parent)
          : undefined;
        return (
          <button
            key={msg.id}
            type="button"
            onClick={() => conv && onOpen(conv)}
            disabled={!conv}
            title={conv ? `Open ${conv.name}` : "This conversation isn’t open right now"}
          >
            {lead === "destination" ? (
              <UtilityMark conv={conv} />
            ) : (
              <Avatar name={who} size={20} />
            )}
            <span className="slack-utility-row-copy">
              <strong>{lead === "destination" ? (conv?.name ?? convId) : who}</strong>
              <small>{previewBody(msg.body)}</small>
              {/* What they were answering. A reply on its own is half a
                  sentence — this is the half that makes the list readable
                  as threads rather than as a stream of stray remarks. */}
              {root && (
                <small className="slack-utility-row-root">
                  <CornerDownRight size={11} aria-hidden />
                  {previewBody(root.body)}
                </small>
              )}
            </span>
            {/* Every one of these lists is ordered by time and none of them
                showed any. "What you missed" with no when, and a Sent list you
                can't scan for the message you're trying to find again. */}
            <span className="slack-utility-row-meta">
              {lead === "sender" && (
                <span className="slack-utility-row-where">{where}</span>
              )}
              <span className="slack-utility-row-when">{relativeTime(msg.ts)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Every view in this rail used to empty out to the same chat bubble, whether
 *  you were looking at unreads, threads or things you'd sent. The icon is the
 *  fastest thing the eye reads, so each view names its own. */
function UtilityEmpty({
  icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return <EmptyState icon={icon} title={title} body={children} size="sm" />;
}

// `usePersistentWidth` and `ColumnResizer` lived here — a localStorage-backed
// clamped width, and a 4px pointer-drag divider. Both are `ui/resizable` now
// (`usePaneSize`, `PaneResizer`), which is the same pair the app shell's
// sidebar and review rail use and the same pair that finally made the place
// rail draggable. This file's copy was the better-written of the two originals,
// so it is the one that went into the shared module; what's left here is the
// caller.
