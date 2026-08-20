/** Team (chat) presentation — the center conversation column.
 *
 *  The middle pane of the references-grade 3-pane Team surface: channel
 *  header + message stream + composer, or the Files / Bookmarks tabs. Lifted
 *  from the CommsPanel monolith's center column; logic unchanged except that
 *  context (members, pinned, threads) now lives in the right ContextPanel
 *  rather than a slide-over peek, a header dropdown, and a full-pane thread
 *  takeover. Opening a thread now surfaces it beside the still-visible
 *  channel (`onOpenReplies` → `setActiveThread` → ContextPanel Thread tab)
 *  instead of replacing the stream. The header's Members / Pins buttons
 *  route to the context panel via `onSelectContext`.
 *
 *  Pure-presentational on the `useTeamChat` bundle. */

import { useEffect, useState, type ReactNode } from "react";
import {
  Bookmark,
  FileText,
  Link2,
  MessageCircle,
  Plus,
} from "lucide-react";
import type { TeamChatModel } from "../application/useTeamChat";
import {
  AURA_GLOBAL_CHANNEL,
  pseudonymFor,
  type ChannelTab,
} from "../domain";
import type { ContextTab } from "./ContextPanel";
import { ChannelDisclosureCard } from "./ChannelDisclosureCard";
import {
  ChannelHeader,
  ChannelSearchBar,
  ChannelFilesTab,
  ChannelBookmarksTab,
  TypingIndicator,
} from "./ChannelHeaderBar";
import { MessageStream, EmptyNoSelection } from "./MessageStream";
import { Composer } from "./Composer";
import { ChannelCanvasTab } from "./ChannelCanvasTab";
import { ChannelCustomTab } from "./ChannelCustomTab";
import { Button } from "../../ui/button";
import { StripArrows, useStripOverflow } from "../../ui/stripOverflow";
import { askForm } from "../../ui/ask";
import {
  ChannelDetailsDialog,
  type ChannelDialogTab,
} from "./ChannelDetailsDialog";

export function ConversationView({
  chat,
  repoRoot,
  wide: wideOverride,
  onExpand,
  contextTabs,
  onSelectContext,
}: {
  chat: TeamChatModel;
  repoRoot: string;
  /** Width belongs to this presentation mount, not the shared chat model. */
  wide?: boolean;
  /** Narrow-mount "open in main pane" affordance; omitted by the wide mount
   *  that is already expanded. */
  onExpand?: () => void;
  /** Explicit split panes currently open for the active conversation. */
  contextTabs: ContextTab[];
  /** Open or close a synchronized split pane. */
  onSelectContext: (tab: ContextTab) => void;
}) {
  const {
    active,
    channelTab,
    setChannelTab,
    members,
    topLevel,
    fetchActive,
    wide: chatWide,
    setActiveId,
    msgSearchOpen,
    setMsgSearchOpen,
    msgQuery,
    setMsgQuery,
    voiceByChannel,
    myVoiceChannel,
    shownTopLevel,
    activeMsgs,
    threadCounts,
    lastReadActive,
    myDevice,
    activeChannelCursors,
    setActiveThread,
    togglePin,
    resendMessage,
    sendMessage,
    selfHandle,
    selfKeys,
    typingPeers,
    addChannelTab,
    removeChannelTab,
  } = chat;
  const wide = wideOverride ?? chatWide;

  // #aura first-entry disclosure — shown once per device (localStorage
  // marker), dismissed locally for the rest of this mount. The default
  // action keeps the real name; "Use a handle instead" persists a #aura-only
  // alias the send path reads. Read the marker lazily so the card never
  // flashes for a returning user.
  const [disclosureSeen, setDisclosureSeen] = useState(
    () => localStorage.getItem("aura.chat.disclosure.aura") != null,
  );
  const [channelDialogTab, setChannelDialogTab] = useState<ChannelDialogTab | null>(null);

  useEffect(() => {
    const onSelectTab = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string; tab?: ChannelTab }>).detail;
      if (!active || detail?.conversationId !== active.id || !detail.tab) return;
      setChannelTab((tabs) => ({ ...tabs, [active.id]: detail.tab! }));
    };
    window.addEventListener("aura:team-select-tab", onSelectTab);
    return () => window.removeEventListener("aura:team-select-tab", onSelectTab);
  }, [active, setChannelTab]);

  if (!active) return <EmptyNoSelection />;

  // The #aura channel is identified by its `channel` slug (id is `ch:aura`).
  const isAuraGlobal = active.channel === AURA_GLOBAL_CHANNEL;
  const showDisclosure = isAuraGlobal && !disclosureSeen;

  const dismissDisclosure = () => {
    localStorage.setItem("aura.chat.disclosure.aura", "1");
    setDisclosureSeen(true);
  };

  const activeTab = channelTab[active.id] ?? "messages";
  const setTab = (next: ChannelTab) =>
    setChannelTab((m) => ({ ...m, [active.id]: next }));

  // The active custom tab's definition, if a teammate hasn't removed it
  // from under us — when they have, the body falls back gracefully.
  const activeCustomTab = activeTab.startsWith("custom:")
    ? (active.tabs ?? []).find((t) => `custom:${t.id}` === activeTab) ?? null
    : null;

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-bg-content h-full">
      <ChannelHeader
        conv={active}
        repoRoot={repoRoot}
        memberCount={members.length}
        members={members}
        membersOpen={channelDialogTab === "members"}
        onToggleMembers={() => setChannelDialogTab("members")}
        detailsOpen={
          active.kind === "dm"
            ? contextTabs.includes("details")
            : channelDialogTab !== null
        }
        onToggleDetails={() =>
          active.kind === "dm"
            ? onSelectContext("details")
            : setChannelDialogTab("about")
        }
        tabs={
          <ConversationTabs
            active={active}
            activeTab={activeTab}
            onSelect={setTab}
            onAddCustomTab={
              active.channel && active.kind !== "dm"
                ? async () => {
                    // One sheet, both halves — see ChannelDetailsDialog.
                    const v = await askForm({
                      title: "Pin a tab to this channel",
                      submitLabel: "Pin tab",
                      fields: [
                        { name: "label", label: "Tab name", placeholder: "Runbook", required: true },
                        { name: "url", label: "Link", value: "https://", required: true },
                      ],
                    });
                    if (!v?.label.trim() || !v.url.trim()) return;
                    await addChannelTab(active.channel!, v.label.trim(), v.url.trim());
                  }
                : undefined
            }
          />
        }
        pinsOpen={contextTabs.includes("pinned")}
        onTogglePins={() => onSelectContext("pinned")}
        pinCount={topLevel.filter((m) => m.pinned).length}
        onRefresh={fetchActive}
        onBackToRail={!wide ? () => setActiveId(null) : undefined}
        searchActive={msgSearchOpen}
        onToggleSearch={() => {
          setTab("messages");
          setMsgSearchOpen((o) => !o);
          if (msgSearchOpen) setMsgQuery("");
        }}
        voiceMembers={active.channel ? voiceByChannel[active.channel] ?? [] : []}
        inThisVoice={!!active.channel && myVoiceChannel === active.channel}
        onExpand={onExpand}
      />
      {activeTab.startsWith("custom:") ? (
        activeCustomTab ? (
          <ChannelCustomTab
            tab={activeCustomTab}
            onRemove={async () => {
              await removeChannelTab(active.channel!, activeCustomTab.id);
              setTab("messages");
            }}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
            <div className="text-text-1 text-md font-medium">
              This tab was removed
            </div>
            <div className="mt-2 max-w-[360px] text-sm text-text-4 leading-snug">
              A teammate unpinned it from the channel.
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTab("messages")}
              className="mt-3 text-sm"
            >
              Back to messages
            </Button>
          </div>
        )
      ) : activeTab === "messages" ? (
        <>
          {showDisclosure && (
            <ChannelDisclosureCard
              realName={myDevice?.display ?? ""}
              suggestedHandle={pseudonymFor(
                myDevice?.device_id ?? myDevice?.display ?? "aura",
              )}
              onKeepRealName={dismissDisclosure}
              onUsePseudonym={(handle) => {
                localStorage.setItem("aura.chat.handle.aura", handle);
                // Fold this alias into selfKeys now, so messages we post under
                // it this session are recognised as ours instead of echoing
                // back as a stranger.
                window.dispatchEvent(new Event("aura:chat-handle-changed"));
                dismissDisclosure();
              }}
            />
          )}
          {msgSearchOpen && (
            <ChannelSearchBar
              conv={active}
              query={msgQuery}
              onChange={setMsgQuery}
              matchCount={shownTopLevel.length}
              onClose={() => {
                setMsgSearchOpen(false);
                setMsgQuery("");
              }}
            />
          )}
          <MessageStream
            conv={active}
            repoRoot={repoRoot}
            msgs={shownTopLevel}
            members={members}
            selfHandle={selfHandle}
            selfKeys={selfKeys}
            threadCounts={threadCounts}
            allMsgs={activeMsgs}
            lastRead={lastReadActive}
            myDeviceId={myDevice?.device_id ?? null}
            myDisplay={myDevice?.display ?? null}
            readCursors={activeChannelCursors}
            onOpenMembers={() => setChannelDialogTab("members")}
            onOpenReplies={(m) => setActiveThread(m)}
            onTogglePin={(msgId) => togglePin(active.id, msgId)}
            onResend={
              active.channel
                ? (msgId) => resendMessage(active.channel!, msgId)
                : undefined
            }
          />
          <TypingIndicator
            peers={Object.values(typingPeers).filter(
              (p) => active.channel && p.channel === active.channel,
            )}
          />
          {active.kind === "project" ? (
            // The project feed is a rendering of intents, snapshots and
            // commits as they land — there is no send path for it, so
            // `sendMessage` returned without doing anything. The composer
            // still invited you to "Note for <project>…", took the text and
            // dropped it on Send. Say what this surface is instead.
            <div className="border-t border-line-soft px-4 py-2.5 text-xs text-text-4">
              This is {active.name}'s activity as it happens. Intents,
              snapshots and commits. To say something, pick a channel or a
              teammate.
            </div>
          ) : (
            <Composer
              conv={active}
              repoRoot={repoRoot}
              members={members}
              onSend={(body, atts, files) =>
                sendMessage(active, body, undefined, atts, files)
              }
            />
          )}
        </>
      ) : activeTab === "canvas" ? (
        <ChannelCanvasTab
          repoRoot={repoRoot}
          channel={active.channel ?? null}
          channelName={active.name}
        />
      ) : activeTab === "files" ? (
        <ChannelFilesTab
          msgs={activeMsgs}
          members={members}
          onJump={(msgId) => {
            setTab("messages");
            window.dispatchEvent(
              new CustomEvent("aura:scroll-to-message", {
                detail: { msgId },
              }),
            );
          }}
        />
      ) : (
        <ChannelBookmarksTab
          pins={topLevel.filter((m) => m.pinned)}
          members={members}
          onJump={(msgId) => {
            setTab("messages");
            window.dispatchEvent(
              new CustomEvent("aura:scroll-to-message", {
                detail: { msgId },
              }),
            );
          }}
          onUnpin={(msgId) => togglePin(active.id, msgId)}
        />
      )}
      {channelDialogTab && active.kind !== "dm" && (
        <ChannelDetailsDialog
          conv={active}
          members={members}
          repoRoot={repoRoot}
          initialTab={channelDialogTab}
          onTabChange={setChannelDialogTab}
          onClose={() => setChannelDialogTab(null)}
        />
      )}
    </section>
  );
}

function ConversationTabs({
  active,
  activeTab,
  onSelect,
  onAddCustomTab,
}: {
  active: NonNullable<TeamChatModel["active"]>;
  activeTab: ChannelTab;
  onSelect: (tab: ChannelTab) => void;
  onAddCustomTab?: () => void;
}) {
  const tabs: Array<{
    value: ChannelTab;
    label: string;
    icon: ReactNode;
  }> = [
    { value: "messages", label: "Messages", icon: <MessageCircle size={13} /> },
    { value: "canvas", label: "Canvas", icon: <FileText size={13} /> },
    { value: "files", label: "Files & links", icon: <Link2 size={13} /> },
    ...(active.kind === "dm"
      ? []
      : ([{ value: "bookmarks", label: "Bookmarks", icon: <Bookmark size={13} /> }] as const)),
    ...(active.tabs ?? []).map((tab) => ({
      value: `custom:${tab.id}` as ChannelTab,
      label: tab.label,
      icon: <FileText size={13} />,
    })),
  ];

  // Same strip, same rule as a surface's tabs: the cells don't shrink, so a
  // header this row shares with a title, a facepile and four glyphs runs out
  // of width long before the sections run out. Without the arrows a 1200px
  // window showed `Messages | Canvas | Fil` and put "Add a tab" entirely past
  // the edge, with nothing saying either was there.
  const { ref, hidden, page } = useStripOverflow<HTMLElement>({
    active: activeTab,
    activeSelector: ".is-active",
    count: tabs.length,
  });

  return (
    <div className="ade-strip-wrap slack-channel-tabs-wrap">
      <nav
        ref={ref}
        className="slack-channel-tabs"
        aria-label="Conversation sections"
      >
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={activeTab === tab.value ? "is-active" : ""}
            onClick={() => onSelect(tab.value)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
        {onAddCustomTab && (
          <button
            type="button"
            className="slack-channel-tab-add"
            onClick={onAddCustomTab}
            title="Add a tab"
            aria-label="Add a tab"
          >
            <Plus size={14} />
          </button>
        )}
      </nav>
      <StripArrows hidden={hidden} page={page} noun="sections" />
    </div>
  );
}
