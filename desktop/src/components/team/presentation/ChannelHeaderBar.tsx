/** Team (chat) presentation — channel header strip + tab bodies.
 *
 *  The middle pane's top chrome: the channel/DM header row (title, member
 *  count, pin/search/voice/members/refresh/expand actions, Slack-style
 *  underline tabs) plus the Files and Bookmarks tab bodies, the in-channel
 *  search bar, and the typing indicator. Moved verbatim out of the
 *  CommsPanel monolith; logic unchanged. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, Globe, Headphones, MoreHorizontal } from "lucide-react";
import {
  animalForName,
  colorForName,
  tintForName,
} from "../../../lib/identityColors";
import { type TeamMember } from "../../../lib/api";
import {
  prettyName,
  previewBody,
  formatPinTime,
  type ChannelTab,
  type Conversation,
  type Msg,
} from "../domain";
import {
  BellIcon,
  ExpandToPaneIcon,
  MembersIcon,
  PinIcon,
  RailLockIcon,
  RefreshIcon,
  SearchIcon,
} from "./icons";
import { leaveCall } from "../../../lib/callStore";
import {
  FileAttachment,
  parseAttachments,
  type ChatAttachment,
} from "../../chat/FileAttachment";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

export function ChannelHeader({
  conv,
  repoRoot,
  memberCount,
  membersOpen,
  onToggleMembers,
  pinsOpen,
  onTogglePins,
  pinCount,
  onRefresh,
  onBackToRail,
  activeTab,
  onChangeTab,
  searchActive,
  onToggleSearch,
  voiceMembers,
  inThisVoice,
  onExpand,
  onAddTab,
}: {
  conv: Conversation;
  repoRoot: string;
  memberCount: number;
  membersOpen: boolean;
  onToggleMembers: () => void;
  /** Move the whole chat into the wide center pane. Only the narrow ADE
   *  sidebar mount passes this; the center mount leaves it undefined. */
  onExpand?: () => void;
  pinsOpen: boolean;
  onTogglePins: () => void;
  pinCount: number;
  onRefresh: () => void;
  onBackToRail?: () => void;
  /** Whether the in-channel message search bar is open (drives the menu
   *  item's active state). The bar + query live in the parent. */
  searchActive: boolean;
  onToggleSearch: () => void;
  activeTab: ChannelTab;
  onChangeTab: (next: ChannelTab) => void;
  /** Teammates currently in this channel's voice room, derived from the
   * presence beacon. Drives the inline roster + "Leave" affordance. */
  voiceMembers: TeamMember[];
  /** True when the local user is in voice on THIS channel. Derived from
   *  callStore in the parent — no local-state callbacks needed (the
   *  callStore snapshot is the single source of truth for "am I live"). */
  inThisVoice: boolean;
  /** Pin a team-shared custom URL tab onto this channel (any member —
   *  Slack-bookmark semantics). Absent for conversations that can't carry
   *  tabs (DMs, the cross-repo #aura channel), which hides the "+". */
  onAddTab?: (label: string, url: string) => Promise<void>;
}) {
  const isDm = conv.kind === "dm";
  return (
    <header className="flex-shrink-0 flex flex-col border-b border-line-soft bg-bg-content">
      {/* Row 1 — title + right-side icons */}
      <div className="flex items-center gap-2 px-2 h-10">
        {onBackToRail && (
          <button
            type="button"
            onClick={onBackToRail}
            className="w-7 h-7 rounded text-text-2 hover:text-text-1 hover:bg-bg-2 flex items-center justify-center"
            title="Back"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 3.5L5.5 8 10 12.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}

        {isDm ? (
          <span className="flex-shrink-0 relative">
            <span
              className="w-7 h-7 rounded-full flex items-center justify-center"
              style={{ background: tintForName(conv.name), fontSize: 14 }}
            >
              {animalForName(conv.name)}
            </span>
            {/* TODO(parallel): presence-dot beside DM avatar in header */}
            {/* <div data-slot="presence-dot" /> */}
          </span>
        ) : (
          <ChannelGlyph conv={conv} />
        )}

        <div className="flex-1 min-w-0">
          <div className="text-text-1 text-[12.5px] font-medium truncate flex items-baseline gap-1.5">
            {prettyName(conv)}
            {!isDm && conv.kind !== "project" && (
              <span className="text-text-4 text-[10.5px] font-normal tabular-nums">
                · {memberCount}
              </span>
            )}
          </div>
          <div className="text-text-4 text-[10.5px] truncate -mt-0.5">
            {isDm
              ? /* slot: future "Last active …" / status text */ conv.hint || "Direct message"
              : conv.hint || ""}
          </div>
        </div>

        {/* Voice: one compact headset for every channel — toggles the
            LiveKit huddle. The wide roster pill ate too much header space,
            so its only live signal (someone is in voice) collapses to a
            small presence dot on the icon. */}
        <HeaderIconButton
          title={
            inThisVoice
              ? "Leave huddle"
              : voiceMembers.length > 0
                ? `Join huddle · ${voiceMembers.length} in voice`
                : "Start huddle"
          }
          active={inThisVoice}
          onClick={() => {
            if (inThisVoice) {
              leaveCall();
              return;
            }
            const channel = conv.channel ?? "general";
            window.dispatchEvent(
              new CustomEvent("aura:start-huddle", {
                detail: { repoRoot, channel, channelName: conv.name },
              }),
            );
          }}
        >
          <span className="relative flex items-center justify-center">
            <Headphones size={13} />
            {voiceMembers.length > 0 && !inThisVoice && (
              <span
                className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full"
                style={{ background: "var(--color-accent-green)" }}
              />
            )}
          </span>
        </HeaderIconButton>
        <ChannelOverflowMenu
          membersOpen={membersOpen}
          onToggleMembers={onToggleMembers}
          pinsOpen={pinsOpen}
          onTogglePins={onTogglePins}
          pinCount={pinCount}
          searchActive={searchActive}
          onToggleSearch={onToggleSearch}
          onRefresh={onRefresh}
          onExpand={onExpand}
        />
      </div>

      {/* Row 2 — body-routing tabs (Slack-style underline) */}
      <div className="flex items-center gap-0 px-2 -mb-px">
        <ChannelTabButton
          label="Messages"
          active={activeTab === "messages"}
          onClick={() => onChangeTab("messages")}
        />
        <ChannelTabButton
          label="Canvas"
          icon={<FileText size={11} />}
          active={activeTab === "canvas"}
          onClick={() => onChangeTab("canvas")}
          title="Channel canvas — a Slack-style markdown doc backed by .aura/team/channels/<channel>.notes.md"
        />
        <ChannelTabButton
          label="Files"
          active={activeTab === "files"}
          onClick={() => onChangeTab("files")}
        />
        <ChannelTabButton
          label="Bookmarks"
          active={activeTab === "bookmarks"}
          onClick={() => onChangeTab("bookmarks")}
        />
        {(conv.tabs ?? []).map((t) => (
          <ChannelTabButton
            key={t.id}
            label={t.label}
            icon={<Globe size={11} />}
            active={activeTab === `custom:${t.id}`}
            onClick={() => onChangeTab(`custom:${t.id}`)}
            title={t.url}
          />
        ))}
        {onAddTab && <ChannelAddTabButton onAdd={onAddTab} />}
      </div>
    </header>
  );
}

function ChannelTabButton({
  label,
  active,
  onClick,
  icon,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={`relative flex items-center gap-1 px-2.5 py-1 text-[11.5px] transition-colors ${
        active
          ? "text-text-1"
          : "text-text-3 hover:text-text-1"
      }`}
    >
      {icon}
      <span>{label}</span>
      {active && (
        <span
          className="absolute left-1 right-1 -bottom-px h-[2px] rounded-full bg-text-1"
          aria-hidden
        />
      )}
    </button>
  );
}

// In-channel message search bar. Filters the active channel's loaded
// message stream client-side (body + sender). Esc or the ✕ closes it;
// the match count keeps the result set honest when nothing matches.
export function ChannelSearchBar({
  conv,
  query,
  onChange,
  matchCount,
  onClose,
}: {
  conv: Conversation;
  query: string;
  onChange: (next: string) => void;
  matchCount: number;
  onClose: () => void;
}) {
  const placeholder = `Search ${prettyName(conv)}`;
  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-line-soft bg-bg-content">
      <span className="text-text-4">
        <SearchIcon />
      </span>
      <input
        type="text"
        autoFocus
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent text-[12px] text-text-1 placeholder:text-text-4 outline-none"
      />
      {query.trim() && (
        <span className="text-[10.5px] tabular-nums text-text-4 flex-shrink-0">
          {matchCount} {matchCount === 1 ? "match" : "matches"}
        </span>
      )}
      <button
        type="button"
        onClick={onClose}
        className="w-6 h-6 rounded text-text-3 hover:text-text-1 hover:bg-bg-2 flex items-center justify-center flex-shrink-0"
        title="Close search (Esc)"
        aria-label="Close search"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

// "+" → a small inline form that pins a team-shared URL tab onto the
// channel (label + link). Submits through `onAdd` (the Rust command via
// useTeamChat) so the new tab lands in team.json and re-derives on every
// device; backend errors (max 6, duplicate URL, bad scheme) surface
// inline instead of vanishing into the console.
function ChannelAddTabButton({
  onAdd,
}: {
  onAdd: (label: string, url: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setLabel("");
    setUrl("");
    setErr(null);
  };

  const submit = async () => {
    const l = label.trim();
    let u = url.trim();
    if (!l || !u) {
      setErr("Label and URL are both required");
      return;
    }
    // Forgive a missing scheme — "ci.example.com" means https.
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    setBusy(true);
    setErr(null);
    try {
      await onAdd(l, u);
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="px-2 py-1.5 text-[11.5px] text-text-4 hover:text-text-1"
        title="Add a custom tab (a URL everyone on the team sees)"
        aria-label="Add tab"
      >
        +
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-1 w-64 rounded border border-line-soft bg-bg-1 p-3 shadow-lg"
          role="dialog"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        >
          <div className="mb-2 text-[11.5px] font-medium text-text-1">
            Add a tab
          </div>
          <Input
            type="text"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="Label (e.g. CI, Dashboard)"
            maxLength={24}
            className="mb-1.5 h-7 text-[11.5px]"
          />
          <Input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="https://…"
            className="h-7 text-[11.5px]"
          />
          {err && (
            <div className="mt-1.5 text-[10.5px] leading-snug text-red-400">
              {err}
            </div>
          )}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] text-text-5">
              Shared with the whole team
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={close}
                className="text-[11px] text-text-3"
              >
                Cancel
              </Button>
              <Button
                variant="accentSoft"
                size="xs"
                onClick={() => void submit()}
                disabled={busy}
                className="text-[11px]"
              >
                {busy ? "Adding…" : "Add"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelTabPlaceholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="text-text-1 text-[14px] font-medium">{title}</div>
      <div className="mt-2 max-w-[360px] text-[11.5px] text-text-4 leading-snug">{body}</div>
    </div>
  );
}

// Files tab — aggregates every attachment shared in the channel by
// re-parsing each message body's <aura:attachments> sentinel. No new
// backend: the attachments already live inline in the message stream;
// this is just a channel-wide index of them, newest first, with a jump
// back to the originating message.
export function ChannelFilesTab({
  msgs,
  members,
  onJump,
}: {
  msgs: Msg[];
  members: TeamMember[];
  onJump: (msgId: string) => void;
}) {
  const files = useMemo(() => {
    const out: {
      att: ChatAttachment;
      sender: string;
      ts: number;
      msgId: string;
      idx: number;
    }[] = [];
    for (const m of msgs) {
      const { attachments } = parseAttachments(m.body ?? "");
      attachments.forEach((att, idx) => {
        out.push({ att, sender: m.sender, ts: m.ts, msgId: m.id, idx });
      });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }, [msgs]);

  if (files.length === 0) {
    return (
      <ChannelTabPlaceholder
        title="No files yet"
        body="Files shared in this channel's messages collect here. Attach one from the composer to get started."
      />
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-3 py-3">
      <div className="text-[10.5px] uppercase tracking-wide text-text-3 font-semibold mb-2">
        {files.length} {files.length === 1 ? "file" : "files"}
      </div>
      <div className="flex flex-col gap-2">
        {files.map((f) => {
          const author =
            members.find((x) => x.handle === f.sender)?.name || f.sender || "Unknown";
          return (
            <div
              key={`${f.msgId}:${f.idx}`}
              className="rounded-md border border-line-soft/60 bg-bg-1 p-2"
            >
              <FileAttachment attachment={f.att} />
              <button
                type="button"
                onClick={() => onJump(f.msgId)}
                className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-text-4 hover:text-text-2"
                title="Jump to message"
              >
                <span className="truncate max-w-[140px]">{author}</span>
                <span>·</span>
                <span className="tabular-nums">{formatPinTime(f.ts)}</span>
                <span className="opacity-60">· jump ↗</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Bookmarks tab — the channel's pinned messages, surfaced as a durable
// list (the pin button is the bookmark action; pins persist to
// localStorage per conversation). Click a row to jump to the message,
// or remove the bookmark inline.
export function ChannelBookmarksTab({
  pins,
  members,
  onJump,
  onUnpin,
}: {
  pins: Msg[];
  members: TeamMember[];
  onJump: (msgId: string) => void;
  onUnpin: (msgId: string) => void;
}) {
  if (pins.length === 0) {
    return (
      <ChannelTabPlaceholder
        title="No bookmarks yet"
        body="Pin a message (hover a message → pin) to bookmark it here — decisions, links, anything worth finding again."
      />
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-3 py-3">
      <div className="text-[10.5px] uppercase tracking-wide text-text-3 font-semibold mb-2">
        {pins.length} {pins.length === 1 ? "bookmark" : "bookmarks"}
      </div>
      <div className="flex flex-col gap-0.5">
        {pins
          .slice()
          .sort((a, b) => b.ts - a.ts)
          .map((m) => {
            const author =
              members.find((x) => x.handle === m.sender)?.name || m.sender || "Unknown";
            const preview = previewBody(m.body).slice(0, 200);
            return (
              <div
                key={m.id}
                className="group flex gap-2 rounded-md px-2 py-1.5 cursor-pointer border border-transparent hover:bg-bg-2 hover:border-line-soft/60"
                onClick={() => onJump(m.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] flex items-baseline gap-1.5">
                    <span className="font-medium text-text-1 truncate">{author}</span>
                    <span className="text-text-4 text-[10px] tabular-nums">
                      {formatPinTime(m.ts)}
                    </span>
                  </div>
                  <div className="text-[12px] text-text-2 line-clamp-2">
                    {preview || "(empty)"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnpin(m.id);
                  }}
                  className="text-[10.5px] text-text-4 hover:text-text-1 shrink-0 self-start mt-0.5 opacity-0 group-hover:opacity-100"
                  title="Remove bookmark"
                >
                  Remove
                </button>
              </div>
            );
          })}
      </div>
    </div>
  );
}

export function TypingIndicator({
  peers,
}: {
  peers: { display: string; expires_at: number; channel: string }[];
}) {
  const slot = (
    <div
      data-slot="typing-indicator"
      className="flex-shrink-0 px-3 text-[10.5px] text-text-4 leading-[18px] truncate flex items-center"
      style={{ height: 18 }}
    />
  );
  if (peers.length === 0) return slot;
  const names = Array.from(new Set(peers.map((p) => (p.display || "Someone").split(" ")[0])));
  let label: string;
  if (names.length === 1) label = `${names[0]} is typing`;
  else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing`;
  else label = `${names[0]}, ${names[1]} and ${names.length - 2} more are typing`;
  return (
    <div
      data-slot="typing-indicator"
      className="flex-shrink-0 px-3 text-[10.5px] text-text-4 leading-[18px] truncate flex items-center gap-1"
      style={{ height: 18 }}
    >
      <span aria-hidden>
        <span className="aura-typing-dot" />
        <span className="aura-typing-dot" />
        <span className="aura-typing-dot" />
      </span>
      <span className="italic">{label}…</span>
    </div>
  );
}

function HeaderIconButton({
  title,
  onClick,
  children,
  active,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`w-7 h-7 rounded flex items-center justify-center ${
        active
          ? "text-text-1 bg-bg-2"
          : "text-text-4 hover:text-text-1 hover:bg-bg-2"
      }`}
    >
      {children}
    </button>
  );
}

// Header overflow (3-dots) menu — folds every channel action *except* the
// huddle headset behind a single kebab so the header reads clean: members,
// pinned messages, in-channel search, refresh, and (in the narrow mount)
// open-in-main-pane. The headset stays out front; everything else lives
// here. Click-outside / Esc closes it.
function ChannelOverflowMenu({
  membersOpen,
  onToggleMembers,
  pinsOpen,
  onTogglePins,
  pinCount,
  searchActive,
  onToggleSearch,
  onRefresh,
  onExpand,
}: {
  membersOpen: boolean;
  onToggleMembers: () => void;
  pinsOpen: boolean;
  onTogglePins: () => void;
  pinCount: number;
  searchActive: boolean;
  onToggleSearch: () => void;
  onRefresh: () => void;
  onExpand?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div className="relative" ref={ref}>
      <HeaderIconButton title="More" active={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={15} />
      </HeaderIconButton>
      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-1 w-52 rounded-lg border border-line-soft bg-bg-1 p-1 shadow-[var(--shadow-flyout)]"
          role="menu"
        >
          <OverflowItem
            label={membersOpen ? "Hide members" : "Members"}
            active={membersOpen}
            icon={<MembersIcon />}
            onClick={() => {
              onToggleMembers();
              close();
            }}
          />
          <OverflowItem
            label="Pinned messages"
            active={pinsOpen}
            badge={pinCount > 0 ? (pinCount > 9 ? "9+" : String(pinCount)) : undefined}
            icon={<PinIcon />}
            onClick={() => {
              onTogglePins();
              close();
            }}
          />
          <OverflowItem
            label="Search in channel"
            active={searchActive}
            icon={<SearchIcon />}
            onClick={() => {
              onToggleSearch();
              close();
            }}
          />
          <OverflowItem
            label="Refresh"
            icon={<RefreshIcon />}
            onClick={() => {
              onRefresh();
              close();
            }}
          />
          {onExpand && (
            <>
              <div className="my-1 h-px bg-line-soft" aria-hidden />
              <OverflowItem
                label="Open in main pane"
                icon={<ExpandToPaneIcon />}
                onClick={() => {
                  onExpand();
                  close();
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OverflowItem({
  label,
  icon,
  active,
  badge,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] ${
        active
          ? "text-text-1 bg-bg-2"
          : "text-text-2 hover:bg-bg-2 hover:text-text-1"
      }`}
    >
      <span className="flex h-4 w-4 items-center justify-center text-text-4">
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {badge && (
        <span className="rounded-full border border-line-soft bg-bg-3 px-1.5 text-[10px] font-semibold tabular-nums text-text-2">
          {badge}
        </span>
      )}
    </button>
  );
}

function ChannelGlyph({ conv }: { conv: Conversation }) {
  if (conv.kind === "project") {
    return (
      <span
        className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
        style={{
          background: "var(--color-bg-1)",
          color: "var(--color-accent)",
          border: "1px solid var(--color-line-soft)",
          fontSize: 14,
        }}
      >
        ✦
      </span>
    );
  }
  if (conv.kind === "system") {
    return (
      <span
        className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-text-3"
        style={{
          background: "var(--color-bg-1)",
          border: "1px solid var(--color-line-soft)",
        }}
      >
        <BellIcon />
      </span>
    );
  }
  return (
    <span className="relative flex-shrink-0">
      <span
        className="w-7 h-7 rounded-full flex items-center justify-center font-medium"
        style={{
          background: tintForName(conv.name),
          color: colorForName(conv.name),
          fontSize: 12,
        }}
      >
        {conv.name.charAt(0).toLowerCase() || "·"}
      </span>
      {conv.private && (
        <span
          className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center"
          style={{
            background: "var(--color-bg-content)",
            color: "var(--color-text-4)",
          }}
          title="Private channel"
        >
          <RailLockIcon />
        </span>
      )}
    </span>
  );
}
