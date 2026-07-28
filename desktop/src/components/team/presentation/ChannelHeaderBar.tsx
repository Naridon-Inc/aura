/** Team (chat) presentation — channel header strip + tab bodies.
 *
 *  The middle pane's top chrome: the channel/DM header row (title, member
 *  count, pin/search/voice/members/refresh/expand actions, Slack-style
 *  underline tabs) plus the Files and Bookmarks tab bodies, the in-channel
 *  search bar, and the typing indicator. Moved verbatim out of the
 *  CommsPanel monolith; logic unchanged. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  File,
  FileText,
  Headphones,
  Image as ImageIcon,
  Link2,
  MoreHorizontal,
  Search as SearchLucide,
  Sparkles,
  SquarePen,
} from "lucide-react";
import { type TeamMember } from "../../../lib/api";
import {
  prettyName,
  previewBody,
  formatPinTime,
  type Conversation,
  type Msg,
} from "../domain";
import {
  ExpandToPaneIcon,
  MembersIcon,
  PinIcon,
  RailLockIcon,
  RefreshIcon,
  SearchIcon,
} from "./icons";
import { callScreenshareWorkpaneId, leaveCall } from "../../../lib/callStore";
import {
  FileAttachment,
  parseAttachments,
  type ChatAttachment,
} from "../../chat/FileAttachment";
import { Avatar } from "./Avatar";
import { onExternalAnchorClick } from "../../../lib/openExternal";

export function ChannelHeader({
  conv,
  repoRoot,
  memberCount,
  members,
  membersOpen,
  onToggleMembers,
  detailsOpen,
  onToggleDetails,
  canvasOpen,
  onToggleCanvas,
  pinsOpen,
  onTogglePins,
  pinCount,
  onRefresh,
  onBackToRail,
  searchActive,
  onToggleSearch,
  voiceMembers,
  inThisVoice,
  onExpand,
}: {
  conv: Conversation;
  repoRoot: string;
  memberCount: number;
  members: TeamMember[];
  membersOpen: boolean;
  onToggleMembers: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  canvasOpen: boolean;
  onToggleCanvas: () => void;
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
  /** Teammates currently in this channel's voice room, derived from the
   * presence beacon. Drives the inline roster + "Leave" affordance. */
  voiceMembers: TeamMember[];
  /** True when the local user is in voice on THIS channel. Derived from
   *  callStore in the parent — no local-state callbacks needed (the
   *  callStore snapshot is the single source of truth for "am I live"). */
  inThisVoice: boolean;
}) {
  const isDm = conv.kind === "dm";
  return (
    <header className="slack-channel-header flex-shrink-0 flex flex-col border-b border-line-soft bg-bg-content">
      {/* Row 1 — title + right-side icons */}
      <div className="slack-channel-header-row flex items-center gap-2 px-3 h-10">
        {onBackToRail && (
          <button
            type="button"
            onClick={onBackToRail}
            className="slack-header-back"
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

        <button
          type="button"
          className="slack-channel-title"
          title={isDm ? conv.hint || prettyName(conv) : "Open channel details"}
          onClick={onToggleDetails}
        >
          {isDm ? (
            <Avatar name={conv.name} size={20} presence="online" />
          ) : conv.private ? (
            <RailLockIcon />
          ) : (
            <span className="slack-channel-title-hash">#</span>
          )}
          <span>{prettyName(conv).replace(/^#/, "")}</span>
          <ChevronDown size={13} />
        </button>

        <div className="flex-1" />

        {!isDm && (
          <button
            type="button"
            className={`slack-member-facepile ${membersOpen ? "is-active" : ""}`}
            onClick={onToggleMembers}
            title="View channel members"
          >
            <span className="slack-facepile-avatars">
              {members.slice(0, 3).map((member) => (
                <Avatar
                  key={member.handle}
                  name={member.name || member.handle}
                  size={22}
                  presence={memberIsOnline(member) ? "online" : null}
                  src={memberAvatarUrl(member)}
                />
              ))}
            </span>
            <span>{memberCount}</span>
          </button>
        )}

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
            window.dispatchEvent(
              new CustomEvent("aura:open-screenshare", {
                detail: {
                  workpaneId: callScreenshareWorkpaneId(repoRoot, channel),
                  repoRoot,
                  channel,
                },
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
        <HeaderIconButton title="Channel recap" onClick={() => onRefresh()}>
          <Sparkles size={15} />
        </HeaderIconButton>
        {!isDm && (
          <HeaderIconButton
            title={canvasOpen ? "Close canvas" : "Open canvas"}
            onClick={onToggleCanvas}
            active={canvasOpen}
          >
            <FileText size={15} />
          </HeaderIconButton>
        )}
        <HeaderIconButton
          title={detailsOpen ? "Close details" : isDm ? "Open profile details" : "Open channel details"}
          onClick={onToggleDetails}
          active={detailsOpen}
        >
          <SquarePen size={15} />
        </HeaderIconButton>
        {onExpand && (
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
        )}
      </div>
    </header>
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
  const [filter, setFilter] = useState<"all" | "files" | "media" | "links">("all");
  const [query, setQuery] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
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
  const links = useMemo(() => {
    const out: { url: string; sender: string; ts: number; msgId: string }[] = [];
    const seen = new Set<string>();
    for (const message of msgs) {
      const { text } = parseAttachments(message.body ?? "");
      for (const match of text.matchAll(/https?:\/\/[^\s<>()\]]+/gi)) {
        const url = match[0].replace(/[.,;:!?]+$/, "");
        const key = `${message.id}:${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url, sender: message.sender, ts: message.ts, msgId: message.id });
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  }, [msgs]);

  const normalizedQuery = query.trim().toLowerCase();
  const searchedFiles = files.filter((item) =>
    !normalizedQuery || `${item.att.filename} ${item.sender}`.toLowerCase().includes(normalizedQuery),
  );
  const media = searchedFiles.filter((item) =>
    /^(image|video)\//i.test(item.att.mime),
  );
  const documents = searchedFiles.filter((item) =>
    !/^(image|video)\//i.test(item.att.mime),
  );
  const searchedLinks = links.filter((item) =>
    !normalizedQuery || `${item.url} ${item.sender}`.toLowerCase().includes(normalizedQuery),
  );
  const ordered = <T extends { ts: number }>(items: T[]) =>
    [...items].sort((a, b) => newestFirst ? b.ts - a.ts : a.ts - b.ts);

  if (files.length === 0 && links.length === 0) {
    return (
      <ChannelTabPlaceholder
        title="No files or links yet"
        body="Files and links shared in this conversation collect here automatically."
      />
    );
  }
  return (
    <div className="slack-files-browser flex-1 overflow-y-auto">
      <div className="slack-files-inner">
        <label className="slack-files-search">
          <SearchLucide size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
        </label>
        <div className="slack-files-controls">
          <div className="slack-files-filters">
            {(["all", "files", "media", "links"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={filter === value ? "is-active" : ""}
                onClick={() => setFilter(value)}
              >
                {value === "all" ? "All" : value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          <button type="button" className="slack-files-sort" onClick={() => setNewestFirst((current) => !current)}>
            {newestFirst ? "Newest" : "Oldest"} <ChevronDown size={14} />
          </button>
        </div>

        {(filter === "all" || filter === "media") && media.length > 0 && (
          <section className="slack-files-section">
            <div className="slack-files-section-heading"><strong>Photos and videos</strong><button type="button" onClick={() => setFilter("media")}>See all</button></div>
            <div className="slack-media-grid">
              {ordered(media).slice(0, filter === "all" ? 5 : undefined).map((item) => (
                <button key={`${item.msgId}:${item.idx}`} type="button" className="slack-media-card" onClick={() => onJump(item.msgId)} title={item.att.filename}>
                  {item.att.mime.toLowerCase().startsWith("image/") ? (
                    <img src={item.att.url} alt={item.att.filename} />
                  ) : (
                    <span><ImageIcon size={28} /><small>{item.att.filename}</small></span>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}

        {(filter === "all" || filter === "files") && documents.length > 0 && (
          <section className="slack-files-section">
            <div className="slack-files-section-heading"><strong>Files</strong><button type="button" onClick={() => setFilter("files")}>See all</button></div>
            <div className="slack-files-list">
              {ordered(documents).map((item) => {
                const author = members.find((member) => member.handle === item.sender)?.name || item.sender || "Unknown";
                return (
                  <div key={`${item.msgId}:${item.idx}`} className="slack-file-result">
                    <FileAttachment attachment={item.att} />
                    <button type="button" onClick={() => onJump(item.msgId)}>{author} · {formatPinTime(item.ts)} · Jump ↗</button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {(filter === "all" || filter === "links") && searchedLinks.length > 0 && (
          <section className="slack-files-section">
            <div className="slack-files-section-heading"><strong>Links</strong><button type="button" onClick={() => setFilter("links")}>See all</button></div>
            <div className="slack-link-results">
              {ordered(searchedLinks).map((item) => {
                const author = members.find((member) => member.handle === item.sender)?.name || item.sender || "Unknown";
                return (
                  <div key={`${item.msgId}:${item.url}`} className="slack-link-result">
                    <span className="slack-link-result-icon"><Link2 size={18} /></span>
                    <div>
                      <a href={item.url} target="_blank" rel="noreferrer" onClick={onExternalAnchorClick}>{linkLabel(item.url)}</a>
                      <span>{safeHost(item.url)}</span>
                      <small>{author} · {formatPinTime(item.ts)}</small>
                    </div>
                    <button type="button" onClick={() => onJump(item.msgId)}>Jump ↗</button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {normalizedQuery && searchedFiles.length === 0 && searchedLinks.length === 0 && (
          <div className="slack-files-no-results">No files or links match “{query}”.</div>
        )}

        {filter === "all" && (
          <section className="slack-files-more">
            <h3>More results by type</h3>
            <div>
              <button type="button" onClick={() => setFilter("files")}><File size={16} /> Files <span>›</span></button>
              <button type="button" onClick={() => setFilter("media")}><ImageIcon size={16} /> Media <span>›</span></button>
              <button type="button" onClick={() => setFilter("links")}><Link2 size={16} /> Links <span>›</span></button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function safeHost(url: string) {
  try { return new URL(url).hostname; } catch { return url; }
}

function linkLabel(url: string) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname);
  } catch {
    return url;
  }
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

function memberIsOnline(member: TeamMember) {
  const backendOnline = !!(member as TeamMember & { online?: boolean }).online;
  const recentlySeen =
    member.last_seen > 0 && Math.floor(Date.now() / 1000) - member.last_seen <= 90;
  return backendOnline || recentlySeen;
}

function memberAvatarUrl(member: TeamMember) {
  return member.github_login
    ? `https://github.com/${encodeURIComponent(member.github_login)}.png?size=64`
    : null;
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
