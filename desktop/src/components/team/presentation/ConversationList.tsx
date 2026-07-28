/** Slack-inspired conversation sidebar for the Team workspace.
 *
 * The application model stays untouched: channels, DMs, unread counts,
 * mentions, presence, search, voice, and channel creation all come from the
 * single useTeamChat instance. This file only changes their presentation and
 * exposes the four workspace-level destinations shown in Slack's sidebar.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  AtSign,
  Bookmark,
  ChevronDown,
  FilePenLine,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Send,
  Sparkles,
} from "lucide-react";

import type { TeamChatModel } from "../application/useTeamChat";
import type { TeamWorkspaceView } from "../application/TeamChatContext";
import type { Conversation } from "../domain";
import { AURA_CONV_ID, prettyName, railLabel } from "../domain";
import { VoiceDockPanel } from "../../chat/VoiceDockPanel";
import { VoiceCountChip } from "../../chat/VoiceRoster";
import { Avatar, type Presence } from "./Avatar";
import {
  AuraMarkIcon,
  BellIcon,
  RailLockIcon,
} from "./icons";
import { TeamHeader } from "./TeamHeader";
import { TasksSidebar } from "../../workpanes/TasksSidebar";
import { Segment } from "../../ui/segment";

type ConversationListProps = {
  chat: TeamChatModel;
  repoRoot: string;
  projectName: string;
  workspaceView: TeamWorkspaceView;
  onWorkspaceViewChange: (view: TeamWorkspaceView) => void;
  onNavigate?: () => void;
  width?: number | "full";
};

export function ConversationList({
  chat,
  repoRoot,
  projectName,
  workspaceView,
  onWorkspaceViewChange,
  onNavigate,
  width,
}: ConversationListProps) {
  const {
    identity,
    manifest,
    claim,
    cloudConnected,
    identityBannerVisible,
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
      ? { width: undefined, flex: "1 1 auto" }
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

  // The two persistent Team tabs. "Tasks" reuses the "tasks" workspace view;
  // everything else (conversation / unreads / recap / threads / drafts) reads
  // as the "Chats" tab.
  const onTasks = workspaceView === "tasks";

  return (
    <aside className="ade-team-list slack-team-sidebar" style={sizing}>
      <TeamHeader
        identity={identity}
        manifest={manifest}
        onClaim={claim}
        repoRoot={repoRoot}
        label={projectName || "Aura Team"}
      />

      {/* Chats | Tasks — a persistent segmented control directly under the
          project name (the app's shared `Segment`, same as everywhere). Chats
          is the conversation surface; Tasks swaps the sidebar to the board's
          filter nav (and opens the board pane). The same sidebar shell hosts
          both, so the structure is reused. */}
      <div className="team-nav-tabs">
        <Segment<"chats" | "tasks">
          size="sm"
          stretch
          className="w-full"
          ariaLabel="Team views"
          value={onTasks ? "tasks" : "chats"}
          onChange={(next) =>
            next === "tasks"
              ? selectUtility("tasks")
              : onWorkspaceViewChange("conversation")
          }
          options={[
            { value: "chats", label: "Chats", icon: <MessageSquare /> },
            { value: "tasks", label: "Tasks", icon: <ListTodo /> },
          ]}
        />
      </div>

      {onTasks ? (
        // Tasks tab — the board's filter nav lives in the sidebar; picking a
        // filter (or the tab itself) opens/focuses the board center pane.
        <TasksSidebar
          repoRoot={repoRoot}
          currentHandle={chat.selfHandle}
          onActivate={onNavigate}
        />
      ) : (
        <>
      <VoiceDockPanel currentRepoRoot={repoRoot} />

      <nav className="slack-sidebar-shortcuts" aria-label="Workspace views">
        <ShortcutRow
          icon={<UnreadGlyph />}
          label="Unreads"
          active={workspaceView === "unreads"}
          badge={totalUnread}
          onClick={() => selectUtility("unreads")}
        />
        <ShortcutRow
          icon={<Sparkles size={17} />}
          label="Recap"
          active={workspaceView === "recap"}
          onClick={() => selectUtility("recap")}
        />
        <ShortcutRow
          icon={<AtSign size={17} />}
          label="Threads"
          active={workspaceView === "threads"}
          onClick={() => selectUtility("threads")}
        />
        <ShortcutRow
          icon={<Send size={17} />}
          label="Drafts & Sent"
          active={workspaceView === "drafts"}
          onClick={() => selectUtility("drafts")}
        />
      </nav>

      {identity !== null && (identity.email ?? "") === "" && (
        <SidebarNotice title="Set your git email">
          Chat needs an identity before messages can be attributed.
        </SidebarNotice>
      )}
      {cloudConnected === false && (
        <SidebarNotice title="Working locally">
          Sign in from Settings to reach teammates online.
        </SidebarNotice>
      )}
      {identityBannerVisible && doctorReport && (
        <SidebarNotice title="Identity needs attention">
          <button
            type="button"
            onClick={() => setIdentityPickerOpen(true)}
            className="slack-sidebar-notice-link"
          >
            Choose who you send as
          </button>
        </SidebarNotice>
      )}

      <div className="slack-sidebar-scroll">
        <SidebarGroup label="Direct Messages" defaultOpen>
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
          {dmRows.length === 0 && (
            <SidebarEmpty icon={<Plus size={14} />} label="Add coworkers" />
          )}
        </SidebarGroup>

        <SidebarGroup
          label="Channels"
          defaultOpen
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
          {allChannels.length === 0 && (
            <SidebarEmpty
              icon={<Plus size={14} />}
              label={railFilter === "all" ? "Add channels" : "No unread channels"}
              onClick={railFilter === "all" ? promptCreateChannel : undefined}
            />
          )}
        </SidebarGroup>

        <SidebarGroup label="Apps" defaultOpen>
          <AppRow icon={<FilePenLine size={15} />} label="Pages" />
          <AppRow
            icon={<Bookmark size={15} />}
            label="Saved items"
            onClick={() => onWorkspaceViewChange("drafts")}
          />
        </SidebarGroup>
      </div>
        </>
      )}
    </aside>
  );
}

function ShortcutRow({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
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

function SidebarGroup({
  label,
  defaultOpen,
  action,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <section className="slack-sidebar-group">
      <div className="slack-sidebar-group-header">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="slack-sidebar-group-toggle"
          aria-expanded={open}
        >
          <ChevronDown size={13} className={open ? "" : "is-collapsed"} />
          <span>{label}</span>
        </button>
        {action}
      </div>
      {open && <div className="slack-sidebar-group-rows">{children}</div>}
    </section>
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

function ConversationGlyph({
  conv,
  presence,
  avatarUrl,
}: {
  conv: Conversation;
  presence?: Presence | null;
  avatarUrl?: string | null;
}) {
  if (conv.kind === "dm") {
    return <Avatar name={conv.name} size={20} presence={presence} src={avatarUrl} />;
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
  const needle = conv.name.toLowerCase();
  const member = members.find(
    (entry) =>
      entry.handle.toLowerCase() === needle || entry.name.toLowerCase() === needle,
  );
  return member?.github_login
    ? `https://github.com/${encodeURIComponent(member.github_login)}.png?size=64`
    : null;
}

function presenceForConversation(
  conv: Conversation,
  members: TeamChatModel["members"],
): Presence | null {
  if (conv.kind !== "dm") return null;
  const needle = conv.name.toLowerCase();
  const member = members.find(
    (entry) =>
      entry.handle.toLowerCase() === needle || entry.name.toLowerCase() === needle,
  );
  if (!member) return "offline";
  const age = Math.floor(Date.now() / 1000) - member.last_seen;
  if (member.last_seen > 0 && age <= 90) return "online";
  if (member.last_seen > 0 && age <= 900) return "idle";
  return "offline";
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

function AppRow({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="slack-conversation-row slack-app-row">
      <span className="slack-app-icon">{icon}</span>
      <span className="slack-conversation-name">{label}</span>
      <MoreHorizontal size={14} className="slack-app-more" />
    </button>
  );
}
