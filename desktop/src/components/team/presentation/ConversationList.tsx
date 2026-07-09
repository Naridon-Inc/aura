/** Team (chat) bounded context — the conversation list (left pane).
 *
 *  References-grade rebuild of the old cramped rail: a calm, scannable
 *  list of conversations grouped Channels / Direct Messages / Custom, each
 *  row a 30px Avatar-or-channel-tile + name + last-message preview + relative
 *  time + unread / mention badge. Search runs through the shared ui `Input`,
 *  the per-group create affordance through ui `Button`. The proven model —
 *  `byRecency` ordering with the #aura hero channel pinned to row 0, unread
 *  floats, mention badges — is preserved; only the IA, density, and chrome
 *  are rebuilt on the design system.
 *
 *  Pure presentation: it takes the single `TeamChatModel` the container owns
 *  and renders. No hook of its own. */

import type { TeamChatModel } from "../application/useTeamChat";
import type { Conversation } from "../domain";
import {
  AURA_CONV_ID,
  prettyName,
  railLabel,
  previewBody,
  railTime,
} from "../domain";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { SegmentedControl } from "../../ui/segmented";
import { Avatar } from "./Avatar";
import {
  AuraMarkIcon,
  BellIcon,
  PlusIcon,
  RailLockIcon,
  SearchIcon,
} from "./icons";
import { TeamHeader } from "./TeamHeader";
import { VoiceDockPanel } from "../../chat/VoiceDockPanel";
import { VoiceCountChip } from "../../chat/VoiceRoster";

type ConversationListProps = {
  chat: TeamChatModel;
  repoRoot: string;
  /** Width override from the 3-pane shell. `"full"` fills the container
   *  (single-column mode); a number is a fixed px width the shell can drag
   *  to resize. Omitted by the legacy CommsPanel mount, which keeps the
   *  hook's own wide/railWidth self-sizing. */
  width?: number | "full";
};

export function ConversationList({ chat, repoRoot, width }: ConversationListProps) {
  const {
    identity,
    manifest,
    claim,
    cloudConnected,
    identityBannerVisible,
    doctorReport,
    setIdentityPickerOpen,
    search,
    setSearch,
    railFilter,
    setRailFilter,
    totalUnread,
    totalMentions,
    channelRows,
    dmRows,
    customRows,
    activeId,
    setActiveId,
    setActiveThread,
    voiceByChannel,
    promptCreateChannel,
    wide,
    railWidth,
  } = chat;

  const select = (id: string) => {
    setActiveId(id);
    setActiveThread(null);
  };

  const filterEmpty =
    railFilter !== "all" &&
    channelRows.length === 0 &&
    dmRows.length === 0 &&
    customRows.length === 0;

  // The shell-driven `width` override wins when present; otherwise fall back
  // to the hook's own collapse logic (the legacy CommsPanel mount).
  const sizing =
    width === "full"
      ? { width: undefined, flex: "1 1 auto" }
      : width !== undefined
        ? { width, flex: `0 0 ${width}px` }
        : {
            width: wide ? railWidth : undefined,
            flex: wide ? `0 0 ${railWidth}px` : "1 1 auto",
          };

  return (
    <aside
      className="ade-team-list flex flex-col border-r border-line-soft bg-bg-1 min-w-0"
      style={sizing}
    >
      <TeamHeader
        identity={identity}
        manifest={manifest}
        onClaim={claim}
        repoRoot={repoRoot}
      />

      {/* Compact "Voice Connected" bar — owns its own visibility, renders
          nothing when no huddle/call is live. */}
      <VoiceDockPanel currentRepoRoot={repoRoot} />

      {/* git identity missing — chat sends/attribution are broken until the
          user re-configures `git user.email`. */}
      {identity !== null && (identity.email ?? "") === "" && (
        <div className="flex-shrink-0 mx-2.5 my-2 rounded-md border border-line bg-bg-2 px-2.5 py-2 text-[11px] text-text-2 leading-snug space-y-1">
          <div className="font-medium" style={{ color: "var(--color-amber)" }}>
            git user.email not set
          </div>
          <div className="text-text-3">
            Chat needs a git identity to attribute your messages. Set one and
            the panel will pick it up automatically.
          </div>
          <pre className="font-mono text-[10px] bg-bg-0 px-1.5 py-1 rounded text-text-2 whitespace-pre-wrap">{`git config user.email "you@example.com"`}</pre>
        </div>
      )}

      {/* Cloud sign-in CTA */}
      {cloudConnected === false && (
        <div className="flex-shrink-0 mx-2.5 my-2 rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] px-2.5 py-2 text-[11px] text-text-3 leading-snug">
          Chat lives right here in this project, shared through git. Sign in
          from Settings to also reach teammates online.
        </div>
      )}

      {/* identity-mismatch banner — local git email isn't on the roster. */}
      {identityBannerVisible && doctorReport && (
        <div className="flex-shrink-0 mx-2.5 my-2 rounded-lg border border-line bg-bg-0 shadow-[var(--shadow-card)] px-2.5 py-2 text-[11px] text-text-2 leading-snug space-y-1">
          <div className="font-medium" style={{ color: "var(--color-amber)" }}>
            Your git email isn't on the team roster
          </div>
          <div className="text-text-3">
            Sending as{" "}
            <code className="font-mono">@{doctorReport.handle || "—"}</code> —
            mentions to your team handle may not reach you.
          </div>
          <Button
            variant="subtle"
            size="xs"
            onClick={() => setIdentityPickerOpen(true)}
            className="mt-1"
          >
            Pick identity
          </Button>
        </div>
      )}

      {/* search */}
      <div className="flex-shrink-0 px-2 pt-2 pb-1.5">
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search conversations"
          prefix={<SearchIcon />}
          className="h-7 text-[12px]"
        />
      </div>

      {/* focus filter — the app's shared SegmentedControl, so the Team list
          toggles read identically to every other segmented switch. */}
      <div className="flex-shrink-0 px-2 pb-1.5">
        <SegmentedControl
          ariaLabel="Filter conversations"
          value={railFilter}
          onChange={(v) =>
            setRailFilter(v as "all" | "unread" | "mentions")
          }
          className="w-full"
          options={[
            { value: "all", label: "All" },
            {
              value: "unread",
              label:
                totalUnread > 0
                  ? `Unread ${totalUnread > 99 ? "99+" : totalUnread}`
                  : "Unread",
            },
            {
              value: "mentions",
              label:
                totalMentions > 0
                  ? `Mentions ${totalMentions > 99 ? "99+" : totalMentions}`
                  : "Mentions",
            },
          ]}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-2">
        {filterEmpty && (
          <div className="px-3 py-8 text-center text-[11.5px] text-text-4">
            {railFilter === "mentions"
              ? "No unread mentions. You're all caught up."
              : "Nothing unread. You're all caught up."}
          </div>
        )}

        {(railFilter === "all" || channelRows.length > 0) && (
          <ListGroup
            label="Channels"
            addTitle="Create channel"
            addLabel="New channel"
            onAdd={promptCreateChannel}
          >
            {channelRows.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === activeId}
                onClick={() => select(c.id)}
                voiceCount={
                  c.channel ? voiceByChannel[c.channel]?.length ?? 0 : 0
                }
              />
            ))}
            {channelRows.length === 0 && railFilter === "all" && (
              <ListEmpty
                text="no channels yet"
                actionLabel="Create channel"
                onAction={promptCreateChannel}
              />
            )}
          </ListGroup>
        )}

        {(railFilter === "all" || dmRows.length > 0) && (
          <ListGroup label="Direct Messages">
            {dmRows.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === activeId}
                onClick={() => select(c.id)}
              />
            ))}
            {dmRows.length === 0 && railFilter === "all" && (
              <ListEmpty text="no teammates yet" />
            )}
          </ListGroup>
        )}

        {(railFilter === "all" || customRows.length > 0) && (
          <ListGroup
            label="Custom"
            addTitle="Create channel"
            onAdd={promptCreateChannel}
          >
            {customRows.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === activeId}
                onClick={() => select(c.id)}
                voiceCount={
                  c.channel ? voiceByChannel[c.channel]?.length ?? 0 : 0
                }
              />
            ))}
            {customRows.length === 0 && railFilter === "all" && (
              <ListEmpty text="no custom channels" />
            )}
          </ListGroup>
        )}
      </div>
    </aside>
  );
}

// ── group header + rows ──────────────────────────────────────────────

function ListGroup({
  label,
  addTitle,
  addLabel,
  onAdd,
  children,
}: {
  label: string;
  /** Title/aria for the add control; only read when `onAdd` is set. */
  addTitle?: string;
  /** When set, the add control renders a labeled "+ <addLabel>" pill
   *  instead of the compact icon button. */
  addLabel?: string;
  /** Omit to render no add control at all — used by groups (e.g. Direct
   *  Messages) where every row is already directly clickable, so a "+"
   *  would only open a redundant picker over the same names. */
  onAdd?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 first:mt-0.5">
      <div className="flex items-center justify-between px-2 pb-0.5">
        <span className="text-[10px] uppercase tracking-wider text-text-5 font-semibold">
          {label}
        </span>
        {!onAdd ? null : addLabel ? (
          <Button
            variant="subtle"
            size="xs"
            onClick={onAdd}
            title={addTitle}
            aria-label={addTitle}
            className="h-5 gap-1 px-1.5 text-[10px]"
          >
            <PlusIcon />
            {addLabel}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onAdd}
            title={addTitle}
            aria-label={addTitle}
            className="h-5 w-5 text-text-4 hover:text-text-1"
          >
            <PlusIcon />
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function ListEmpty({
  text,
  actionLabel,
  onAction,
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  if (actionLabel && onAction) {
    return (
      <button
        type="button"
        onClick={onAction}
        className="mx-1 mt-0.5 flex items-center gap-1.5 rounded-md border border-dashed border-line px-2.5 py-2 text-[11.5px] text-text-3 hover:text-text-1 hover:border-line-soft hover:bg-bg-2 transition-colors"
      >
        <PlusIcon />
        <span>{actionLabel}</span>
      </button>
    );
  }
  return (
    <div className="px-2.5 py-1.5 text-[11px] text-text-5 italic">{text}</div>
  );
}

function ConversationRow({
  conv,
  active,
  onClick,
  voiceCount,
}: {
  conv: Conversation;
  active: boolean;
  onClick: () => void;
  voiceCount?: number;
}) {
  const showUnread = !active && !!conv.unread && conv.unread > 0;
  const showMention = !active && !!conv.mentionUnread && conv.mentionUnread > 0;
  const preview = previewBody(conv.lastBody);
  const ts = conv.lastTs ? railTime(conv.lastTs) : "";
  // The pinned #aura home channel is distinguished only by its Aura mark
  // glyph — no loud accent border or tinted name. Calm and subtle: it reads
  // as just another row, with the mark doing the quiet signalling.
  return (
    <button
      type="button"
      onClick={onClick}
      title={conv.hint || prettyName(conv)}
      className={`group w-full flex items-center gap-2 px-2 py-1 text-left rounded-md transition-colors ${
        active
          ? "bg-bg-2 text-text-1"
          : "text-text-2 hover:bg-bg-2 hover:text-text-1"
      }`}
    >
      <ConvGlyph conv={conv} />
      <span className="flex-1 min-w-0 flex flex-col gap-0 leading-tight">
        <span className="flex items-baseline gap-2">
          <span
            className={`flex-1 truncate text-[12.5px] ${
              showUnread ? "font-semibold text-text-1" : "font-medium"
            }`}
          >
            {railLabel(conv)}
            <VoiceCountChip count={voiceCount ?? 0} />
          </span>
          {ts && (
            <span className="text-[10px] text-text-5 tabular-nums flex-shrink-0">
              {ts}
            </span>
          )}
        </span>
        {preview && (
          <span
            className={`truncate text-[11px] ${
              showUnread ? "text-text-2" : "text-text-4"
            }`}
          >
            {preview}
          </span>
        )}
      </span>
      {(showMention || showUnread) && (
        <span className="flex-shrink-0 self-center">
          {showMention ? (
            <MentionBadge count={conv.mentionUnread} />
          ) : (
            <UnreadBadge unread={conv.unread} />
          )}
        </span>
      )}
    </button>
  );
}

// 30px avatar-or-tile: people/DMs get the shared Avatar; channels render a
// rounded tile carrying #, a padlock (private), the Aura mark (#aura hero),
// a ✦ (project feed), or a bell (system feed).
function ConvGlyph({ conv }: { conv: Conversation }) {
  if (conv.kind === "dm") {
    return <Avatar name={conv.name} size={24} />;
  }
  const isAura = conv.id === AURA_CONV_ID;
  const glyph =
    conv.kind === "project" ? (
      <span className="text-[14px]" style={{ color: "var(--color-accent)" }}>
        ✦
      </span>
    ) : conv.kind === "system" ? (
      <span className="text-text-4">
        <BellIcon />
      </span>
    ) : isAura ? (
      <AuraMarkIcon />
    ) : conv.private ? (
      <span className="text-text-4">
        <RailLockIcon />
      </span>
    ) : (
      <span className="text-[15px] leading-none text-text-3">#</span>
    );
  return (
    <span
      className="flex items-center justify-center rounded-md flex-shrink-0"
      style={{ width: 24, height: 24, background: "var(--color-bg-2)" }}
    >
      {glyph}
    </span>
  );
}

// ── badges + focus chip ──────────────────────────────────────────────

function UnreadBadge({ unread }: { unread?: number }) {
  if (!unread || unread <= 0) return null;
  return (
    <span
      className="bg-accent-green text-bg-deep text-[9.5px] font-semibold tabular-nums rounded-full flex items-center justify-center px-1.5 flex-shrink-0"
      style={{ minWidth: 17, height: 17 }}
    >
      {unread > 99 ? "99+" : unread}
    </span>
  );
}

// Distinct from UnreadBadge: an amber "@N" pill for unread messages that
// mention the local user, so a direct ping is visually separable from
// general channel traffic at a glance.
function MentionBadge({ count }: { count?: number }) {
  if (!count || count <= 0) return null;
  return (
    <span
      className="text-bg-deep text-[9.5px] font-semibold tabular-nums rounded-full flex items-center justify-center px-1.5 flex-shrink-0"
      style={{ minWidth: 17, height: 17, background: "var(--color-amber)" }}
      title={`${count} unread mention${count === 1 ? "" : "s"}`}
    >
      @{count > 99 ? "99+" : count}
    </span>
  );
}

