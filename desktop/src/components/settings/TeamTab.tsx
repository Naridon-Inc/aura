// Settings → Team pane.
//
// Admin surface: roster (Members), the channels people talk in
// (Channels), a per-member daily intent rollup (Activity), and
// per-member token spend (Usage). Members loads from `team_load`;
// Activity embeds StandupView; Usage hits the cloud
// `/api/v1/billing/usage/by_member` endpoint (admin sees all, member
// sees self only — enforced server-side).

import { useCallback, useEffect, useState } from "react";
import { Cloud, Users } from "lucide-react";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { CloudInviteRow } from "./CloudInviteRow";
import { CloudGitIdentityRow } from "./CloudGitIdentityRow";
import {
  api,
  type BillingUsageByMember,
  type TeamManifest,
  type TeamMember,
  type TeamIdentity,
  type DuplicateSuggestion,
  type ChannelMeta,
} from "../../lib/api";
import { peekCache, writeCache } from "../../lib/resourceCache";
import { DuplicatesBanner } from "../team/presentation/DuplicatesBanner";
import { Avatar } from "../team/presentation/Avatar";
import { avatarSrcForMember } from "../../lib/memberAvatar";
import { memberIdentityLine } from "../../lib/memberIdentity";
import { pickPath } from "../../lib/nativeDialog";
import { StandupView } from "../standup/StandupView";
import { relativeAgeFromSecs } from "../../lib/relativeTime";
import { compactNumber } from "../../lib/compactNumber";
import { useDismiss } from "../../lib/useDismiss";
import { formatCost } from "../../lib/money";
import { askConfirm, askText } from "../ui/ask";
import { refreshTeam, fetchIdentity, refreshIdentity } from "../../lib/teamCache";
import {
  fetchBillingUsage,
  invalidateBillingUsage,
} from "../../lib/billingCache";

type TeamSubTab = "members" | "channels" | "activity" | "usage";

export function TeamTab({ repoRoot }: { repoRoot: string }) {
  const [sub, setSub] = useState<TeamSubTab>("members");
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 border-b border-line-soft pb-2">
        <SubTabButton
          active={sub === "members"}
          onClick={() => setSub("members")}
          label="Members"
        />
        <SubTabButton
          active={sub === "channels"}
          onClick={() => setSub("channels")}
          label="Channels"
        />
        <SubTabButton
          active={sub === "activity"}
          onClick={() => setSub("activity")}
          label="Activity"
        />
        <SubTabButton
          active={sub === "usage"}
          onClick={() => setSub("usage")}
          label="Usage"
        />
      </div>
      {sub === "members" && <TeamMembersPane repoRoot={repoRoot} />}
      {sub === "channels" && <TeamChannelsPane repoRoot={repoRoot} />}
      {sub === "activity" && <TeamActivityPane repoRoot={repoRoot} />}
      {sub === "usage" && <TeamUsagePane repoRoot={repoRoot} />}
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-sm px-2 py-1 rounded transition-colors ${
        active
          ? "bg-bg-2 text-text-1 font-medium"
          : "text-text-3 hover:text-text-1 hover:bg-state-hover"
      }`}
    >
      {label}
    </button>
  );
}

/** What the roster panes say when Aura cannot point at a row and say "that
 *  one is you".
 *
 *  Driven in a real window on a machine whose git has no `user.email`, the
 *  Team pane read: two members, one badged `admin`, neither badged `you` —
 *  and under Channels, a note telling the reader that visibility, topics and
 *  deletion "needs team-admin rights". Both panes had asked
 *  `identity?.admin ?? false` and gotten a truthful answer to a question
 *  neither of them asked out loud: we don't know who you are. So the reader
 *  is told they lack a permission, when what actually happened is that Aura
 *  never found their row.
 *
 *  `in_team` is exactly the difference between "you're a member, not an
 *  admin" and "we couldn't match you", and it was going unread. */
function WhoAmINote({ identity }: { identity: TeamIdentity | null }) {
  if (identity?.in_team) return null;
  const email = (identity?.email ?? "").trim();
  return (
    <div className="text-xs text-text-4 leading-snug rounded border border-line-soft bg-bg-2 px-2 py-1.5">
      {identity === null ? (
        <>
          Aura couldn’t work out who you are in this project, so nothing below
          is matched to you.
        </>
      ) : email ? (
        <>
          Nobody here signs work as{" "}
          <span className="text-text-2">{email}</span>, so none of these rows
          is you.
        </>
      ) : (
        <>
          This machine hasn’t set the name and email it signs work with, so
          Aura can’t tell which of these people is you.
        </>
      )}{" "}
      Anything only your own row can do stays switched off until it can.{" "}
      <button
        type="button"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("aura:open-settings", {
              detail: { pane: "identity" },
            }),
          )
        }
        // decoration-line is the border colour: on this ground the underline
        // vanished and the only thing marking the link was that it was
        // brighter than the sentence — which is what a `<span>` looks like.
        className="text-text-2 underline decoration-text-4 underline-offset-2 hover:decoration-text-2"
      >
        Say which one is you
      </button>
    </div>
  );
}

// Team roles admin panel. Built on Aura's own git-derived roster: the
// `admin` flag in team.json is advisory (git gives everyone equal write
// access), so this gates the in-app affordances rather than git itself.
// A vacant admin seat can be *claimed* by any member; an existing admin
// can *promote* others or *transfer* the role and step down. Harder,
// cloud-enforced "super controls" are a later opt-in (Aura-account login)
// — this is the honour-system default any team can use as-is.
// The roster + identity + duplicate hunches, cached per repo so reopening
// Settings → Team paints instantly instead of flashing "Loading…". SWR-style:
// seed from the cache, refetch in the background, write the fresh bundle back.
type CachedTeam = {
  members: TeamMember[];
  identity: TeamIdentity | null;
  dups: DuplicateSuggestion[];
  /** Self-picked profile photos, email→data-URL. Resolved ahead of the GitHub
   *  avatar and the animal monogram. */
  avatars: Record<string, string>;
};

function TeamMembersPane({ repoRoot }: { repoRoot: string }) {
  const cacheKey = `settings-team-members:${repoRoot}`;
  const [members, setMembers] = useState<TeamMember[] | null>(
    () => peekCache<CachedTeam>(cacheKey)?.members ?? null,
  );
  const [identity, setIdentity] = useState<TeamIdentity | null>(
    () => peekCache<CachedTeam>(cacheKey)?.identity ?? null,
  );
  const [dups, setDups] = useState<DuplicateSuggestion[]>(
    () => peekCache<CachedTeam>(cacheKey)?.dups ?? [],
  );
  const [avatars, setAvatars] = useState<Record<string, string>>(
    () => peekCache<CachedTeam>(cacheKey)?.avatars ?? {},
  );
  const [err, setErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Email currently mid-mutation — disables that row's buttons.
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  // Row whose "Merge…" picker is open (by primary email), or null.
  const [mergePickFor, setMergePickFor] = useState<string | null>(null);

  // Dismiss the merge picker on an outside click or Escape. All rows share one
  // open-state, so we key off a `data-merge-pick` marker rather than a per-row
  // ref: a mousedown inside any picker is ignored, anything else closes it.
  useDismiss(!!mergePickFor, () => setMergePickFor(null), [], {
    insideSelector: "[data-merge-pick]",
  });

  const load = useCallback(async () => {
    setErr(null);
    const [t, id, d, av] = await Promise.all([
      refreshTeam(repoRoot),
      fetchIdentity(repoRoot).catch(() => null),
      api.teamIdentitySuggestDuplicates(repoRoot).catch(() => []),
      api.identityAvatarsGet().catch(() => ({}) as Record<string, string>),
    ]);
    const nextMembers = t?.members ?? [];
    setMembers(nextMembers);
    setIdentity(id);
    setDups(d);
    setAvatars(av);
    writeCache<CachedTeam>(cacheKey, {
      members: nextMembers,
      identity: id,
      dups: d,
      avatars: av,
    });
  }, [repoRoot, cacheKey]);

  useEffect(() => {
    let cancelled = false;
    // Paint instantly from the last load for this repo (no null flash), then
    // refresh in the background. On a cold cache these seed to the empty
    // defaults and the spinner shows once, as before.
    const cached = peekCache<CachedTeam>(cacheKey);
    setMembers(cached?.members ?? null);
    setIdentity(cached?.identity ?? null);
    setDups(cached?.dups ?? []);
    setAvatars(cached?.avatars ?? {});
    setActionErr(null);
    load().catch((e) => {
      if (!cancelled) setErr(String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, load, cacheKey]);

  const run = useCallback(
    async (email: string, fn: () => Promise<TeamManifest>) => {
      setBusyEmail(email);
      setActionErr(null);
      try {
        const m = await fn();
        setMembers(m?.members ?? []);
        // Admin status of the local user may have changed (e.g. transfer
        // step-down) — refresh identity so the controls regate.
        const id = await refreshIdentity(repoRoot).catch(() => null);
        setIdentity(id);
      } catch (e) {
        setActionErr(humanizeErr(e));
      } finally {
        setBusyEmail(null);
      }
    },
    [repoRoot],
  );

  // Merge / keep-separate for the duplicate hunches — the same review the team
  // chat roster offers, now here in Settings. Both fold aliases through the
  // shared identity backend; a full reload after picks up the new roster.
  const confirmDup = useCallback(
    async (survivorEmail: string, mergedEmails: string[]) => {
      await api.teamIdentityConfirmDuplicate(repoRoot, survivorEmail, mergedEmails);
      await load();
    },
    [repoRoot, load],
  );
  const rejectDup = useCallback(
    async (emailA: string, emailB: string) => {
      await api.teamIdentityRejectDuplicate(repoRoot, emailA, emailB);
      await load();
    },
    [repoRoot, load],
  );

  // Split a folded-in identity back out into its own person. This is the
  // inverse of "Same person": a member that ended up with several git emails
  // (auto-linked, or a merge that grabbed one email too many) can be pulled
  // apart here. We drop the alias off this member; the email re-derives as its
  // own row from git log on reload. Only offered on your own card or, for an
  // admin, on anyone's — the backend enforces the same rule.
  const separateAlias = useCallback(
    async (targetHandle: string, aliasEmail: string) => {
      setBusyEmail(aliasEmail);
      setActionErr(null);
      try {
        const m = await api.teamAliasRemove(repoRoot, targetHandle, aliasEmail);
        setMembers(m?.members ?? []);
        await load();
      } catch (e) {
        setActionErr(humanizeErr(e));
      } finally {
        setBusyEmail(null);
      }
    },
    [repoRoot, load],
  );

  // Manually declare two people the same — the escape hatch for when the auto
  // suggester never proposed the pair (e.g. a GitHub-handle committer and a
  // personal Gmail with nothing textually in common: "droidnoob" ↔ their real
  // name). Folds the picked member into this row through the same confirm path
  // the suggestions use; `identity_merges` on the backend makes the decision
  // stick across every git re-derive so it can't "come back".
  const mergeWith = useCallback(
    async (survivorEmail: string, mergedEmail: string) => {
      setMergePickFor(null);
      setBusyEmail(survivorEmail);
      setActionErr(null);
      try {
        const mani = await api.teamIdentityConfirmDuplicate(repoRoot, survivorEmail, [
          mergedEmail,
        ]);
        setMembers(mani?.members ?? []);
        await load();
      } catch (e) {
        setActionErr(humanizeErr(e));
      } finally {
        setBusyEmail(null);
      }
    },
    [repoRoot, load],
  );

  // Pick a profile photo for a person and store it locally (email-keyed). We
  // update the map in place so the new face shows the instant the picker
  // returns, without waiting on a full roster reload.
  const pickPhoto = useCallback(async (email: string) => {
    setActionErr(null);
    let path: string | string[] | null;
    try {
      path = await pickPath({
        title: "Choose a profile photo",
      });
    } catch (e) {
      setActionErr(humanizeErr(e));
      return;
    }
    if (!path || Array.isArray(path)) return; // cancelled
    setBusyEmail(email);
    try {
      const dataUrl = await api.identityAvatarSetFromPath(email, path);
      setAvatars((prev) => ({ ...prev, [email.toLowerCase()]: dataUrl }));
    } catch (e) {
      setActionErr(humanizeErr(e));
    } finally {
      setBusyEmail(null);
    }
  }, []);

  const clearPhoto = useCallback(async (email: string) => {
    setBusyEmail(email);
    setActionErr(null);
    try {
      await api.identityAvatarClear(email);
      setAvatars((prev) => {
        const next = { ...prev };
        delete next[email.toLowerCase()];
        return next;
      });
    } catch (e) {
      setActionErr(humanizeErr(e));
    } finally {
      setBusyEmail(null);
    }
  }, []);

  if (err) {
    return (
      <ErrorState
        title="Couldn’t load your team"
        message={err}
        onRetry={() => void load()}
        size="sm"
      />
    );
  }
  if (!members) return <LoadingState label="Loading your team…" />;
  if (members.length === 0) {
    return (
      <div>
        {/* When signed in to a cloud org, you can adopt your account identity
            and invite ahead of the first commit; otherwise the empty state's
            own note is the whole story. */}
        <CloudGitIdentityRow repoRoot={repoRoot} />
        <CloudInviteRow />
        <EmptyState
          icon={Users}
          title="No team members yet"
          size="sm"
          body="Aura fills this in from the project's own history. Commit once and whoever authored it appears here. Nobody has to be invited first."
        />
      </div>
    );
  }

  const iAmAdmin = identity?.admin ?? false;
  const myEmail = (identity?.email ?? "").toLowerCase();
  const hasAdmin = members.some((m) => m.admin);
  const adminCount = members.filter((m) => m.admin).length;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <div className="text-xs font-medium text-text-4">
          {members.length} member{members.length === 1 ? "" : "s"}
          {hasAdmin && (
            <span className="text-text-5">
              {" · "}
              {adminCount} admin{adminCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {!hasAdmin && (
          <button
            type="button"
            disabled={busyEmail !== null}
            onClick={() => run(myEmail || "self", () => api.teamClaim(repoRoot))}
            className="text-xs font-medium px-2 py-1 rounded transition-colors text-bg-deep disabled:opacity-50"
            style={{ background: "var(--color-accent)" }}
            title="No admin yet. Claim the admin seat for this team"
          >
            Claim admin
          </button>
        )}
      </div>

      {!hasAdmin && (
        <div className="text-xs text-text-4 leading-snug px-0.5 pb-1">
          This team has no admin yet. Any member can claim it; the admin can
          later transfer the role or promote others.
        </div>
      )}
      <WhoAmINote identity={identity} />
      <CloudGitIdentityRow repoRoot={repoRoot} />
      <CloudInviteRow />
      {actionErr && (
        <div
          className="text-xs rounded px-2 py-1 leading-snug"
          style={{
            color: "var(--color-red)",
            background: "color-mix(in srgb, var(--color-red) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-red) 30%, transparent)",
          }}
        >
          {actionErr}
        </div>
      )}

      {/* Possible-duplicate review — the same "same person / different people"
          merge the team chat roster offers, surfaced here so people management
          and de-duping live in one place. Renders nothing when there's nothing
          to review. */}
      <DuplicatesBanner
        suggestions={dups}
        onConfirm={confirmDup}
        onReject={rejectDup}
      />

      {members.map((m) => {
        const isMe = m.email.toLowerCase() === myEmail;
        const rowBusy = busyEmail === m.email;
        return (
          <div
            key={m.email}
            className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-state-hover"
          >
            <Avatar
              name={m.name || m.handle || m.email}
              identity={m.email}
              size={30}
              src={avatarSrcForMember(m, avatars)}
              title={m.name || m.handle}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-1 font-medium truncate">
                  {m.name || m.handle}
                </span>
                {m.admin && (
                  <span
                    className="text-2xs px-1.5 py-0.5 rounded"
                    style={{
                      color: "var(--color-amber)",
                      background:
                        "color-mix(in srgb, var(--color-amber) 14%, transparent)",
                      border:
                        "1px solid color-mix(in srgb, var(--color-amber) 30%, transparent)",
                    }}
                  >
                    admin
                  </span>
                )}
                {isMe && (
                  <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-3 text-text-3">
                    you
                  </span>
                )}
                {m.status_emoji && (
                  <span className="text-sm">{m.status_emoji}</span>
                )}
              </div>
              <div className="text-xs text-text-4 truncate">
                {memberIdentityLine(m.email)}
                {m.activity_text ? ` · ${m.activity_text}` : ""}
              </div>

              {/* Folded-in identities — the other git emails treated as this
                  same person. Each can be pulled back out into its own row.
                  Only actionable on your own card or by an admin (the backend
                  enforces the same); otherwise it's shown read-only so people
                  can still see who's grouped together. */}
              {m.also_emails && m.also_emails.length > 0 && (
                <div className="mt-1 flex flex-col gap-0.5">
                  {m.also_emails.map((alias) => {
                    const aliasBusy = busyEmail === alias;
                    const canSeparate = isMe || iAmAdmin;
                    return (
                      <div
                        key={alias}
                        className="flex items-center gap-1.5 text-2xs text-text-4"
                      >
                        <Avatar name={alias} size={16} title={alias} />
                        <span className="truncate">
                          <span className="text-text-5">also </span>
                          {alias}
                        </span>
                        {canSeparate && (
                          <button
                            type="button"
                            disabled={aliasBusy}
                            onClick={() => separateAlias(m.handle, alias)}
                            title={`Pull ${alias} out into its own person`}
                            className="ml-1 flex-shrink-0 rounded border border-line-soft px-1 py-0.5 text-2xs leading-none text-text-4 hover:text-text-1 hover:bg-state-hover disabled:opacity-50"
                          >
                            {aliasBusy ? "…" : "Not the same person"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Manual "these two are the same person" — the escape hatch when
                the auto-suggester never proposed the pair. Offered to an admin
                (on anyone) and to you (on your own card); the backend enforces
                the same rule. Picks a target from the rest of the roster and
                folds it in durably. */}
            {(iAmAdmin || isMe) && members.length > 1 && (
              <div className="relative flex-shrink-0" data-merge-pick>
                <RoleBtn
                  label="Merge…"
                  busy={rowBusy}
                  title="Mark another member as the same person and fold them in"
                  onClick={() =>
                    setMergePickFor((cur) => (cur === m.email ? null : m.email))
                  }
                />
                {mergePickFor === m.email && (
                  <div className="absolute right-0 top-full mt-1 z-20 w-60 max-h-64 overflow-y-auto rounded-md border border-line-soft bg-bg-1 shadow-lg py-1">
                    <div className="px-2 py-1 text-xs text-text-4">
                      Same person as {m.name || m.handle}?
                    </div>
                    {members
                      .filter(
                        (o) => o.email.toLowerCase() !== m.email.toLowerCase(),
                      )
                      .map((o) => (
                        <button
                          key={o.email}
                          type="button"
                          disabled={busyEmail !== null}
                          onClick={() => mergeWith(m.email, o.email)}
                          className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-state-hover disabled:opacity-50"
                        >
                          <Avatar
                            name={o.name || o.handle || o.email}
                            identity={o.email}
                            size={18}
                            src={avatarSrcForMember(o, avatars)}
                            title={o.name || o.handle}
                          />
                          <span className="flex-1 min-w-0">
                            <span className="block text-xs text-text-1 truncate">
                              {o.name || o.handle}
                            </span>
                            <span className="block text-2xs text-text-4 truncate">
                              {memberIdentityLine(o.email)}
                            </span>
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}

            {iAmAdmin && !isMe ? (
              <div className="flex items-center gap-1 flex-shrink-0">
                {m.admin ? (
                  <RoleBtn
                    label="Remove admin"
                    busy={rowBusy}
                    onClick={() =>
                      run(m.email, () =>
                        api.teamSetAdmin(repoRoot, m.email, false),
                      )
                    }
                  />
                ) : (
                  <>
                    <RoleBtn
                      label="Make admin"
                      busy={rowBusy}
                      onClick={() =>
                        run(m.email, () =>
                          api.teamSetAdmin(repoRoot, m.email, true),
                        )
                      }
                    />
                    <RoleBtn
                      label="Transfer"
                      busy={rowBusy}
                      accent
                      title="Make this member admin and step down to member"
                      onClick={async () => {
                        if (
                          await askConfirm({
                            title: `Transfer admin to ${m.name || m.handle}?`,
                            body: "You step down to a regular member. Only they can hand it back.",
                            confirmLabel: "Transfer admin",
                          })
                        ) {
                          run(m.email, () =>
                            api.teamTransferAdmin(repoRoot, m.email),
                          );
                        }
                      }}
                    />
                  </>
                )}
              </div>
            ) : (
              <>
                {/* Your own card gets the photo control — pick a picture, or
                    drop back to your GitHub avatar / animal monogram. Set for
                    yourself only; everyone else falls back automatically. */}
                {isMe && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <RoleBtn
                      label={
                        avatars[m.email.toLowerCase()] ? "Change photo" : "Set photo"
                      }
                      busy={rowBusy}
                      onClick={() => pickPhoto(m.email)}
                    />
                    {avatars[m.email.toLowerCase()] && (
                      <button
                        type="button"
                        disabled={rowBusy}
                        onClick={() => clearPhoto(m.email)}
                        title="Remove your photo"
                        className="rounded border border-line-soft px-1 py-0.5 text-xs leading-none text-text-4 hover:text-text-1 hover:bg-state-hover disabled:opacity-50"
                      >
                        {rowBusy ? "…" : "Remove"}
                      </button>
                    )}
                  </div>
                )}
                <div className="text-xs text-text-4 tabular-nums">
                  {m.commits} commit{m.commits === 1 ? "" : "s"}
                </div>
                <div className="text-xs text-text-4 tabular-nums w-16 text-right">
                  {relAge(m.last_seen)}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RoleBtn({
  label,
  busy,
  accent,
  title,
  onClick,
}: {
  label: string;
  busy: boolean;
  accent?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      title={title}
      className={`text-xs px-1.5 py-0.5 rounded border transition-colors disabled:opacity-50 ${
        accent
          ? "border-line-soft text-text-2 hover:text-text-1 hover:border-line"
          : "border-line-soft text-text-3 hover:text-text-1 hover:bg-state-hover"
      }`}
      style={
        accent
          ? { color: "var(--color-accent)", borderColor: "color-mix(in srgb, var(--color-accent) 35%, transparent)" }
          : undefined
      }
    >
      {busy ? "…" : label}
    </button>
  );
}

// Strip Rust's "Err(...)" wrapper noise so the panel surfaces just the
// human-readable reason a role change was refused.
function humanizeErr(e: unknown): string {
  const s = String((e as { message?: string })?.message ?? e ?? "").trim();
  return s.replace(/^Error:\s*/i, "") || "Something went wrong";
}

// Channels admin panel. Channels are advisory-private: the `visibility`
// flag governs what the rail surfaces, not cryptographic access (anyone
// with the clone can read the JSONL). Team admins (and per-channel
// admins) can create open/private channels, manage membership, set a
// topic, and delete non-core channels. Built-in channels are protected.
const CORE_CHANNEL_SLUGS = ["general", "agents", "sentinel", "pull-requests"];

function TeamChannelsPane({ repoRoot }: { repoRoot: string }) {
  // Cached per repo (SWR) so reopening Settings → Team → Channels paints from
  // the last load instead of blanking to "Loading…" every time.
  const cacheKey = `settings-team-channels:${repoRoot}`;
  const [manifest, setManifest] = useState<TeamManifest | null>(
    () => peekCache<{ manifest: TeamManifest | null; identity: TeamIdentity | null }>(cacheKey)?.manifest ?? null,
  );
  const [identity, setIdentity] = useState<TeamIdentity | null>(
    () => peekCache<{ manifest: TeamManifest | null; identity: TeamIdentity | null }>(cacheKey)?.identity ?? null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newVisibility, setNewVisibility] = useState<"open" | "private">("open");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    const [t, id] = await Promise.all([
      refreshTeam(repoRoot),
      fetchIdentity(repoRoot).catch(() => null),
    ]);
    setManifest(t);
    setIdentity(id);
    writeCache(cacheKey, { manifest: t, identity: id });
  }, [repoRoot, cacheKey]);

  useEffect(() => {
    let cancelled = false;
    const cached = peekCache<{ manifest: TeamManifest | null; identity: TeamIdentity | null }>(cacheKey);
    setManifest(cached?.manifest ?? null);
    setIdentity(cached?.identity ?? null);
    setActionErr(null);
    load().catch((e) => {
      if (!cancelled) setErr(String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, load, cacheKey]);

  const run = useCallback(
    async (key: string, fn: () => Promise<TeamManifest>) => {
      setBusy(key);
      setActionErr(null);
      try {
        const m = await fn();
        setManifest(m);
        const id = await refreshIdentity(repoRoot).catch(() => null);
        setIdentity(id);
      } catch (e) {
        setActionErr(humanizeErr(e));
      } finally {
        setBusy(null);
      }
    },
    [repoRoot],
  );

  if (err) {
    return (
      <ErrorState
        title="Couldn’t load your team settings"
        message={err}
        onRetry={() => void load()}
        size="sm"
      />
    );
  }
  if (!manifest) return <LoadingState label="Loading your team settings…" />;

  const iAmAdmin = identity?.admin ?? false;
  const myEmail = (identity?.email ?? "").toLowerCase();
  const members = manifest.members ?? [];
  const metaBySlug = new Map<string, ChannelMeta>(
    (manifest.channel_meta ?? []).map((c) => [c.slug, c]),
  );
  // Stable ordering: core channels first (in canonical order), then the
  // rest alphabetically — mirrors how the chat rail groups them.
  const channels = [...(manifest.channels ?? [])].sort((a, b) => {
    const ai = CORE_CHANNEL_SLUGS.indexOf(a);
    const bi = CORE_CHANNEL_SLUGS.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.localeCompare(b);
  });

  const canAdminChannel = (slug: string) =>
    iAmAdmin ||
    (metaBySlug.get(slug)?.admins ?? []).some(
      (a) => a.toLowerCase() === myEmail,
    );

  const createChannel = () => {
    const name = newName.trim();
    if (!name) return;
    run("__create__", () =>
      api.teamChannelCreate(
        repoRoot,
        name,
        newVisibility === "private"
          ? { visibility: "private", members: [] }
          : undefined,
      ),
    ).then(() => {
      setNewName("");
      if (newVisibility === "private") {
        setExpanded(slugify(name));
      }
      setNewVisibility("open");
    });
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-text-4">
        {channels.length} channel{channels.length === 1 ? "" : "s"}
      </div>

      <WhoAmINote identity={identity} />

      {/* Create row */}
      <div className="flex items-center gap-1.5">
        <span className="text-text-4 text-base pl-0.5">#</span>
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") createChannel();
          }}
          placeholder="new-channel"
          className="flex-1 min-w-0"
        />
        <Select
          value={newVisibility}
          onChange={(v) => setNewVisibility(v as "open" | "private")}
          options={[
            { value: "open", label: "Open" },
            { value: "private", label: "Private" },
          ]}
          aria-label="Channel visibility"
          className="w-auto min-w-[110px]"
        />
        <button
          type="button"
          disabled={busy === "__create__" || !newName.trim()}
          onClick={createChannel}
          className="text-sm font-medium px-2 py-1 rounded text-bg-deep disabled:opacity-40"
          style={{ background: "var(--color-accent)" }}
        >
          {busy === "__create__" ? "…" : "Create"}
        </button>
      </div>

      {actionErr && (
        <div
          className="text-xs rounded px-2 py-1 leading-snug"
          style={{
            color: "var(--color-red)",
            background: "color-mix(in srgb, var(--color-red) 12%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--color-red) 30%, transparent)",
          }}
        >
          {actionErr}
        </div>
      )}

      <div className="space-y-0.5">
        {channels.map((slug) => {
          const meta = metaBySlug.get(slug);
          const isPrivate = (meta?.visibility ?? "open") === "private";
          const isCore = CORE_CHANNEL_SLUGS.includes(slug);
          const admin = canAdminChannel(slug);
          const rowBusy = busy === slug;
          const memberCount = meta?.members?.length ?? 0;
          const isOpen = expanded === slug;
          return (
            <div
              key={slug}
              className="rounded border border-transparent hover:border-line-soft hover:bg-state-hover transition-colors"
            >
              <div className="flex items-center gap-2 px-2 py-1.5">
                <span className="text-text-4 flex-shrink-0">
                  {isPrivate ? <LockGlyph /> : <span className="text-base">#</span>}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text-1 font-medium truncate">
                      {slug}
                    </span>
                    {isCore && (
                      <span className="text-2xs px-1 py-0.5 rounded bg-bg-3 text-text-4">
                        built-in
                      </span>
                    )}
                    {isPrivate && (
                      <span className="text-2xs text-text-4">
                        {memberCount} member{memberCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {meta?.topic && (
                    <div className="text-xs text-text-4 truncate italic">
                      {meta.topic}
                    </div>
                  )}
                </div>

                {admin && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <RoleBtn
                      label={isPrivate ? "Make open" : "Make private"}
                      busy={rowBusy}
                      onClick={() =>
                        run(slug, () =>
                          api.teamChannelUpdate(repoRoot, slug, {
                            visibility: isPrivate ? "open" : "private",
                          }),
                        )
                      }
                    />
                    <RoleBtn
                      label="Topic"
                      busy={rowBusy}
                      onClick={async () => {
                        const t = await askText({
                          title: `Topic for #${slug}`,
                          label: "Topic",
                          value: meta?.topic ?? "",
                          placeholder: "What this channel is for",
                          submitLabel: "Set topic",
                        });
                        if (t !== null) {
                          run(slug, () =>
                            api.teamChannelUpdate(repoRoot, slug, { topic: t }),
                          );
                        }
                      }}
                    />
                    {isPrivate && (
                      <RoleBtn
                        label={isOpen ? "Done" : "Members"}
                        busy={false}
                        onClick={() => setExpanded(isOpen ? null : slug)}
                      />
                    )}
                    {!isCore && (
                      <RoleBtn
                        label="Delete"
                        busy={rowBusy}
                        onClick={async () => {
                          if (
                            await askConfirm({
                              title: `Delete #${slug}?`,
                              body: "Everything said in it goes too. This can't be undone.",
                              confirmLabel: "Delete channel",
                              tone: "danger",
                            })
                          ) {
                            run(slug, () => api.teamChannelDelete(repoRoot, slug));
                          }
                        }}
                      />
                    )}
                  </div>
                )}
              </div>

              {isOpen && isPrivate && admin && (
                <div className="px-2 pb-2 pt-0.5 ml-6 space-y-0.5 border-t border-line-soft mt-0.5">
                  <div className="text-xs text-text-4 pt-1.5 pb-0.5">
                    Who's in #{slug}
                  </div>
                  {members.map((m) => {
                    const inChannel = (meta?.members ?? []).some(
                      (e) => e.toLowerCase() === m.email.toLowerCase(),
                    );
                    const isChAdmin = (meta?.admins ?? []).some(
                      (e) => e.toLowerCase() === m.email.toLowerCase(),
                    );
                    return (
                      <div key={m.email} className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() =>
                            run(slug, () =>
                              inChannel
                                ? api.teamChannelMemberRemove(repoRoot, slug, m.email)
                                : api.teamChannelMemberAdd(repoRoot, slug, m.email),
                            )
                          }
                          className="flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1 rounded text-left hover:bg-state-hover transition-colors disabled:opacity-50"
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0"
                            style={{
                              borderColor: inChannel
                                ? "var(--color-accent)"
                                : "var(--color-line)",
                              background: inChannel
                                ? "var(--color-accent)"
                                : "transparent",
                            }}
                          >
                            {inChannel && (
                              <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                                <path
                                  d="M3.5 8.5l3 3 6-7"
                                  stroke="var(--color-bg-deep)"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </span>
                          <span className="text-sm text-text-2 truncate">
                            {m.name || m.handle}
                          </span>
                          <span className="text-2xs text-text-5 truncate">
                            {memberIdentityLine(m.email)}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={rowBusy || !inChannel}
                          title={
                            isChAdmin
                              ? "Channel admin. Click to demote"
                              : inChannel
                                ? "Make channel admin"
                                : "Add as member first"
                          }
                          onClick={() =>
                            run(slug, () =>
                              api.teamChannelAdminSet(
                                repoRoot,
                                slug,
                                m.email,
                                !isChAdmin,
                              ),
                            )
                          }
                          className="flex-shrink-0 w-6 h-6 rounded flex items-center justify-center hover:bg-state-hover disabled:opacity-30 transition-colors"
                          style={{
                            color: isChAdmin
                              ? "var(--color-amber)"
                              : "var(--color-text-5)",
                          }}
                        >
                          <StarGlyph filled={isChAdmin} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Only a reader Aura has actually matched to a roster row is being
          told about their permissions. Unmatched, the same sentence reads as
          "you are not an admin" when the truth is "we don't know who you
          are" — WhoAmINote above says that instead. */}
      {!iAmAdmin && identity?.in_team && (
        <div className="text-xs text-text-4 leading-snug pt-1">
          You can create channels. Managing visibility, membership, topics
          and deletion needs team-admin (or channel-admin) rights.
        </div>
      )}
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect
        x="3.5"
        y="7"
        width="9"
        height="6.5"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Star marking a channel-level admin — filled when active, outline when
// the member is just a regular channel member.
function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    >
      <path d="M8 1.8l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.9 4.3 14l.8-4.2L2 6.9l4.2-.5z" />
    </svg>
  );
}

// Local slugify mirroring the Rust `slugify_channel` for optimistic UI
// (auto-expanding the just-created private channel's member manager).
function slugify(name: string): string {
  return name
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
}

function TeamActivityPane({ repoRoot }: { repoRoot: string }) {
  return <StandupView repoRoot={repoRoot} />;
}

function TeamUsagePane({ repoRoot: _repoRoot }: { repoRoot: string }) {
  const [data, setData] = useState<BillingUsageByMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether this machine is signed in to Aura Cloud — which is not the same
   *  question as whether a spend figure came back, and this pane was
   *  answering it with the latter. Both come off the same credential
   *  (`cloud_token`), so a missing one is knowable here rather than being
   *  inferred from a failed request. Null means the check itself failed. */
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const auth = api
      .cloudAuthStatus()
      .then((st) => {
        if (alive) setSignedIn(st?.connected === true);
      })
      .catch(() => {
        if (alive) setSignedIn(null);
      });
    const spend = fetchBillingUsage()
      .then((r) => {
        if (alive) {
          setData(r);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) {
          setData(null);
          setError(String(e?.message ?? e));
        }
      });
    void Promise.all([auth, spend]).then(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = () => {
    // The read is shared with Overview and Cost & usage and held for a
    // minute; a Try again that returns the same cached answer isn't one.
    invalidateBillingUsage();
    setAttempt((n) => n + 1);
  };

  if (loading) {
    return <LoadingState label="Loading token spend…" size="sm" />;
  }

  // Signed out is not a failure, and it was being reported as one: an amber
  // box reading `Couldn't load token usage: no cloud_api_token` — the name
  // of a field in a file on this disk, shown to someone who has simply not
  // signed in yet. The one thing that fixes it was prose naming a menu path
  // ("Onboarding → Cloud") rather than a button.
  if (error && signedIn === false) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-text-1 font-medium">Token spend</div>
        <EmptyState
          size="sm"
          icon={Cloud}
          title="Sign in to see what your team is spending"
          body="Aura Cloud totals what every agent your team runs costs, by person, month by month."
          action={{
            label: "Sign in",
            onClick: () =>
              window.dispatchEvent(new CustomEvent("aura:open-signin")),
          }}
          footnote={
            <>
              Or run <span className="font-mono">aura usage</span> in a
              terminal for this machine's own totals.
            </>
          }
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-text-1 font-medium">Token spend</div>
        <ErrorState
          size="sm"
          title="Couldn’t load token spend"
          message={
            <>
              {signedIn === null
                ? "Aura couldn’t reach the cloud, or check whether you’re signed in to it."
                : "You’re signed in, so this is the cloud not answering rather than anything you need to set up."}{" "}
              <span className="font-mono text-xs break-all text-text-5">
                {error}
              </span>
            </>
          }
          onRetry={retry}
        />
      </div>
    );
  }

  const members = data?.members ?? [];
  const scope = data?.scope ?? "self";
  const month = data?.month ?? "—";
  const total = data?.total_cost_usd ?? 0;

  return (
    <div className="space-y-3 text-sm text-text-3 leading-relaxed">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm text-text-1 font-medium">
          Token spend · {month}
        </div>
        <div className="text-xs text-text-4">
          {scope === "org" ? "All members" : "Your usage"} · total{" "}
          <span className="font-mono">{formatCost(total)}</span>
        </div>
      </div>

      {members.length === 0 ? (
        <div className="rounded border border-bg-3 bg-bg-1/50 px-2 py-2 text-text-4">
          No LLM activity recorded for{" "}
          <span className="font-mono">{month}</span> yet. As soon as an
          agent in this org calls a model through the Aura proxy, its
          tokens land here.
        </div>
      ) : (
        <div className="rounded border border-bg-3 overflow-hidden">
          <div className="grid grid-cols-[1fr_80px_80px_70px] gap-2 px-2 py-1.5 text-xs text-text-4 bg-bg-1/60 border-b border-bg-3">
            <span>Member</span>
            <span className="text-right">In</span>
            <span className="text-right">Out</span>
            <span className="text-right">USD</span>
          </div>
          {members.map((m) => (
            <div
              key={m.developer_id}
              className="grid grid-cols-[1fr_80px_80px_70px] gap-2 px-2 py-1.5 border-b border-bg-3 last:border-b-0 hover:bg-state-hover"
            >
              <div className="min-w-0">
                <div className="text-text-1 truncate">
                  {m.display_name || m.github_login}
                </div>
                {m.display_name && (
                  <div className="text-2xs text-text-4 truncate">
                    @{m.github_login}
                  </div>
                )}
              </div>
              <span className="text-right font-mono tabular-nums">
                {compactNumber(m.tokens_in)}
              </span>
              <span className="text-right font-mono tabular-nums">
                {compactNumber(m.tokens_out)}
              </span>
              <span className="text-right font-mono tabular-nums">
                {formatCost(m.cost_usd)}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-text-4">
        Captured per-call from the cloud LLM proxy. Members who run
        their own keys outside the proxy don't show up here.
      </p>
    </div>
  );
}

function relAge(unixSecs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(unixSecs, { empty: "—" });
}
