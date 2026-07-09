/** Team (chat) presentation — the collapsible right context panel.
 *
 *  The references-grade third pane of the Team surface. Where the old
 *  monolith scattered context into a slide-over members peek, a header
 *  pins dropdown, and a full-pane thread takeover, this gathers all of it
 *  into one calm, tabbed column: Members / Details / Pinned / Thread.
 *
 *  Threads in particular move here (Slack-style): opening a thread selects
 *  the Thread tab instead of hiding the channel, so the conversation stays
 *  on screen while you read the replies. The panel is pure-presentational —
 *  it takes the `useTeamChat` bundle and wires the existing, proven
 *  sub-panes (`MembersRail`, `PinnedPanel`, `ThreadReplies`) to it. */

import { useMemo } from "react";

import { COMMONS_ENABLED } from "../../../lib/featureFlags";
import { SegmentedControl } from "../../ui/segmented";
import { persistLastRead, prettyName } from "../domain";
import type { TeamChatModel } from "../application/useTeamChat";
import { LoungePanel } from "./LoungePanel";
import { MembersRail } from "./MembersRail";
import { PinnedPanel } from "./PinnedPanel";
import { PluginBrowser } from "./PluginBrowser";
import { ThreadReplies } from "./ThreadReplies";
import { ExpandToPaneIcon, MembersIcon, PinIcon } from "./icons";

export type ContextTab =
  | "members"
  | "details"
  | "pinned"
  | "lounge"
  | "plugins"
  | "thread";

export function ContextPanel({
  chat,
  repoRoot,
  tab,
  onTabChange,
  collapsed = false,
  onToggleCollapse,
}: {
  chat: TeamChatModel;
  repoRoot: string;
  /** Active tab — controlled by the 3-pane shell so the channel header's
   *  Members / Pins buttons can route straight to a tab. */
  tab: ContextTab;
  onTabChange: (next: ContextTab) => void;
  /** When true, the panel renders as a thin re-open rail (responsive /
   *  user collapse). The 3-pane shell owns the actual width. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const {
    active,
    activeThread,
    setActiveThread,
    activeMsgs,
    activePinnedSet,
    members,
    peers,
    selfHandle,
    selfKeys,
    isMemberLinkedSelf,
    linkSelf,
    unlinkSelf,
    setActiveId,
    topLevel,
    togglePin,
    resendMessage,
    lastRead,
    setLastRead,
    lastReadActive,
    myDevice,
    sendMessage,
    wide,
  } = chat;

  // Thread focus (open → Thread tab, close → drop off Thread) is owned by
  // the shell that controls `tab`, so the same logic serves the inline
  // panel and the narrow-width slide-over.
  const pins = useMemo(() => topLevel.filter((m) => m.pinned), [topLevel]);

  if (collapsed) {
    return (
      <aside className="flex flex-col items-center gap-1 border-l border-line-soft bg-bg-1 py-2 w-9 flex-shrink-0">
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Show context"
          aria-label="Show context"
          className="w-7 h-7 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2"
        >
          <ExpandToPaneIcon />
        </button>
        <button
          type="button"
          onClick={() => {
            onTabChange("members");
            onToggleCollapse?.();
          }}
          title="Members"
          aria-label="Members"
          className="w-7 h-7 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2"
        >
          <MembersIcon />
        </button>
        <button
          type="button"
          onClick={() => {
            onTabChange("pinned");
            onToggleCollapse?.();
          }}
          title="Pinned"
          aria-label="Pinned"
          className="relative w-7 h-7 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2"
        >
          <PinIcon />
          {pins.length > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[12px] px-0.5 rounded-full text-[9px] font-semibold tabular-nums leading-none bg-bg-3 text-text-2 border border-line-soft flex items-center justify-center"
              style={{ paddingBlock: 1 }}
            >
              {pins.length > 9 ? "9+" : pins.length}
            </span>
          )}
        </button>
        {COMMONS_ENABLED && (
          <>
            <button
              type="button"
              onClick={() => {
                onTabChange("lounge");
                onToggleCollapse?.();
              }}
              title="Activity"
              aria-label="Activity"
              className="w-7 h-7 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2"
            >
              <LoungeIcon />
            </button>
            <button
              type="button"
              onClick={() => {
                onTabChange("plugins");
                onToggleCollapse?.();
              }}
              title="Plugins"
              aria-label="Plugins"
              className="w-7 h-7 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2"
            >
              <PackageIcon />
            </button>
          </>
        )}
      </aside>
    );
  }

  const isDmActive = active?.kind === "dm";
  const options: { value: ContextTab; label: string }[] = [
    // A 1:1 DM right-panel is just the other person — "Profile" says that
    // plainly. The separate "About" tab (Type + internal channel slug) is
    // meaningful only for channels, so it's dropped for DMs to avoid two
    // tabs ("Details"/"About") that read as the same thing.
    { value: "members", label: isDmActive ? "Profile" : "Members" },
    ...(isDmActive
      ? []
      : ([{ value: "details", label: "About" }] as {
          value: ContextTab;
          label: string;
        }[])),
    { value: "pinned", label: pins.length > 0 ? `Pinned ${pins.length}` : "Pinned" },
    // Activity (lounge) + Plugins are the Commons/community surface — hidden
    // in lockstep with COMMONS_ENABLED.
    ...(COMMONS_ENABLED
      ? ([
          { value: "lounge", label: "Activity" },
          { value: "plugins", label: "Plugins" },
        ] as { value: ContextTab; label: string }[])
      : []),
  ];
  if (activeThread) options.push({ value: "thread", label: "Thread" });

  // Guard against a stranded selection: if the persisted `tab` no longer
  // exists in this conversation's option set (e.g. you were on a channel's
  // "About" then switched to a DM, where "About" is gone), fall back to the
  // first/default pane so the segmented control always shows a live segment.
  const viewTab: ContextTab = options.some((o) => o.value === tab)
    ? tab
    : "members";

  return (
    <aside className="flex flex-col border-l border-line-soft bg-bg-1 h-full min-w-0">
      <div className="flex-shrink-0 flex items-center gap-2 px-2 h-10 border-b border-line-soft">
        <SegmentedControl<ContextTab>
          value={viewTab}
          onChange={onTabChange}
          options={options}
          ariaLabel="Context panel section"
          className="flex-1 overflow-x-auto"
        />
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Hide context"
            aria-label="Hide context"
            className="w-7 h-7 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2 flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M6 3.5L10.5 8 6 12.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {COMMONS_ENABLED && viewTab === "lounge" ? (
          <LoungePanel
            repoRoot={repoRoot}
            members={members}
            onDM={(handle) => {
              const row = peers.find((p) => p.name === handle);
              if (row) {
                setActiveId(row.id);
                setActiveThread(null);
              }
            }}
          />
        ) : COMMONS_ENABLED && viewTab === "plugins" ? (
          <PluginBrowser repoRoot={repoRoot} />
        ) : !active ? (
          <ContextEmpty />
        ) : viewTab === "thread" && activeThread ? (
          <ThreadReplies
            conv={active}
            repoRoot={repoRoot}
            parent={
              activePinnedSet?.has(activeThread.id)
                ? { ...activeThread, pinned: true }
                : activeThread
            }
            replies={activeMsgs.filter((m) => m.thread_parent === activeThread.id)}
            members={members}
            selfHandle={selfHandle}
            selfKeys={selfKeys}
            lastRead={lastReadActive}
            myDeviceId={myDevice?.device_id ?? null}
            myDisplay={myDevice?.display ?? null}
            onBack={() => setActiveThread(null)}
            onSend={(body, atts, files) =>
              sendMessage(active, body, activeThread.id, atts, files)
            }
            onBackToRail={!wide ? () => setActiveId(null) : undefined}
            onTogglePin={(msgId) => togglePin(active.id, msgId)}
            onResend={
              active.channel
                ? (msgId) => resendMessage(active.channel!, msgId)
                : undefined
            }
            onMarkRead={() => {
              const max = activeMsgs.reduce((a, m) => Math.max(a, m.ts), 0);
              if (!max) return;
              const next = { ...lastRead, [active.id]: max };
              setLastRead(next);
              persistLastRead(active.id, max);
            }}
          />
        ) : viewTab === "pinned" ? (
          <PinnedPanel
            pins={pins}
            members={members}
            selfHandle={selfHandle}
            onJump={(msgId) => {
              window.dispatchEvent(
                new CustomEvent("aura:scroll-to-message", { detail: { msgId } }),
              );
            }}
            onUnpin={(msgId) => togglePin(active.id, msgId)}
            onClose={() => onTabChange("members")}
          />
        ) : viewTab === "details" ? (
          <ChannelDetails conv={active} memberCount={members.length} />
        ) : (
          <MembersRail
            conv={active}
            members={members}
            selfHandle={selfHandle}
            isLinkedSelf={isMemberLinkedSelf}
            onLinkSelf={(m) => linkSelf(m.email || m.handle)}
            onUnlinkSelf={(m) => unlinkSelf(m.email || m.handle)}
            onDM={(handle) => {
              const row = peers.find((p) => p.name === handle);
              if (row) {
                setActiveId(row.id);
                setActiveThread(null);
              }
            }}
          />
        )}
      </div>
    </aside>
  );
}

function LoungeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      {/* a couch — seat, back, and two legs */}
      <path
        d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4h7A1.5 1.5 0 0 1 13 5.5V7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M2.5 7.2a1.2 1.2 0 0 1 1.2 1.2V9h8.6v-.6a1.2 1.2 0 1 1 2.2.6v2.3a.9.9 0 0 1-.9.9H3.4a.9.9 0 0 1-.9-.9V8.4a1.2 1.2 0 0 1 0-1.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M4 12.2v1.1M12 12.2v1.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PackageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.8 14 5v6L8 14.2 2 11V5l6-3.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M2 5l6 3 6-3M8 8v6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function ContextEmpty() {
  return (
    <div className="h-full flex flex-col items-center justify-center px-6 text-center">
      <div className="text-text-4 text-[12px]">No conversation selected</div>
      <div className="text-text-5 text-[11px] mt-1 leading-snug max-w-[200px]">
        Pick a channel or direct message to see its members, details, and
        pinned messages here.
      </div>
    </div>
  );
}

function ChannelDetails({
  conv,
  memberCount,
}: {
  conv: import("../domain").Conversation;
  memberCount: number;
}) {
  const isDm = conv.kind === "dm";
  return (
    <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
      <div>
        <div className="text-text-1 text-[13px] font-medium">
          {prettyName(conv)}
        </div>
        {conv.hint && (
          <div className="text-text-4 text-[11.5px] mt-0.5 leading-snug">
            {conv.hint}
          </div>
        )}
      </div>
      <DetailRow label="Type" value={detailKind(conv.kind, conv.private)} />
      {!isDm && conv.kind !== "project" && (
        <DetailRow label="Members" value={String(memberCount)} />
      )}
      {conv.channel && <DetailRow label="Channel" value={`#${conv.channel}`} />}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line-soft/40 pb-2">
      <span className="text-text-5 text-[10.5px] uppercase tracking-wide">
        {label}
      </span>
      <span className="text-text-2 text-[12px] tabular-nums truncate">{value}</span>
    </div>
  );
}

function detailKind(
  kind: import("../domain").Conversation["kind"],
  isPrivate?: boolean,
): string {
  switch (kind) {
    case "dm":
      return "Direct message";
    case "system":
      return "System channel";
    case "project":
      return "Project feed";
    case "custom":
    case "channel":
      return isPrivate ? "Private channel" : "Channel";
  }
}
