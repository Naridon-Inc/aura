/** Team (chat) presentation — the members rail: presence-split roster + local status editor.
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged. */

import { useEffect, useState } from "react";
import { api, type TeamMember } from "../../../lib/api";
import { animalForName, tintForName } from "../../../lib/identityColors";
import { type Conversation } from "../domain";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

// ── members right rail ───────────────────────────────────────────────

export function MembersRail({
  conv,
  members,
  selfHandle,
  onDM,
  isLinkedSelf,
  onLinkSelf,
  onUnlinkSelf,
}: {
  conv: Conversation;
  members: TeamMember[];
  selfHandle: string;
  onDM: (handle: string) => void;
  /** True when this member is one of the local user's OWN linked seats (a
   *  second GitHub login, a work vs personal email). Distinct roster rows,
   *  but every one reads as "you". */
  isLinkedSelf?: (m: TeamMember) => boolean;
  /** Declare a member's seat as "also me". */
  onLinkSelf?: (m: TeamMember) => void;
  /** Undeclare a previously-linked seat. */
  onUnlinkSelf?: (m: TeamMember) => void;
}) {
  // Online/offline split derived from the presence beacon's `last_seen`
  // (unix seconds): a teammate seen within the last 90s counts as online
  // — comfortably above the beacon interval so a live peer doesn't flap
  // to gray between beats. Yourself is always online; an explicit backend
  // `online` field (if one ever lands) still wins. Recomputes whenever
  // the polled members list refreshes.
  const ONLINE_WINDOW_S = 90;
  const nowS = Math.floor(Date.now() / 1000);
  const withOnline = members.map((m) => {
    const backendOnline = !!(m as unknown as { online?: boolean }).online;
    const recent = m.last_seen > 0 && nowS - m.last_seen <= ONLINE_WINDOW_S;
    const isSelf = m.handle === selfHandle;
    return { ...m, online: backendOnline || recent || isSelf };
  });
  const online = withOnline.filter((m) => m.online);
  const offline = withOnline.filter((m) => !m.online);

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-3 h-11 flex items-center border-b border-line-soft">
        <div className="text-[10px] uppercase tracking-wider text-text-5 font-medium">
          {conv.kind === "dm" ? "Details" : "Members"}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-1 py-2">
        {conv.kind === "dm" ? (
          <div className="px-2 text-[11px] text-text-3 leading-snug">
            Direct message with{" "}
            <span className="text-text-1">@{conv.name}</span>.
          </div>
        ) : (
          <>
            <MyStatusEditor />
            <MembersGroup
              label={`Online — ${online.length}`}
              members={online}
              selfHandle={selfHandle}
              onDM={onDM}
              isLinkedSelf={isLinkedSelf}
              onLinkSelf={onLinkSelf}
              onUnlinkSelf={onUnlinkSelf}
              online
            />
            <MembersGroup
              label={`Offline — ${offline.length}`}
              members={offline}
              selfHandle={selfHandle}
              onDM={onDM}
              isLinkedSelf={isLinkedSelf}
              onLinkSelf={onLinkSelf}
              onUnlinkSelf={onUnlinkSelf}
              online={false}
            />
          </>
        )}
      </div>
    </div>
  );
}

// Local-only status editor. Persists to ~/.aura/desktop-status.json via
// `team_status_set` so the value survives restarts and applies across
// every repo. The next presence beacon (sent on a timer by the Rust
// side) carries the new emoji/text to teammates.
function MyStatusEditor() {
  const [emoji, setEmoji] = useState<string>("");
  const [text, setText] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [draftEmoji, setDraftEmoji] = useState("");
  const [draftText, setDraftText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .teamStatusGet()
      .then((s) => {
        if (cancelled) return;
        setEmoji(s.status_emoji ?? "");
        setText(s.activity_text ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const openEditor = () => {
    setDraftEmoji(emoji);
    setDraftText(text);
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.teamStatusSet(
        draftText.trim() || null,
        draftEmoji.trim() || null,
      );
      setEmoji(next.status_emoji ?? "");
      setText(next.activity_text ?? "");
      setOpen(false);
    } catch {
      /* persisted file write failed — leave editor open */
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await api.teamStatusSet(null, null);
      setEmoji("");
      setText("");
      setOpen(false);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <div className="mx-2 mb-2 p-2 rounded-md border border-line-soft bg-bg-2/50">
        <div className="text-[10px] uppercase tracking-wider text-text-5 font-medium pb-1.5">
          Your status
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            type="text"
            value={draftEmoji}
            onChange={(e) =>
              setDraftEmoji([...e.target.value].slice(0, 2).join(""))
            }
            placeholder="🎯"
            className="w-7 h-7 px-0 text-center text-[14px]"
            aria-label="Status emoji"
          />
          <Input
            type="text"
            value={draftText}
            maxLength={140}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder="What's happening?"
            className="flex-1 h-7 text-[11.5px]"
            aria-label="Status text"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-1.5 mt-1.5">
          <Button
            variant="ghost"
            size="xs"
            onClick={clear}
            disabled={busy || (!emoji && !text)}
            className="px-1.5 text-[10.5px] text-text-4 hover:text-text-2"
          >
            Clear
          </Button>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setOpen(false)}
              className="text-[10.5px] text-text-3 hover:text-text-1"
            >
              Cancel
            </Button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="px-2 py-0.5 text-[10.5px] rounded bg-accent/15 hover:bg-accent/25 text-accent"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={openEditor}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-text-3 hover:text-text-1 hover:bg-bg-2 border-b border-line-soft/40 mb-1"
      title="Set status"
    >
      <span className="flex-shrink-0 text-[14px] leading-none">
        {emoji || <span className="text-text-5 text-[11px]">+ Status</span>}
      </span>
      {text ? (
        <span className="flex-1 truncate text-[11px]">{text}</span>
      ) : emoji ? (
        <span className="flex-1 truncate text-[11px] text-text-5">
          Add a description…
        </span>
      ) : null}
    </button>
  );
}

function MembersGroup({
  label,
  members,
  selfHandle,
  onDM,
  isLinkedSelf,
  onLinkSelf,
  onUnlinkSelf,
  online,
}: {
  label: string;
  members: TeamMember[];
  selfHandle: string;
  onDM: (handle: string) => void;
  isLinkedSelf?: (m: TeamMember) => boolean;
  onLinkSelf?: (m: TeamMember) => void;
  onUnlinkSelf?: (m: TeamMember) => void;
  online: boolean;
}) {
  if (members.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="px-2 text-[10px] uppercase tracking-wider text-text-5 font-medium pb-0.5">
        {label}
      </div>
      {members.map((m) => {
        // The user's current effective seat. `linked` = one of their OTHER
        // declared seats ("also me"): a distinct roster row that still reads
        // as you. Both count as `isMe` — no DMing yourself, "· you" badge.
        const isSelf = m.handle === selfHandle;
        const linked = !isSelf && !!isLinkedSelf?.(m);
        const isMe = isSelf || linked;
        const statusEmoji = m.status_emoji ?? "";
        const activityText = m.activity_text ?? "";
        const hasStatus = !!statusEmoji || !!activityText;
        // A member with edit rights but no commits yet — surfaced from the
        // GitHub collaborators sync so the roster reflects who *can*
        // contribute, not only who has. "push" reads as "write".
        const accessOnly = m.commits === 0 && !!m.repo_role;
        const roleLabel = m.repo_role === "push" ? "write" : m.repo_role ?? "";
        // The "also me" affordance is offered on every seat that isn't the
        // primary one — link an alt seat, or unlink one you already claimed.
        const canToggleSelf = !isSelf && (onLinkSelf || onUnlinkSelf);
        const tooltipLines = [
          isSelf
            ? `${m.name} (you)`
            : linked
              ? `${m.name} — also you`
              : `DM @${m.handle}`,
          accessOnly ? `Has ${roleLabel} access — no commits yet` : null,
          activityText ? `${statusEmoji ? statusEmoji + " " : ""}${activityText}` : null,
        ].filter(Boolean) as string[];
        return (
          <div key={m.handle} className="group relative">
          <button
            type="button"
            disabled={isMe}
            onClick={() => !isMe && onDM(m.handle)}
            className={`w-full flex items-start gap-2 px-2 py-1 text-left ${
              isMe
                ? "text-text-3"
                : "text-text-3 hover:text-text-1 hover:bg-bg-2"
            }`}
            title={tooltipLines.join(" — ")}
          >
            <span className="flex-shrink-0 relative mt-[1px]">
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center ${
                  online ? "" : "opacity-60"
                }`}
                style={{ background: tintForName(m.handle), fontSize: 11 }}
              >
                {animalForName(m.handle)}
              </span>
              {statusEmoji ? (
                <span
                  className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border border-bg-1 flex items-center justify-center bg-bg-1"
                  style={{ fontSize: 9, lineHeight: 1 }}
                  aria-hidden
                >
                  {statusEmoji}
                </span>
              ) : (
                <span
                  className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-bg-1"
                  style={{
                    background: online
                      ? "var(--color-accent-green)"
                      : "var(--color-text-5)",
                  }}
                />
              )}
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-1">
                <span className="flex-1 truncate text-[11.5px]">
                  {m.handle}
                  {isMe && <span className="text-text-5"> · you</span>}
                </span>
                {m.admin && (
                  <span className="text-text-5 text-[9px] uppercase tracking-wider">
                    adm
                  </span>
                )}
                {accessOnly && (
                  <span
                    className="text-text-5 text-[9px] uppercase tracking-wider"
                    title={`Has ${roleLabel} access — no commits yet`}
                  >
                    access
                  </span>
                )}
              </span>
              {hasStatus && activityText ? (
                <span className="block truncate text-[10.5px] text-text-5 leading-tight">
                  {activityText}
                </span>
              ) : accessOnly ? (
                <span className="block truncate text-[10.5px] text-text-5 leading-tight">
                  Has {roleLabel} access
                </span>
              ) : null}
            </span>
          </button>
          {canToggleSelf && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (linked) onUnlinkSelf?.(m);
                else onLinkSelf?.(m);
              }}
              className={`absolute top-1 right-1.5 px-1.5 py-0.5 rounded text-[9.5px] leading-none border transition-opacity ${
                linked
                  ? "opacity-0 group-hover:opacity-100 border-line-soft text-text-4 hover:text-text-1 hover:bg-bg-2"
                  : "opacity-0 group-hover:opacity-100 border-accent/25 text-accent hover:bg-accent/10"
              }`}
              title={
                linked
                  ? `Stop treating @${m.handle} as one of your accounts`
                  : `This is also me — count @${m.handle}'s messages as mine (stays a separate teammate row)`
              }
            >
              {linked ? "Not me" : "This is me"}
            </button>
          )}
          </div>
        );
      })}
    </div>
  );
}
