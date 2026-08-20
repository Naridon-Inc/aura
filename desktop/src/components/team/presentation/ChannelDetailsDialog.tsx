// Channel details — the dialog you get from the channel's own name.
//
// It used to be a mock. Six tabs, twelve buttons with no onClick, a
// "Description" field the model has never had (it rendered the topic a second
// time, so the two always read identically), a tab list hardcoded to
// "Messages / Canvas / Files & links / Bookmarks" with the channel's real
// pinned tabs appended underneath, and a Settings tab asserting a posting
// policy and a retention policy that the product does not implement.
//
// Every one of those operations already shipped. `teamChannelUpdate`,
// `teamChannelMemberAdd`/`Remove`, `teamChannelAdminSet`, `teamChannelTabAdd`/
// `Remove` and `teamChannelDelete` are all wired and working — in Settings →
// Team → Channels, several screens away from the channel they act on. So the
// dialog that opens *on* a channel does the work now, against the same calls,
// and the two sections with nothing behind them at all ("Agents & apps",
// "Automations") are gone rather than dressed up.

import { useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Pencil, Plus, Search, Trash2, UserPlus, X } from "lucide-react";

import {
  api,
  type ChannelMeta,
  type TeamIdentity,
  type TeamManifest,
  type TeamMember,
} from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { longDate } from "../../../lib/calendarDate";
import { prettyName, type Conversation } from "../domain";
import { Avatar } from "./Avatar";
import { askConfirm, askForm, askText } from "../../ui/ask";
import { refreshTeam, fetchIdentity } from "../../../lib/teamCache";

export type ChannelDialogTab = "about" | "members" | "tabs" | "settings";

export function ChannelDetailsDialog({
  conv,
  members,
  repoRoot,
  initialTab,
  onTabChange,
  onClose,
}: {
  conv: Conversation;
  /** Team roster from the chat model — the same list the rail shows. Used
   *  while the manifest is still loading so the dialog is never empty. */
  members: TeamMember[];
  repoRoot: string;
  initialTab: ChannelDialogTab;
  onTabChange: (tab: ChannelDialogTab) => void;
  onClose: () => void;
}) {
  const slug = conv.channel ?? prettyName(conv).replace(/^#/, "");
  const channelName = prettyName(conv).replace(/^#/, "");
  const [memberQuery, setMemberQuery] = useState("");
  const state = useChannelAdmin(repoRoot, slug);
  const { meta, roster, canAdmin, busy, error, run } = state;

  // Membership is the manifest's when we have it, and the chat model's until
  // then — the roster is the one thing on this screen worth showing before
  // the load settles.
  const teamMembers = roster.length ? roster : members;
  const isPrivate = (meta?.visibility ?? (conv.private ? "private" : "open")) === "private";
  const inChannel = useCallback(
    (m: TeamMember) =>
      !isPrivate ||
      (meta?.members ?? []).some((e) => e.toLowerCase() === m.email.toLowerCase()),
    [isPrivate, meta],
  );
  const isChannelAdmin = useCallback(
    (m: TeamMember) =>
      (meta?.admins ?? []).some((e) => e.toLowerCase() === m.email.toLowerCase()),
    [meta],
  );

  // An open channel has no allow-list: everybody on the team is in it. A
  // private one shows who was let in, and — for someone who can change that —
  // the rest of the team underneath, so adding is one click and not a search
  // for an email address.
  const channelMembers = useMemo(
    () => teamMembers.filter(inChannel),
    [teamMembers, inChannel],
  );
  const outsiders = useMemo(
    () => (isPrivate && canAdmin ? teamMembers.filter((m) => !inChannel(m)) : []),
    [isPrivate, canAdmin, teamMembers, inChannel],
  );
  const matches = useCallback(
    (m: TeamMember) => {
      const q = memberQuery.trim().toLowerCase();
      if (!q) return true;
      return `${m.name} ${m.handle} ${m.email}`.toLowerCase().includes(q);
    },
    [memberQuery],
  );

  const tabs: Array<{ value: ChannelDialogTab; label: string }> = [
    { value: "about", label: "About" },
    { value: "members", label: `Members ${channelMembers.length}` },
    { value: "tabs", label: `Pinned tabs ${(conv.tabs ?? []).length}` },
    { value: "settings", label: "Settings" },
  ];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const editTopic = async () => {
    const next = await askText({
      title: `Topic for #${channelName}`,
      label: "Topic",
      value: meta?.topic ?? "",
      placeholder: "What this channel is for",
      submitLabel: "Set topic",
    });
    if (next === null) return;
    void run(() => api.teamChannelUpdate(repoRoot, slug, { topic: next }));
  };

  return (
    <div className="slack-channel-dialog-layer" role="presentation">
      <button
        className="slack-channel-dialog-backdrop"
        onClick={onClose}
        aria-label="Close channel details"
      />
      <section
        className="slack-channel-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${channelName} channel details`}
      >
        <header className="slack-channel-dialog-header">
          <div className="slack-channel-dialog-title">
            <span>{isPrivate ? "▣" : "#"}</span>
            <strong>{channelName}</strong>
            {busy && <AsciiSpinner />}
          </div>
          <button
            type="button"
            className="slack-channel-dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={17} />
          </button>
        </header>

        <div className="slack-channel-dialog-content">
          <nav className="slack-channel-dialog-tabs" aria-label="Channel details sections">
            {tabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                className={initialTab === tab.value ? "is-active" : ""}
                onClick={() => onTabChange(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="slack-channel-dialog-body">
            {error && <p className="slack-channel-dialog-error">{error}</p>}

            {initialTab === "about" && (
              <div className="slack-channel-about-card">
                <section>
                  <strong>Channel name</strong>
                  <span>
                    {isPrivate ? "▣" : "#"}
                    {channelName}
                  </span>
                </section>
                <section>
                  <strong>Topic</strong>
                  {/* One field, once. The old dialog printed `conv.hint` here
                      AND again as "Description", which is not a thing this
                      model has — so a channel with a topic appeared to have
                      two identical ones, and a channel without a topic
                      appeared to have a description somebody wrote. */}
                  <span>{meta?.topic?.trim() || "No topic set"}</span>
                  {canAdmin && (
                    <button
                      type="button"
                      onClick={editTopic}
                      disabled={busy}
                      aria-label={meta?.topic ? "Edit topic" : "Add a topic"}
                      title={meta?.topic ? "Edit topic" : "Add a topic"}
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                </section>
                <section>
                  <strong>Who can see it</strong>
                  <span>
                    {isPrivate
                      ? "Private. People are added one at a time"
                      : "Open. Everyone on this team can read and post"}
                  </span>
                </section>
                {meta?.created_at ? (
                  <section>
                    <strong>Created</strong>
                    <span>
                      {longDate(meta.created_at * 1000)}
                      {meta.created_by ? ` by ${meta.created_by}` : ""}
                    </span>
                  </section>
                ) : null}
                <p className="slack-channel-id">Channel ID: {conv.id}</p>
              </div>
            )}

            {initialTab === "members" && (
              <div className="slack-channel-members-view">
                <div className="slack-channel-members-toolbar">
                  <label className="slack-channel-dialog-search">
                    <Search size={15} />
                    <input
                      autoFocus
                      value={memberQuery}
                      onChange={(event) => setMemberQuery(event.target.value)}
                      placeholder="Find members"
                    />
                  </label>
                </div>
                <div className="slack-channel-member-card">
                  {channelMembers.filter(matches).map((member) => (
                    <MemberRow
                      key={member.handle || member.email}
                      member={member}
                      admin={isChannelAdmin(member)}
                      // Promoting on a private channel also adds the member,
                      // so the star is offered wherever the caller can act.
                      canManage={canAdmin}
                      canRemove={canAdmin && isPrivate}
                      busy={busy}
                      onToggleAdmin={() =>
                        void run(() =>
                          api.teamChannelAdminSet(
                            repoRoot,
                            slug,
                            member.email,
                            !isChannelAdmin(member),
                          ),
                        )
                      }
                      onRemove={() =>
                        void run(() =>
                          api.teamChannelMemberRemove(repoRoot, slug, member.email),
                        )
                      }
                    />
                  ))}
                  {channelMembers.filter(matches).length === 0 && (
                    <p className="slack-channel-dialog-no-results">
                      {memberQuery.trim()
                        ? "No members match that search."
                        : "Nobody has been added to this channel yet."}
                    </p>
                  )}
                </div>

                {outsiders.filter(matches).length > 0 && (
                  <>
                    <p className="slack-channel-member-group">Everyone else on the team</p>
                    <div className="slack-channel-member-card">
                      {outsiders.filter(matches).map((member) => (
                        <div
                          key={member.handle || member.email}
                          className="slack-channel-member-row"
                        >
                          <Avatar
                            name={member.name || member.handle}
                            size={30}
                            presence={memberOnline(member) ? "online" : null}
                            src={avatarSrc(member)}
                          />
                          <div>
                            <strong>{member.name || member.handle}</strong>
                            <span>@{member.handle}</span>
                          </div>
                          <button
                            type="button"
                            className="slack-channel-add-member"
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                api.teamChannelMemberAdd(repoRoot, slug, member.email),
                              )
                            }
                            title={`Add ${member.name || member.handle} to #${channelName}`}
                          >
                            <UserPlus size={14} /> Add
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {!isPrivate && (
                  <p className="slack-channel-member-note">
                    This channel is open, so everyone on the team is already in it.
                    Make it private in Settings to choose who can see it.
                  </p>
                )}
              </div>
            )}

            {initialTab === "tabs" && (
              <div className="slack-channel-tab-settings">
                <h3>Pinned tabs</h3>
                {/* The channel's OWN tabs, which is all this section was ever
                    able to change. It used to lead with Messages, Canvas,
                    Files & links and Bookmarks — the built-in views, which
                    are not per-channel and were not removable — and bury the
                    real ones underneath them. */}
                <p>A link pinned here shows up as a tab for everyone in the channel.</p>
                {(conv.tabs ?? []).map((tab) => (
                  <div key={tab.id}>
                    <span title={tab.url}>{tab.label}</span>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Remove the ${tab.label} tab`}
                      title={`Remove the ${tab.label} tab`}
                      onClick={() =>
                        void run(() => api.teamChannelTabRemove(repoRoot, slug, tab.id))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {(conv.tabs ?? []).length === 0 && (
                  <p className="slack-channel-dialog-no-results">
                    No tabs pinned yet.
                  </p>
                )}
                <button
                  type="button"
                  className="slack-dialog-primary"
                  disabled={busy}
                  onClick={async () => {
                    // One sheet, both halves. Asking twice in a row threw the
                    // name away if you backed out of the second question.
                    const v = await askForm({
                      title: "Pin a tab to this channel",
                      submitLabel: "Pin tab",
                      fields: [
                        { name: "label", label: "Tab name", placeholder: "Runbook", required: true },
                        { name: "url", label: "Link", value: "https://", required: true },
                      ],
                    });
                    if (!v?.label.trim() || !v.url.trim()) return;
                    void run(() =>
                      api.teamChannelTabAdd(repoRoot, slug, v.label.trim(), v.url.trim()),
                    );
                  }}
                >
                  <Plus size={15} /> Pin a tab
                </button>
              </div>
            )}

            {initialTab === "settings" && (
              <div className="slack-channel-settings">
                {/* Posting permissions and retention used to be stated here as
                    facts about this channel. Neither exists: everyone who can
                    see a channel can post in it, and nothing is ever deleted.
                    Asserting a policy the product doesn't implement is worse
                    than saying nothing, so what's left is what's real. */}
                <section>
                  <strong>Who can see it</strong>
                  <span>
                    {isPrivate
                      ? "Private. Invitation required"
                      : "Open. Everyone in this workspace can view and join"}
                  </span>
                  {canAdmin && (
                    <button
                      type="button"
                      className="slack-channel-settings-action"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api.teamChannelUpdate(repoRoot, slug, {
                            visibility: isPrivate ? "open" : "private",
                          }),
                        )
                      }
                    >
                      {isPrivate ? "Make open" : "Make private"}
                    </button>
                  )}
                </section>
                {canAdmin && !conv.builtIn && (
                  <section>
                    <strong>Delete this channel</strong>
                    <span>Removes the channel and everything said in it. No undo.</span>
                    <button
                      type="button"
                      className="slack-channel-settings-action is-danger"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          !(await askConfirm({
                            title: `Delete #${channelName}?`,
                            body: "Everything said in it goes too. This can't be undone.",
                            confirmLabel: "Delete channel",
                            tone: "danger",
                          }))
                        )
                          return;
                        void run(() => api.teamChannelDelete(repoRoot, slug)).then(
                          (ok) => {
                            if (ok) onClose();
                          },
                        );
                      }}
                    >
                      Delete
                    </button>
                  </section>
                )}
                {!canAdmin && (
                  <p className="slack-channel-member-note">
                    Changing who can see this channel, or deleting it, needs
                    team-admin or channel-admin rights.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function MemberRow({
  member,
  admin,
  canManage,
  canRemove,
  busy,
  onToggleAdmin,
  onRemove,
}: {
  member: TeamMember;
  admin: boolean;
  canManage: boolean;
  canRemove: boolean;
  busy: boolean;
  onToggleAdmin: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="slack-channel-member-row">
      <Avatar
        name={member.name || member.handle}
        size={30}
        presence={memberOnline(member) ? "online" : null}
        src={avatarSrc(member)}
      />
      <div>
        <strong>{member.name || member.handle}</strong>
        <span>
          @{member.handle}
          {admin ? " · Channel admin" : member.admin ? " · Team admin" : ""}
        </span>
      </div>
      {canManage && (
        <div className="slack-channel-member-actions">
          {open ? (
            <>
              <button type="button" disabled={busy} onClick={onToggleAdmin}>
                {admin ? "Remove as admin" : "Make admin"}
              </button>
              {canRemove && (
                <button
                  type="button"
                  className="is-danger"
                  disabled={busy}
                  onClick={onRemove}
                >
                  Remove
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)} aria-label="Done">
                <X size={14} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="slack-channel-member-more"
              onClick={() => setOpen(true)}
              aria-label={`Manage ${member.name || member.handle} in this channel`}
            >
              <MoreHorizontal size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The channel's live metadata plus whether the person reading it is allowed
 *  to change anything — the two facts every section here depends on.
 *
 *  Mutations return the whole manifest, so a successful call updates the
 *  dialog without a second read; `run` reports the failure in place rather
 *  than leaving a control that appears to have worked. */
function useChannelAdmin(repoRoot: string, slug: string) {
  const [manifest, setManifest] = useState<TeamManifest | null>(null);
  const [identity, setIdentity] = useState<TeamIdentity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!repoRoot) return;
    void Promise.all([
      refreshTeam(repoRoot).catch(() => null),
      fetchIdentity(repoRoot).catch(() => null),
    ]).then(([m, id]) => {
      if (cancelled) return;
      setManifest(m);
      setIdentity(id);
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  const run = useCallback(
    async (fn: () => Promise<TeamManifest>) => {
      setBusy(true);
      setError(null);
      try {
        setManifest(await fn());
        return true;
      } catch (e) {
        setError(
          `That didn't go through. ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const meta: ChannelMeta | null =
    (manifest?.channel_meta ?? []).find((c) => c.slug === slug) ?? null;
  const myEmail = (identity?.email ?? "").toLowerCase();
  const canAdmin =
    (identity?.admin ?? false) ||
    (meta?.admins ?? []).some((a) => a.toLowerCase() === myEmail);

  return {
    meta,
    roster: manifest?.members ?? [],
    canAdmin,
    busy,
    error,
    run,
  };
}

function avatarSrc(member: TeamMember): string | null {
  return member.github_login
    ? `https://github.com/${encodeURIComponent(member.github_login)}.png?size=80`
    : null;
}

function memberOnline(member: TeamMember) {
  const explicit = !!(member as TeamMember & { online?: boolean }).online;
  const recent = member.last_seen > 0 && Date.now() / 1000 - member.last_seen < 90;
  return explicit || recent;
}
