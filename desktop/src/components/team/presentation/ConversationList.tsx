/** Slack-inspired conversation sidebar for the Team workspace.
 *
 * The application model stays untouched: channels, DMs, unread counts,
 * mentions, presence, search, voice, and channel creation all come from the
 * single useTeamChat instance. This file only changes their presentation and
 * exposes the four workspace-level destinations shown in Slack's sidebar.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Plus, Search } from "lucide-react";

import type { TeamChatModel } from "../application/useTeamChat";
import type { TeamWorkspaceView } from "../application/TeamChatContext";
import type { Conversation } from "../domain";
import {
  AURA_CONV_ID,
  prettyName,
  railLabel,
  presenceForConversation,
} from "../domain";
import { VoiceDockPanel } from "../../chat/VoiceDockPanel";
import { VoiceCountChip } from "../../chat/VoiceRoster";
import { Avatar, type Presence } from "./Avatar";
import {
  AuraMarkIcon,
  BellIcon,
  RailLockIcon,
} from "./icons";
import { TeamHeader } from "./TeamHeader";
import {
  PlaceRailGroup,
  PlaceRailScope,
  PlaceRailScopeRow,
} from "../../places/PlaceRail";
import { setProjectScope, useKnownProjects } from "../../../lib/projectRoots";

type ConversationListProps = {
  chat: TeamChatModel;
  repoRoot: string;
  workspaceView: TeamWorkspaceView;
  onWorkspaceViewChange: (view: TeamWorkspaceView) => void;
  onNavigate?: () => void;
  width?: number | "full";
  /** Render as the surface itself rather than a column of it — the state
   *  where nothing is open yet, so the list has the whole page. Caps its
   *  measure and drops the divider it would otherwise draw against a
   *  neighbour it doesn't have. */
  asPage?: boolean;
  /** Render as the place's own rail — the right-hand panel `PlacePage` gives
   *  Pages and Tasks. It supplies the 220px box and the hairline on the side
   *  facing the page, so this drops the divider it would otherwise draw
   *  against a neighbour on its left and stands on the page's ground. */
  asRail?: boolean;
  /** Show the project picker at the top of the rail. Only the Team page mounts
   *  through the shared place scope, so only the page offers the control that
   *  writes it — a picker in the editor's Team pane would change a project the
   *  pane it sits in isn't reading. */
  showScope?: boolean;
};

export function ConversationList({
  chat,
  repoRoot,
  workspaceView,
  onWorkspaceViewChange,
  onNavigate,
  width,
  asPage = false,
  asRail = false,
  showScope = false,
}: ConversationListProps) {
  const [filtering, setFiltering] = useState(false);
  // Conversations, channels and people belong to a project. The rail used to
  // show whichever one the app had open, with no way to say "the other one".
  const projects = useKnownProjects(repoRoot);
  const {
    identity,
    manifest,
    claim,
    search,
    setSearch,
    cloudConnected,
    identityBannerVisible,
    identityBannerKind,
    doctorReport,
    setIdentityPickerOpen,
    railFilter,
    setRailFilter,
    totalUnread,
    channelRows,
    dmRows,
    customRows,
    activeId,
    setActiveId,
    setActiveThread,
    voiceByChannel,
    promptCreateChannel,
    members,
    wide,
    railWidth,
  } = chat;

  const select = (id: string) => {
    setRailFilter("all");
    setActiveId(id);
    setActiveThread(null);
    onWorkspaceViewChange("conversation");
    onNavigate?.();
  };

  const selectUtility = (view: Exclude<TeamWorkspaceView, "conversation">) => {
    setRailFilter(view === "unreads" ? "unread" : "all");
    onWorkspaceViewChange(view);
    onNavigate?.();
  };

  const sizing =
    width === "full"
      ? {
          width: undefined,
          flex: "1 1 auto",
          // A conversation list stretched across 1800px is a line of text
          // with an avatar and 1600px of nothing after it.
          ...(asPage
            ? { maxWidth: 760, marginInline: "auto" as const }
            : null),
        }
      : width !== undefined
        ? { width, flex: `0 0 ${width}px` }
        : {
            width: wide ? railWidth : undefined,
            flex: wide ? `0 0 ${railWidth}px` : "1 1 auto",
          };

  const allChannels = useMemo(
    () => [...channelRows, ...customRows],
    [channelRows, customRows],
  );

  // Everything that isn't the open conversation — unreads, recap, threads,
  // drafts & sent — is one screen, and shares one lit row below.
  const onCatchUp = workspaceView !== "conversation";

  const openFilter = () => {
    // Looking for someone means looking through everyone. Catch up narrows
    // this rail to unread-only; a name typed into the filter would otherwise
    // come back empty for a person who is sitting right there.
    setRailFilter("all");
    setFiltering(true);
  };
  const closeFilter = () => {
    setSearch("");
    setFiltering(false);
  };

  return (
    <aside
      className={`ade-team-list slack-team-sidebar${asPage ? " is-page" : ""}${
        asRail ? " is-rail" : ""
      }`}
      style={sizing}
    >
      {/* One band, and the same one every other place rail draws: which
          project on the left, this rail's own controls on the right.

          There were two. The second led with a `Chats | Tasks` segment, and
          "Tasks" mounted the entire Tasks page inside Team — the board in the
          centre, the board's own filter rail in this column — while the Tasks
          row in the nav stayed dark. Two doors onto one room, and the door
          didn't light the room it led to. Tasks is a destination of its own,
          with its own project picker; Team is the team.

          What was left of that second band was a rule holding two 13px
          glyphs, so the glyphs moved up here: the picker keeps the space it
          needs, the filter and the identity actions ride the trailing edge. */}
      <PlaceRailScopeRow>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            {showScope && (
              <PlaceRailScope
                value={repoRoot}
                onChange={setProjectScope}
                projects={projects}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => (filtering ? closeFilter() : openFilter())}
            className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-text-3 transition-colors hover:bg-state-hover hover:text-text-1"
            title="Filter chats and people"
            aria-label="Filter chats and people"
            aria-pressed={filtering}
          >
            <Search size={13} />
          </button>
          <TeamHeader
            identity={identity}
            manifest={manifest}
            onClaim={claim}
            repoRoot={repoRoot}
          />
        </div>
      </PlaceRailScopeRow>

      {/* Opens only when you ask for it. This was a permanent 40px band at
          the very top of the rail whose placeholder read "Search <project>" —
          the same words as the sidebar's own magnifier two hundred pixels
          above it, for a control that searches nothing and filters this list.
          One promise, one control, and no band at rest. */}
      {filtering && (
        <div className="team-rail-filter">
          <Search size={13} aria-hidden />
          <input
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeFilter();
            }}
            placeholder="Filter chats and people"
            aria-label="Filter chats and people"
          />
        </div>
      )}

      <VoiceDockPanel currentRepoRoot={repoRoot} />

      {/* One row, not four. Unreads / Recap / Threads / Drafts & sent each
          had a row here, stacked above the conversations they summarise, in
          a row treatment used nowhere else in this sidebar — so the column
          read as ten navigation rows with a search box wedged in the middle.
          They are four lenses on one screen; the screen carries the switch
          (SlackUtilityView) and the rail carries the only part of it that is
          an ask: how much is waiting on you. */}
      <nav className="slack-sidebar-shortcuts" aria-label="Catch up">
        <ShortcutRow
          icon={<UnreadGlyph />}
          label="Catch up"
          title="What's unread, a recap of it, replies aimed at you, and what you sent"
          active={onCatchUp}
          badge={totalUnread}
          onClick={() => selectUtility("unreads")}
        />
      </nav>

      {/* One notice, not three. These three conditions are all true on a fresh
          install with no git email and no sign-in, and they used to stack: a
          third of the rail spent on cards, two of them saying the same thing
          in different words before the list of people even started. Nobody
          decided that — they were added one at a time.

          So: the one you can act on, and only that one. Both identity notices
          are the same subject and the same repair — the picker sets who you
          send as, which is what "no git email" means — so they are one card
          with one button, never two statements. Working locally comes after,
          because it explains a limit rather than asking for something, and
          once you know who you are it is the next thing you'd want told. */}
      {identityBannerVisible && doctorReport ? (
        // Two different problems, so two different sentences. "setup" means
        // this computer has no name at all; "choose" means it has one and
        // also has a team name it can prove is the same person. The old
        // single wording ("your identity needs attention") was shown to
        // people whose only problem was that somebody else was on the
        // roster, which is not a problem they have.
        identityBannerKind === "setup" ? (
          <SidebarNotice title="Aura doesn't know who you are">
            Your messages can't carry your name yet.{" "}
            <button
              type="button"
              onClick={() => setIdentityPickerOpen(true)}
              className="slack-sidebar-notice-link"
            >
              Tell Aura who you are
            </button>
          </SidebarNotice>
        ) : (
          <SidebarNotice title="You go by two names here">
            <button
              type="button"
              onClick={() => setIdentityPickerOpen(true)}
              className="slack-sidebar-notice-link"
            >
              Pick the one teammates see
            </button>
          </SidebarNotice>
        )
      ) : identity !== null && (identity.email ?? "") === "" ? (
        <SidebarNotice title="Aura doesn't know who you are">
          Your messages can't carry your name yet.{" "}
          <button
            type="button"
            onClick={() => setIdentityPickerOpen(true)}
            className="slack-sidebar-notice-link"
          >
            Choose who you send as
          </button>
        </SidebarNotice>
      ) : cloudConnected === false ? (
        <SidebarNotice title="Working locally">
          Sign in from Settings to reach teammates online.
        </SidebarNotice>
      ) : null}

      <div className="slack-sidebar-scroll">
        <SidebarGroup
          label="Direct messages"
          count={dmRows.length}
          defaultOpen
          empty={<SidebarEmpty icon={<Plus size={14} />} label="Add coworkers" />}
        >
          {dmRows.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              active={workspaceView === "conversation" && conv.id === activeId}
              presence={presenceForConversation(conv, members)}
              avatarUrl={avatarUrlForConversation(conv, members)}
              onClick={() => select(conv.id)}
            />
          ))}
        </SidebarGroup>

        <SidebarGroup
          label="Channels"
          count={allChannels.length}
          defaultOpen
          empty={
            <SidebarEmpty
              icon={<Plus size={14} />}
              label={railFilter === "all" ? "Add channels" : "No unread channels"}
              onClick={railFilter === "all" ? promptCreateChannel : undefined}
            />
          }
          action={
            <button
              type="button"
              onClick={promptCreateChannel}
              className="slack-sidebar-group-action"
              title="Create channel"
              aria-label="Create channel"
            >
              <Plus size={14} />
            </button>
          }
        >
          {allChannels.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              active={workspaceView === "conversation" && conv.id === activeId}
              voiceCount={conv.channel ? voiceByChannel[conv.channel]?.length ?? 0 : 0}
              onClick={() => select(conv.id)}
            />
          ))}
        </SidebarGroup>

        {/* An "Apps" group used to close the rail, holding one row: Pages.
            The row had no `onClick` at all — it highlighted on hover, took
            the click and did nothing — and it carried a "···" that looked
            like an overflow menu but was a decorative glyph inside the
            same button. Pages is a footer destination, always one click
            away, so this was a second door to it that never opened.
            "Saved items" left this group earlier for the same reason: one
            door is enough, and a door that doesn't open is worse than
            none. */}
      </div>
    </aside>
  );
}

function ShortcutRow({
  icon,
  label,
  title,
  active,
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`slack-sidebar-shortcut ${active ? "is-active" : ""}`}
    >
      <span className="slack-sidebar-shortcut-icon">{icon}</span>
      <span>{label}</span>
      {!!badge && badge > 0 && (
        <span className="slack-sidebar-badge">{badge > 99 ? "99+" : badge}</span>
      )}
    </button>
  );
}

function UnreadGlyph() {
  return (
    <span className="slack-unread-glyph" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

function SidebarNotice({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="slack-sidebar-notice">
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

// Team's rail groups ARE the app's rail group — `places/PlaceRailGroup`, the
// one the Changes panel, the Tasks rail and the Pages rail all render. This
// was the last hand-drawn one: its own chevron, its own header rule, its
// always-visible action, and no count, in a column that sits beside three
// rails that have all four the other way round.
function SidebarGroup({
  label,
  count,
  defaultOpen,
  action,
  empty,
  children,
}: {
  label: string;
  count: number;
  defaultOpen?: boolean;
  action?: ReactNode;
  empty?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PlaceRailGroup
      title={label}
      count={count}
      defaultOpen={defaultOpen}
      actions={action}
      empty={empty}
    >
      <div className="slack-sidebar-group-rows">{children}</div>
    </PlaceRailGroup>
  );
}

function ConversationRow({
  conv,
  active,
  onClick,
  presence,
  avatarUrl,
  voiceCount,
}: {
  conv: Conversation;
  active: boolean;
  onClick: () => void;
  presence?: Presence | null;
  avatarUrl?: string | null;
  voiceCount?: number;
}) {
  const unread = !active && (conv.unread ?? 0) > 0;
  const mentions = !active ? conv.mentionUnread ?? 0 : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      title={conv.hint || prettyName(conv)}
      className={`slack-conversation-row ${active ? "is-active" : ""} ${unread ? "is-unread" : ""}`}
    >
      <ConversationGlyph conv={conv} presence={presence} avatarUrl={avatarUrl} />
      <span className="slack-conversation-name">
        {railLabel(conv)}
        <VoiceCountChip count={voiceCount ?? 0} />
      </span>
      {mentions > 0 ? (
        <span className="slack-mention-badge">{mentions}</span>
      ) : unread ? (
        <span className="slack-unread-dot" aria-label={`${conv.unread} unread`} />
      ) : null}
    </button>
  );
}

/** The mark in front of a conversation. Exported because the utility views
 *  (unreads, recap, threads, drafts) list the same conversations, and a
 *  conversation that looks like a channel in one list and a project in
 *  another is two different things to the person reading. */
export function ConversationGlyph({
  conv,
  presence,
  avatarUrl,
}: {
  conv: Conversation;
  presence?: Presence | null;
  avatarUrl?: string | null;
}) {
  if (conv.kind === "dm") {
    return <Avatar name={conv.name} size={16} presence={presence} src={avatarUrl} />;
  }
  if (conv.id === AURA_CONV_ID) return <span className="slack-channel-glyph"><AuraMarkIcon /></span>;
  if (conv.kind === "project") return <span className="slack-channel-glyph">✦</span>;
  if (conv.kind === "system") return <span className="slack-channel-glyph"><BellIcon /></span>;
  if (conv.private) return <span className="slack-channel-glyph"><RailLockIcon /></span>;
  return <span className="slack-channel-glyph">#</span>;
}

function avatarUrlForConversation(
  conv: Conversation,
  members: TeamChatModel["members"],
) {
  if (conv.kind !== "dm") return null;
  // Match on the handle when we have one: a display name can belong to two
  // seats, and picking the first would hang one colleague's photo on another.
  const needle = (conv.handle ?? conv.name).toLowerCase();
  const member = members.find(
    (entry) =>
      entry.handle.toLowerCase() === needle || entry.name.toLowerCase() === needle,
  );
  return member?.github_login
    ? `https://github.com/${encodeURIComponent(member.github_login)}.png?size=64`
    : null;
}


function SidebarEmpty({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="slack-sidebar-empty"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

