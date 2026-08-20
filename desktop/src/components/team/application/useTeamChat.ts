/** useTeamChat — the Team (chat) bounded context APPLICATION layer.
 *
 *  All chat state, effects (WS receiver, polling, read-cursors, presence,
 *  ResizeObserver), derived conversation rows, and the action callbacks
 *  (loadTeam / loadChatChannel / fetchActive / sendMessage / resendMessage /
 *  togglePin / createChannel …) lifted verbatim out of the CommsPanel
 *  monolith. CommsPanel now consumes this hook and renders; the new
 *  references-grade TeamSurface panes build on the same hook. Pure move —
 *  no behaviour change. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  type ChatDoctorReport,
  type ChatMessage,
  type CloudAuthStatus,
  type CommitEntry,
  type DuplicateSuggestion,
  type IntentRow,
  type SentinelMessage,
  type TeamIdentity,
  type TeamManifest,
  type TeamMember,
} from "../../../lib/api";
import { identityBannerKind } from "../../chat/identityChoices";
import { fetchIntentRows } from "../../../lib/intentCache";
import {
  CHAT_FOCUS_EVENT,
  clearPendingChatRoute,
  focusChatChannel,
  takePendingChatRoute,
} from "../../../lib/chatRoute";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";
import { roomTokenParam, roomAuthHeaders } from "../../../lib/roomAuth";
import {
  reactionsStore,
  type ReactionRow,
} from "../../../lib/reactionsStore";
import {
  encodeAttachments,
  type ChatAttachment,
} from "../../chat/FileAttachment";
import {
  encodeRepoFiles,
  type RepoFileAttachment,
} from "../../chat/RepoFileChip";
import {
  type CreateChannelInput,
} from "../../chat/CreateChannelWizard";
import { useCallSnapshot } from "../../../lib/callStore";
import { loadCachedAllForRepo, saveCachedMsgs } from "../../../lib/chatCache";
import { peekCache, writeCache } from "../../../lib/resourceCache";
import { publishTeamUnread } from "../../../lib/teamUnread";
import { isAutomationIdentity } from "../../../lib/agentIdentity";
// Team (chat) domain layer — pure types + helpers + channel identity +
// local persistence. Lifted out of this monolith into the bounded
// context's `team/domain/` tree (DDD: domain / application / presentation),
// reused here by import so behaviour is unchanged while the file shrinks.
import {
  BUILTIN_CHANNELS,
  AURA_GLOBAL_ROOM_ID,
  AURA_GLOBAL_CHANNEL,
  dmChannel,
  dmOtherSide,
  byRecency,
  countThreads,
  chatToMsg,
  auraRosterFromStream,
  convIdForMessage,
  norm,
  commitToMsg,
  intentRowsToSessionMsgs,
  sentinelToMsg,
  loadLastRead,
  persistLastRead,
  loadPinned,
  persistPinned,
  buildSelfKeys,
  senderHandle,
  isSelfSender,
  readSelfLinks,
  addSelfLink,
  removeSelfLink,
  isLinkedSelf,
  isHumanBody,
  SELF_LINKS_EVENT,
  type ChannelTab,
  type Conversation,
  type Msg,
  type ReadCursorEntry,
  type SelfKeys,
} from "../domain";
import { refreshTeam, fetchIdentity, refreshIdentity } from "../../../lib/teamCache";

// Cap the mention-dedup id set. One id lands per message seen, and the set
// otherwise only resets on a repo switch — so a long-lived session on a
// busy channel would grow it without bound. JS Sets keep insertion order,
// so once we cross the ceiling we rebuild from the most-recent tail and
// drop the oldest ids. The cap is far larger than any channel's returned
// backlog, so a dropped id is genuinely old and can't reappear in a poll
// window to re-fire a stale mention toast.
const NOTIFIED_CAP = 4000;
function rememberNotified(set: Set<string>, id: string) {
  set.add(id);
  if (set.size > NOTIFIED_CAP) {
    const keep = Array.from(set).slice(set.size - NOTIFIED_CAP);
    set.clear();
    for (const k of keep) set.add(k);
  }
}

// Shared empty fallbacks. `x ?? []` reads harmlessly but mints a fresh array on
// every render, which is enough on its own to bust every memo downstream of it
// (and, through them, the model object this hook returns).
const NO_MEMBERS: TeamMember[] = [];
const NO_MSGS: Msg[] = [];

// Cheap "did this poll actually change anything" test for the read-only
// activity feeds (project + sentinel). Both are rebuilt from scratch on every
// tick, so without it an unchanged feed still produces a new array identity and
// re-renders the whole Team tree. Id + body + ts is enough: these rows are
// derived, never mutated in place.
function sameFeed(prev: Msg[] | undefined, next: Msg[]): boolean {
  if (!prev || prev.length !== next.length) return false;
  return next.every(
    (m, i) => m.id === prev[i].id && m.ts === prev[i].ts && m.body === prev[i].body,
  );
}

export function useTeamChat(repoRoot: string, projectName: string) {
  // Routing state.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<Msg | null>(null);

  // Data state. Hydrate from the localStorage SWR cache on mount so a
  // fresh app boot paints the active conversation instantly instead of
  // showing one bubble per channel as each `api.chatList` round-trip
  // resolves. The per-channel fetch still runs immediately after; the
  // merge in `loadChatChannel` reconciles any drift.
  const [msgs, setMsgs] = useState<Record<string, Msg[]>>(() =>
    loadCachedAllForRepo<Msg>(repoRoot),
  );
  // Seed identity + roster from the process-lifetime SWR cache so re-entering
  // Team (or switching back to a repo visited earlier this session) paints the
  // last-known roster on the first frame instead of blanking to empty while
  // `loadTeam` round-trips. `loadTeam` revalidates underneath.
  const [identity, setIdentity] = useState<TeamIdentity | null>(
    () => peekCache<TeamIdentity>(`team:identity:${repoRoot}`) ?? null,
  );
  const [manifest, setManifest] = useState<TeamManifest | null>(
    () => peekCache<TeamManifest>(`team:manifest:${repoRoot}`) ?? null,
  );
  // Weak-signal "these rows look like the same person" proposals for the roster
  // review banner. Loaded alongside the roster; a confirm/reject re-fetches.
  const [dupSuggestions, setDupSuggestions] = useState<DuplicateSuggestion[]>(
    [],
  );
  // Stable device identity used for reactions attribution. Loaded once
  // on mount; cheap because deviceIdentity is cached in the Tauri side.
  const [myDevice, setMyDevice] = useState<{
    device_id: string;
    display: string;
    email: string;
  } | null>(null);

  // UI state.
  const [search, setSearch] = useState("");
  // Rail focus filter: show everything, only conversations with unread
  // messages, or only those with unread @mentions. The active
  // conversation always stays visible so reading it doesn't make the
  // row you're looking at vanish.
  const [railFilter, setRailFilter] = useState<"all" | "unread" | "mentions">(
    "all",
  );
  const [membersOpen, setMembersOpen] = useState(true);
  const [pinsOpen, setPinsOpen] = useState(false);
  // In-channel message search. The header search icon toggles a filter
  // bar over the active channel's loaded messages — a real client-side
  // filter on the stream we already hold, not the code-grep workpane.
  const [msgSearchOpen, setMsgSearchOpen] = useState(false);
  const [msgQuery, setMsgQuery] = useState("");
  // Active body tab per conv (Messages | Files | Bookmarks). Canvas is
  // surfaced as a side-sheet so it does not need a persistent value.
  const [channelTab, setChannelTab] = useState<Record<string, ChannelTab>>({});
  /** typing peers keyed by `${channel}::${device_id}` -> {display, expires_at}.
   * Cleared by a 1s tick that drops anything past `expires_at`. */
  const [typingPeers, setTypingPeers] = useState<
    Record<string, { display: string; expires_at: number; channel: string }>
  >({});
  const [panelW, setPanelW] = useState(900);
  const rootRef = useRef<HTMLDivElement>(null);

  // Pinned-message set per conv (lazy-hydrated below); hoisted up here
  // so the cross-repo reset effect can clear it without needing a
  // forward reference.
  const [pinnedByConv, setPinnedByConv] = useState<Record<string, Set<string>>>(
    () => ({}),
  );

  // Memoised per-channel "highest seq we've already emitted" so the
  // read-cursor effect doesn't spam the socket on every msgs/visible
  // change. Hoisted here for the same reason as pinnedByConv.
  const emittedCursorRef = useRef<Record<string, number>>({});

  // Unread tracking — last-read timestamp per conv id. Persisted to
  // localStorage so unread counts survive reloads.
  const [lastRead, setLastRead] = useState<Record<string, number>>(() =>
    loadLastRead(),
  );

  // Peer read cursors, keyed by `${channel}::${device_id}`. Each entry
  // is the highest `last_read_seq` we've seen that peer advance to in
  // that channel. Hydrated on socket open via the `cursors_snapshot`
  // envelope and live-updated by `read_cursor_update` broadcasts.
  const [readCursors, setReadCursors] = useState<Record<string, ReadCursorEntry>>({});
  useEffect(() => {
    function onCursor(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { kind: "update"; channel: string; device_id: string; display: string; last_read_seq: number; last_read_at: string }
        | { kind: "snapshot"; cursors: Array<{ channel: string; device_id: string; display: string; last_read_seq: number; last_read_at: string }> }
        | undefined;
      if (!detail) return;
      setReadCursors((prev) => {
        const next: Record<string, ReadCursorEntry> = { ...prev };
        const apply = (entry: ReadCursorEntry) => {
          if (!entry.device_id || !entry.channel) return;
          const key = `${entry.channel}::${entry.device_id}`;
          const existing = next[key];
          // Strictly monotonic on the client too — stale frames are a
          // no-op so a late broadcast can never rewind the receipt.
          if (existing && existing.last_read_seq >= entry.last_read_seq) return;
          next[key] = entry;
        };
        if (detail.kind === "update") {
          apply({
            channel: detail.channel,
            device_id: detail.device_id,
            display: detail.display,
            last_read_seq: detail.last_read_seq,
            last_read_at: detail.last_read_at,
          });
        } else {
          for (const c of detail.cursors) {
            apply({
              channel: String(c.channel ?? "general"),
              device_id: String(c.device_id ?? ""),
              display: String(c.display ?? ""),
              last_read_seq: Number(c.last_read_seq ?? 0),
              last_read_at: String(c.last_read_at ?? ""),
            });
          }
        }
        return next;
      });
    }
    window.addEventListener("aura:chat-read-cursor", onCursor);
    return () => window.removeEventListener("aura:chat-read-cursor", onCursor);
  }, []);

  const visible = useDocumentVisibility();
  // Always prefer effective_handle (post-override / post-alias-resolve) over
  // the raw roster handle. chat_send stamps `from_handle` with the effective
  // handle, so self-echo dedup at the WS receiver below MUST compare against
  // the same value — otherwise our own messages echo back as foreign and the
  // bubble appears twice.
  const selfHandle = identity?.effective_handle || identity?.handle || "";
  // The #aura-only pseudonym the user opted into lives in localStorage
  // (ConversationView writes it on pick). Mirror it into state so `selfKeys`
  // recomputes — otherwise our own #aura messages, which chat_send stamps under
  // the alias, fail the self-echo test and render as a peer ("my messages come
  // back to me as glacial-fox-836"). Re-read on the change event + cross-tab
  // storage event so toggling the handle mid-session applies without a reload.
  const [auraAlias, setAuraAlias] = useState<string | null>(() => {
    try {
      return localStorage.getItem("aura.chat.handle.aura");
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const reread = () => {
      try {
        setAuraAlias(localStorage.getItem("aura.chat.handle.aura"));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("aura:chat-handle-changed", reread);
    window.addEventListener("storage", reread);
    return () => {
      window.removeEventListener("aura:chat-handle-changed", reread);
      window.removeEventListener("storage", reread);
    };
  }, []);
  // The local user's OTHER roster seats they declared as "also me" — a
  // second GitHub login, a work identity vs a personal one. Stored per-machine
  // like the #aura alias (never leaves this device, never rewrites the shared
  // roster). Mirror into state + re-read on the change event / cross-tab
  // storage event so toggling a link applies without a reload.
  const [selfLinks, setSelfLinks] = useState<string[]>(() => readSelfLinks());
  useEffect(() => {
    const reread = () => setSelfLinks(readSelfLinks());
    window.addEventListener(SELF_LINKS_EVENT, reread);
    window.addEventListener("storage", reread);
    return () => {
      window.removeEventListener(SELF_LINKS_EVENT, reread);
      window.removeEventListener("storage", reread);
    };
  }, []);
  // Resolve those declared tokens (each an email OR a handle) against the
  // roster: gather every matching seat's handle + email + alias emails + gh
  // login, plus the raw tokens themselves, so `selfKeys` covers every form a
  // linked seat's messages could be stamped with. Distinct seats stay distinct
  // in the roster; only their *attribution* is unified onto us.
  const alsoLinks = useMemo(() => {
    const handles = new Set<string>();
    const emails = new Set<string>();
    for (const t of selfLinks) {
      if (t.includes("@")) emails.add(t);
      else handles.add(t);
    }
    for (const m of manifest?.members ?? []) {
      if (
        isLinkedSelf(
          {
            email: m.email,
            handle: m.handle,
            githubLogin: m.github_login,
            alsoEmails: m.also_emails,
          },
          selfLinks,
        )
      ) {
        if (m.handle) handles.add(m.handle.toLowerCase());
        if (m.email) emails.add(m.email.toLowerCase());
        if (m.github_login) handles.add(m.github_login.toLowerCase());
        for (const e of m.also_emails ?? []) emails.add(e.toLowerCase());
      }
    }
    return { handles: [...handles], emails: [...emails] };
  }, [selfLinks, manifest]);
  // Declare / undeclare a roster seat (by any of its identity tokens) as
  // "also me". Writes the per-machine store; the change event refreshes
  // `selfLinks` above, which recomputes selfKeys + the peer list.
  const linkSelf = useCallback((token: string) => {
    addSelfLink(token);
  }, []);
  const unlinkSelf = useCallback((token: string) => {
    removeSelfLink(token);
  }, []);
  /** True when a roster member is one of the local user's own linked seats.
   *  Drives the "You" badge + the "This is also me" ⇄ "Not me" toggle. */
  const isMemberLinkedSelf = useCallback(
    (m: {
      email?: string | null;
      handle?: string | null;
      github_login?: string | null;
      also_emails?: string[] | null;
    }) =>
      isLinkedSelf(
        {
          email: m.email,
          handle: m.handle,
          githubLogin: m.github_login,
          alsoEmails: m.also_emails,
        },
        selfLinks,
      ),
    [selfLinks],
  );
  // Every token that legitimately means "me" — both identity sources, raw
  // and email-local-part forms, plus any linked seats. `fromMe` / self-echo
  // dedup test sender membership against this set so a message stamped under
  // any of our historical handle variants (override / roster / email-local-
  // part) or a linked account still files as ours. See domain/identity.ts.
  // Cloud sign-in state, hoisted above selfKeys because a signed-in Aura
  // account is one of the identity's "me" sources. The refresh effect that
  // fills these lives with the sign-in banner further down.
  const [cloudConnected, setCloudConnected] = useState<boolean | null>(null);
  const [cloudUser, setCloudUser] = useState<string | null>(null);
  // The whole sign-in status, not just the two fields above: matching the
  // account to a roster seat needs its `cloud_url` to derive the account's
  // no-reply address, and that match is one of the few things that counts
  // as proof a team identity is actually this user's.
  const [cloudAccount, setCloudAccount] = useState<CloudAuthStatus | null>(
    null,
  );

  const selfKeys: SelfKeys = useMemo(
    () =>
      buildSelfKeys({
        effectiveHandle: identity?.effective_handle,
        handle: identity?.handle,
        email: identity?.email,
        deviceDisplay: myDevice?.display,
        deviceEmail: myDevice?.email,
        auraAlias,
        accountLogin: identity?.account_login,
        auraAccount: cloudUser,
        alsoHandles: alsoLinks.handles,
        alsoEmails: alsoLinks.emails,
      }),
    [
      identity?.effective_handle,
      identity?.handle,
      identity?.email,
      myDevice?.display,
      myDevice?.email,
      auraAlias,
      identity?.account_login,
      cloudUser,
      alsoLinks,
    ],
  );
  const members = manifest?.members ?? NO_MEMBERS;

  // Always-on voice rooms: derive a `channel slug -> members` index from
  // `members[].voice_channel`, which the presence beacon already carries.
  // No extra polling, no LiveKit API call — every channel-row chip and
  // the channel-header roster read off the same map. Recomputed only
  // when the manifest changes; with O(team-size) members this is cheap.
  const voiceByChannel = useMemo(() => {
    const out: Record<string, TeamMember[]> = {};
    for (const m of members) {
      const ch = m.voice_channel?.trim();
      if (!ch) continue;
      (out[ch] ??= []).push(m);
    }
    return out;
  }, [members]);

  // "Am I in voice on channel X right now" — derived directly from the
  // callStore snapshot (single source of truth). Falls back to scanning
  // `members[].voice_channel` for our own handle so a reload picks up
  // an existing cloud-beacon session before LiveKit reconnects.
  //
  // Previously this was a local useState updated by an `aura:huddle-state`
  // listener. That caused a "ghost Leave button" bug where the dock-panel
  // and StatusBar Leave paths bypassed the state-clear callback wired
  // through VoiceRoster, so `localVoiceChannel` stuck `true` until app
  // restart. Deriving from callStore guarantees ALL leave paths converge.
  const callSnap = useCallSnapshot();
  const myVoiceChannel = useMemo(() => {
    if (callSnap.active && callSnap.repoRoot === repoRoot) {
      return callSnap.channel;
    }
    const mine = members.find(
      (m) => m.handle === selfHandle && m.voice_channel,
    );
    return mine?.voice_channel ?? null;
  }, [
    callSnap.active,
    callSnap.repoRoot,
    callSnap.channel,
    members,
    selfHandle,
    repoRoot,
  ]);

  // Mention-watch — record which message ids we've already notified on
  // so we don't double-toast across polls.
  const notifiedMsgIds = useRef<Set<string>>(new Set());
  const firstChatPoll = useRef(true);

  // ── width observer for one-column collapse ────────────────────────
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPanelW(e.contentRect.width);
    });
    ro.observe(el);
    setPanelW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  // Tiered breakpoints:
  //   < 520  → one-column (rail OR active view)
  //   ≥ 520  → two-column (rail + center)
  // Members are no longer a third fixed column — they slide over the
  // stream as a 220-px peek (see showMembersRail / the absolute aside
  // below), so the center column keeps full width at every size and the
  // old 760 three-column gate is gone.
  const wide = panelW >= 520;
  // Below 640, narrow the left rail to give the chat column more room
  // while still keeping the rail readable for channel/DM names.
  const railWidth = panelW < 640 ? 208 : 248;

  // ── cross-repo reset (JJ.3, #328) ─────────────────────────────────
  // When the top-left repo picker switches the active project,
  // CommsPanel re-renders with a fresh `repoRoot` prop. The WS effect
  // and channel polls already key off `repoRoot`, but a lot of the
  // local state is keyed by convId (`ch:general`, `dm:alice`, …) which
  // collides across repos — both repos have a `general`. Without an
  // explicit reset, the new repo's surface inherits the previous
  // repo's messages, typing peers, read cursors, pinned ids,
  // mention-notify dedup, and active-channel selection. This effect
  // burns the per-repo client state cleanly on every switch.
  //
  // Note: `lastRead` is read from localStorage on mount and persists
  // there anyway — we leave it alone so a "new messages" badge survives
  // a repo bounce. `manifest`/`identity` are reloaded by `loadTeam`'s
  // own repoRoot dependency below, so we only have to clear the
  // derived/in-memory caches here.
  const prevRepoRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRepoRef.current;
    prevRepoRef.current = repoRoot;
    if (prev === null || prev === repoRoot) return;
    setMsgs(loadCachedAllForRepo<Msg>(repoRoot));
    setActiveId(null);
    setActiveThread(null);
    setTypingPeers({});
    setReadCursors({});
    setPinnedByConv({});
    setChannelTab({});
    // Seed from the target repo's cached roster rather than blanking — a repo
    // switch should paint that repo's last-known members immediately, not an
    // empty rail that fills a round-trip later. loadTeam (below) revalidates.
    setManifest(peekCache<TeamManifest>(`team:manifest:${repoRoot}`) ?? null);
    setIdentity(peekCache<TeamIdentity>(`team:identity:${repoRoot}`) ?? null);
    notifiedMsgIds.current = new Set();
    firstChatPoll.current = true;
    emittedCursorRef.current = {};
  }, [repoRoot]);

  // ── manifest commit helpers (stale-while-revalidate, never-blank) ──
  // Every roster update funnels through here so (a) a null / failed read can
  // never blank the members list, (b) a transient EMPTY roster can't wipe a
  // populated one — the two causes of the "members load and disappear all the
  // time" flicker — and (c) the process-lifetime cache stays warm for instant
  // repaints on remount / repo-switch.
  const applyManifest = useCallback(
    (next: TeamManifest | null | undefined) => {
      if (!next) return; // a failed poll must keep the last-known roster
      setManifest((prev) => {
        // Don't let a momentarily-empty roster replace a populated one — that
        // intermediate empty frame is the flicker. A genuinely empty team
        // (prev also empty) still applies normally.
        if ((next.members?.length ?? 0) === 0 && (prev?.members?.length ?? 0) > 0) {
          return prev;
        }
        try {
          writeCache(`team:manifest:${repoRoot}`, next);
        } catch {
          /* cache is best-effort */
        }
        return next;
      });
    },
    [repoRoot],
  );
  const applyIdentity = useCallback(
    (next: TeamIdentity | null | undefined) => {
      if (!next) return;
      try {
        writeCache(`team:identity:${repoRoot}`, next);
      } catch {
        /* cache is best-effort */
      }
      setIdentity(next);
    },
    [repoRoot],
  );

  // ── identity + manifest load ──────────────────────────────────────
  const loadTeam = useCallback(async () => {
    let base: TeamManifest;
    try {
      const [id, man] = await Promise.all([
        fetchIdentity(repoRoot),
        refreshTeam(repoRoot),
      ]);
      applyIdentity(id);
      base = man;
    } catch {
      /* repo without git — keep the last-known roster, never blank */
      return;
    }
    // Best-effort: fold in GitHub collaborators with edit rights so people
    // who *can* contribute appear before their first commit. Throttled in
    // the backend (5 min), so it's cheap to call on every refresh; it
    // returns the full manifest — including the synthetic collaborator
    // rows and any alias it learned for the local user — which supersedes
    // the team_load result. Degrades silently off GitHub / without `gh`.
    //
    // Crucially this resolves to a SINGLE manifest commit per poll. The old
    // code set the git-only roster first and then the enriched roster a
    // round-trip later, so every 15s tick the members list visibly shrank
    // (git roster) then grew (with collaborators) — the reported flicker.
    let full = base;
    try {
      full = await api.teamSyncCollaborators(repoRoot);
    } catch {
      /* not a GitHub repo or gh unavailable — keep the git roster */
    }
    applyManifest(full);
    // Recompute duplicate suggestions off the freshest roster. Best-effort —
    // an empty list just hides the banner.
    try {
      setDupSuggestions(await api.teamIdentitySuggestDuplicates(repoRoot));
    } catch {
      setDupSuggestions([]);
    }
  }, [repoRoot, applyManifest, applyIdentity]);

  // Confirm a duplicate suggestion: merge the group into the survivor, then
  // refresh the roster + suggestions so the banner reflects the collapse.
  const confirmDuplicate = useCallback(
    async (survivorEmail: string, mergedEmails: string[]) => {
      const next = await api.teamIdentityConfirmDuplicate(
        repoRoot,
        survivorEmail,
        mergedEmails,
      );
      applyManifest(next);
      try {
        setDupSuggestions(await api.teamIdentitySuggestDuplicates(repoRoot));
      } catch {
        setDupSuggestions([]);
      }
    },
    [repoRoot],
  );

  // Reject a duplicate suggestion: record the pair as different people so it is
  // never suggested again, then refresh the banner.
  const rejectDuplicate = useCallback(
    async (emailA: string, emailB: string) => {
      const next = await api.teamIdentityRejectDuplicate(
        repoRoot,
        emailA,
        emailB,
      );
      applyManifest(next);
      try {
        setDupSuggestions(await api.teamIdentitySuggestDuplicates(repoRoot));
      } catch {
        setDupSuggestions([]);
      }
    },
    [repoRoot],
  );

  useEffect(() => {
    loadTeam();
    // Refetch immediately when identity changes (per-repo override set/cleared
    // or an alias added) so selfHandle picks up the new effective handle and
    // the self-echo dedup keeps working.
    const onIdentityChanged = () => {
      loadTeam();
    };
    window.addEventListener("aura:identity-updated", onIdentityChanged);
    if (!visible) {
      return () => window.removeEventListener("aura:identity-updated", onIdentityChanged);
    }
    // Re-sync periodically so new git committers appear without an app
    // restart. team_load calls sync_with_git, which re-runs `git log`
    // and merges any newly-seen authors into team.json.
    const id = window.setInterval(loadTeam, 15000);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("aura:identity-updated", onIdentityChanged);
    };
  }, [loadTeam, visible]);

  // Pull device identity once — used as the reactions/typing attribution
  // key. Fails open (myDevice stays null) so missing identity just
  // disables reactions instead of breaking the whole panel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ident = await api.deviceIdentity();
        if (cancelled) return;
        setMyDevice({
          device_id: ident.device_id,
          display: ident.display_name || ident.device_id,
          email: ident.email || "",
        });
      } catch {
        /* identity unreachable — reactions toggle stays disabled */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── cloud sign-in banner (kept) ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await api.cloudAuthStatus();
        if (!cancelled) {
          setCloudConnected(s.connected);
          setCloudUser(s.connected ? s.user ?? null : null);
          setCloudAccount(s.connected ? s : null);
        }
      } catch {
        if (!cancelled) {
          setCloudConnected(false);
          setCloudUser(null);
          setCloudAccount(null);
        }
      }
    };
    refresh();
    const onChange = () => refresh();
    window.addEventListener("aura:cloud-auth-changed", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("aura:cloud-auth-changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, []);

  // ── identity banner + first-send picker (II.9) ────────────────────
  // `doctorReport` is the lightweight cached snapshot of `chat_doctor`
  // we re-poll on identity events. It powers BOTH the inline yellow
  // banner ("Your git email isn't on the roster") and the seed payload
  // for `IdentityChoiceDialog`. We refetch on identity change and on
  // repo switch — never on every render. Polling on a long interval
  // would also work but identity edits are rare; the event-driven
  // refresh keeps the rail snappy.
  const [doctorReport, setDoctorReport] = useState<ChatDoctorReport | null>(null);
  const [identityPickerOpen, setIdentityPickerOpen] = useState(false);
  /** Gates the full-screen CreateChannelWizard (replaces the old
   *  window.prompt/window.confirm rail flow). */
  const [creatingChannel, setCreatingChannel] = useState(false);
  /** Repos where we've already prompted the user this session. Prevents
   *  the dialog from re-appearing on every send within the same repo;
   *  switching repos resets the trigger so the per-repo guarantee from
   *  the spec holds ("Switch repos → IdentityChoiceDialog re-appears"). */
  const promptedReposRef = useRef<Set<string>>(new Set());
  const refreshDoctor = useCallback(async () => {
    if (!repoRoot) return;
    try {
      const r = await api.chatDoctor(repoRoot);
      setDoctorReport(r);
    } catch {
      setDoctorReport(null);
    }
  }, [repoRoot]);
  useEffect(() => {
    refreshDoctor();
    const onIdentityChange = () => {
      refreshDoctor();
    };
    window.addEventListener("aura:identity-updated", onIdentityChange);
    return () =>
      window.removeEventListener("aura:identity-updated", onIdentityChange);
  }, [refreshDoctor]);
  // Repo switch — reset the per-repo "already prompted" guard so the
  // dialog re-appears on the next send in the new repo.
  useEffect(() => {
    promptedReposRef.current.delete(repoRoot);
  }, [repoRoot]);

  /** What the identity notice should offer, or `null` for "nothing the
   *  user can legitimately act on".
   *
   *  This used to raise the banner whenever ANY roster member was
   *  `claimed`. The roster is committed into the repo and rebuilt from
   *  `git log`, so a claimed member is present on every clone — including
   *  one made by somebody with no connection to that team. That turned
   *  "somebody, somewhere, claimed a seat" into a prompt telling a
   *  stranger their identity needed attention, and then offered them
   *  that person's name. The gate now asks whether THIS machine has
   *  evidence of an identity of its own to switch to, or no git identity
   *  at all — the two cases where there is something real to do. */
  const identityBannerKindValue = useMemo(() => {
    if (!doctorReport) return null;
    return identityBannerKind({
      report: doctorReport,
      manifest,
      account: cloudAccount,
    });
  }, [doctorReport, manifest, cloudAccount]);
  const identityBannerVisible = identityBannerKindValue !== null;

  // ── built-in / custom channel split ───────────────────────────────
  const builtins = useMemo<Conversation[]>(() => {
    const slugs = manifest?.channels ?? ["general", "agents", "sentinel"];
    const metaBySlug = new Map(
      (manifest?.channel_meta ?? []).map((m) => [m.slug, m]),
    );
    const fromManifest = slugs
      .filter((c) => BUILTIN_CHANNELS.has(c) && c !== AURA_GLOBAL_CHANNEL)
      .map((c): Conversation => {
        if (c === "sentinel") {
          return {
            id: "sentinel",
            name: "sentinel",
            kind: "system",
            channel: undefined,
            pinned: true,
            builtIn: true,
            hint: "agent presence + cross-agent inbox",
          };
        }
        return {
          id: `ch:${c}`,
          name: c,
          kind: "channel",
          channel: c,
          pinned: true,
          builtIn: true,
          hint:
            c === "general"
              ? "team chatter"
              : c === "agents"
                ? "agent activity"
                : "",
          tabs: metaBySlug.get(c)?.tabs,
        };
      });
    // Always append the cross-repo `#aura` channel last so it sits
    // below the per-repo channels but is never absent — independent
    // of whatever the per-repo manifest contains.
    const auraConv: Conversation = {
      id: `ch:${AURA_GLOBAL_CHANNEL}`,
      name: AURA_GLOBAL_CHANNEL,
      kind: "channel",
      channel: AURA_GLOBAL_CHANNEL,
      pinned: true,
      builtIn: true,
      hint: "everyone on Aura",
    };
    return [...fromManifest, auraConv];
  }, [manifest]);

  const customs = useMemo<Conversation[]>(() => {
    const slugs = manifest?.channels ?? [];
    const metaBySlug = new Map(
      (manifest?.channel_meta ?? []).map((m) => [m.slug, m]),
    );
    const myEmail = (identity?.email ?? "").toLowerCase();
    const iAmAdmin = identity?.admin ?? false;
    // Advisory visibility gate: a private channel only appears in the
    // rail (and only gets background-polled, since the poll set derives
    // from this list) for its members and team admins. Open channels and
    // those with no meta are visible to everyone, as before.
    const canSee = (slug: string): boolean => {
      const meta = metaBySlug.get(slug);
      if (!meta || meta.visibility !== "private") return true;
      if (iAmAdmin) return true;
      return (meta.members ?? []).some((e) => e.toLowerCase() === myEmail);
    };
    return slugs
      .filter((c) => !BUILTIN_CHANNELS.has(c))
      .filter(canSee)
      .map((c): Conversation => {
        const meta = metaBySlug.get(c);
        return {
          id: `ch:${c}`,
          name: c,
          kind: "custom",
          channel: c,
          builtIn: false,
          hint: meta?.topic ?? "",
          private: (meta?.visibility ?? "open") === "private",
          tabs: meta?.tabs,
        };
      });
  }, [manifest, identity]);

  // Project pseudo-conversation (intents/snapshots/commits feed).
  const projectConv: Conversation = useMemo(
    () => ({
      id: "project",
      name: projectName,
      kind: "project",
      pinned: true,
      builtIn: true,
      hint: "intents · snapshots · commits",
    }),
    [projectName],
  );

  // ── peers (DMs to teammates) ──────────────────────────────────────
  // Includes a synthetic "Me" entry at the top so the user has a
  // personal-notes channel they can DM themselves on (apple-notes
  // style scratch pad, end-to-end the same chat substrate so it
  // syncs across their own machines via the room WS).
  const peers = useMemo<Conversation[]>(() => {
    const selfNote: Conversation | null = selfHandle
      ? {
          // Conv ids are keyed by the normalized handle so they match the
          // `dm:<norm(...)>` buckets loadChatChannel / convIdForMessage write
          // to — otherwise a handle with any uppercase would route messages to
          // a key the conversation list never looks up, and the DM would read
          // empty. Normalize once here; everything downstream inherits it.
          id: `dm:${norm(selfHandle)}`,
          name: "Me",
          handle: selfHandle,
          kind: "dm",
          channel: `dm-self-${selfHandle}`,
          hint: "personal notes",
          pinned: true,
        }
      : null;
    const others = members
      .filter((m) => m.handle && m.handle !== selfHandle)
      // A DM goes to a person. Aura's own agent commits as ai@aura.vcs and the
      // checkpointer as checkpointer@noreply, so both arrived here off the git
      // roster and sat in "Direct Messages" as people you could write to —
      // nothing reads those rooms. Agents have their own surfaces: the #aura
      // channel, the sentinel inbox, and the chat beside their terminal.
      .filter((m) => !isAutomationIdentity(m.name, m.email))
      // Drop the user's OWN linked seats — a second GitHub login etc. reads
      // as "me", so it belongs under the self note, not as a separate DM
      // target. The seat still exists in the roster; it's just not a peer.
      .filter(
        (m) =>
          !isLinkedSelf(
            {
              email: m.email,
              handle: m.handle,
              githubLogin: m.github_login,
              alsoEmails: m.also_emails,
            },
            selfLinks,
          ),
      )
      .map(
        // Lead with the person's name and keep the handle as the hint. It used
        // to be the other way round, so the DM list read as a column of git
        // logins — `mhdashiquek`, `mo`, `dev` — and you had to know which login
        // belonged to which colleague to find anyone. The handle still shows,
        // one line down, which is also what tells two same-named seats apart.
        (m): Conversation => ({
          id: `dm:${norm(m.handle)}`,
          name: m.name?.trim() || m.handle,
          handle: m.handle,
          kind: "dm",
          channel: dmChannel(selfHandle, m.handle),
          hint: m.name?.trim() ? m.handle : "",
          lastTs: m.last_seen || undefined,
        }),
      );
    return selfNote ? [selfNote, ...others] : others;
  }, [members, selfHandle, selfLinks]);

  // ── project feed (intents + commits) ──────────────────────────────
  // Intents are read via `auraIntentRecent` (not the raw log): it carries the
  // session ids + developer attribution the grouper needs, and already drops
  // auto-capture/tool-noise rows. `intentRowsToSessionMsgs` clusters them into
  // one readable message per session, with each session's later intents hung
  // off it as thread replies — so the channel reads as a team's live story,
  // not an "aura INTENT" firehose. Commits stay as their own activity rows.
  const loadProjectFeed = useCallback(() => {
    // A failed read resolves to `[]` so the other source still renders — but
    // that empty must never reach state, or the 10s tick would blank a
    // populated feed the moment the intent log or `git log` hiccups. Same
    // never-blank rule the roster helpers follow.
    let failed = false;
    Promise.all([
      fetchIntentRows(repoRoot, 200).catch(() => {
        failed = true;
        return [] as IntentRow[];
      }),
      api.gitRecentCommits(repoRoot, 50).catch(() => {
        failed = true;
        return [] as CommitEntry[];
      }),
    ]).then(([intents, commits]) => {
      if (failed) return;
      const merged: Msg[] = [
        ...intentRowsToSessionMsgs(intents),
        ...commits.map(commitToMsg),
      ].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      setMsgs((prev) => {
        // Nothing new since the last tick is the common case, and handing back
        // a fresh array for identical rows re-renders the whole Team tree every
        // 10s for no reason.
        if (sameFeed(prev.project, merged)) return prev;
        return { ...prev, project: merged };
      });
    });
  }, [repoRoot]);

  useEffect(() => {
    loadProjectFeed();
    if (!visible) return;
    const id = window.setInterval(loadProjectFeed, 10000);
    return () => window.clearInterval(id);
  }, [loadProjectFeed, visible]);

  // ── sentinel inbox ────────────────────────────────────────────────
  const loadSentinelFeed = useCallback(() => {
    api
      .sentinelInbox(repoRoot)
      .then((items: SentinelMessage[]) => {
        const sorted = [...items].sort(
          (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
        );
        const next = sorted.map(sentinelToMsg);
        // Agent inboxes are quiet for long stretches; without this the 5s tick
        // hands back a new array of identical rows and cascades a re-render
        // through every consumer of the model.
        setMsgs((prev) =>
          sameFeed(prev.sentinel, next) ? prev : { ...prev, sentinel: next },
        );
      })
      .catch(() => {
        /* sentinel dir not yet created — keep the last-known feed */
      });
  }, [repoRoot]);

  useEffect(() => {
    loadSentinelFeed();
    if (!visible) return;
    const id = window.setInterval(loadSentinelFeed, 5000);
    return () => window.clearInterval(id);
  }, [loadSentinelFeed, visible]);

  // ── chat channels poll (general, agents, custom, DMs) ─────────────
  const chatBackgroundChannels = useMemo(() => {
    const channels = new Set<string>();
    builtins.forEach((b) => {
      if (b.channel) channels.add(b.channel);
    });
    customs.forEach((b) => {
      if (b.channel) channels.add(b.channel);
    });
    peers.forEach((p) => {
      if (p.channel) channels.add(p.channel);
    });
    return Array.from(channels);
  }, [builtins, customs, peers]);

  const loadChatChannel = useCallback(
    async (channel: string) => {
      try {
        const list = await api.chatList(repoRoot, channel, undefined, 500);
        // The bucket this channel's OWN traffic (mine + the real peer's)
        // belongs to. For a DM that's `dm:<peer>`; for a channel `ch:<slug>`.
        const convId = channel.startsWith("dm-")
          ? `dm:${norm(dmOtherSide(channel, selfHandle))}`
          : `ch:${channel}`;
        // Route every row by its real SENDER, not the channel slug. The whole
        // team shares one room, so a malformed/stale/colliding DM slug would
        // otherwise drop a third party's message into an unrelated 1:1 (the
        // "I see shahabas inside my DM with ijas" bug). A message from person
        // X belongs in the DM with person X — strangers split off into their
        // own bucket and never pollute this conversation. See convIdForMessage.
        const byConv = new Map<string, Msg[]>();
        for (const cm of list) {
          const m = chatToMsg(cm, selfKeys, myDevice?.device_id ?? null);
          const cid = convIdForMessage(channel, m, selfHandle);
          const bucket = byConv.get(cid);
          if (bucket) bucket.push(m);
          else byConv.set(cid, [m]);
        }
        const fetched: Msg[] = byConv.get(convId) ?? [];
        // Merge-not-replace: dedup by id and preserve any optimistic
        // "pending" delivery_status the outbox poll hasn't reconciled
        // yet. Replacing the list outright caused the "flicker"
        // (inward messages disappear + reappear) and triggered
        // duplicate-render races against the WS echo path.
        setMsgs((prev) => {
          const existing = prev[convId] ?? [];
          const byId = new Map<string, Msg>();
          for (const m of fetched) byId.set(m.id, m);
          // Stale-twin guard. A cached row whose id the fresh fetch no longer
          // carries, but whose (body, ts±window) still matches a fetched row,
          // is the SAME logical message under a now-defunct id — an optimistic
          // self row the cloud re-id'd, or a foreign row whose id changed
          // underneath the cache (a cloud re-id, or a local re-write of the
          // channel file). Left in, it renders a second bubble beside its
          // current-id self — the "teammate's message shows twice" duplicate.
          // Self rows match on `fromMe` (the sender label can differ across
          // handle layers); everyone else must ALSO match the sender label, so
          // two different people sending identical text within the window are
          // never collapsed into one. A genuinely current message is always in
          // the fetch by id, so this only ever removes true orphans — never a
          // live row, and never a pending optimistic send that has no twin yet.
          const twinInFetch = (row: Msg): boolean =>
            fetched.some(
              (f) =>
                f.id !== row.id &&
                f.body.trim() === row.body.trim() &&
                Math.abs(f.ts - row.ts) <= 300 &&
                (row.fromMe ? f.fromMe : f.sender === row.sender),
            );
          // Keep optimistic-pending entries that the server snapshot
          // hasn't yet acknowledged (id present locally, absent server-side).
          for (const m of existing) {
            // Self-heal: a stranger row an older (slug-routed) build mis-filed
            // into this DM no longer belongs here — it now lives in its own
            // conversation with that sender. Drop it on the next poll so the
            // bleed visibly clears without a restart.
            if (convIdForMessage(channel, m, selfHandle) !== convId) continue;
            if (!byId.has(m.id)) {
              // Drop a stale-id twin the fetch already represents under its
              // canonical id; keep everything else (pending sends, local-only
              // rows) verbatim.
              if (twinInFetch(m)) continue;
              byId.set(m.id, m);
            } else if (m.delivery_status === "pending") {
              // Server has the row; let the outbox poll flip it.
              byId.set(m.id, { ...byId.get(m.id)!, delivery_status: "pending" });
            }
          }
          const merged = Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
          // Skip the state update if the merge is byte-identical to the
          // previous list — saves a render and keeps the bubble layout
          // from flashing on every 30s tick.
          if (
            merged.length === existing.length &&
            merged.every((m, i) => m.id === existing[i].id && m.body === existing[i].body)
          ) {
            return prev;
          }
          // Persist the merged list so a future boot can paint this
          // conversation synchronously instead of staring at an empty
          // bubble list until the chatList round-trip resolves.
          saveCachedMsgs(repoRoot, convId, merged);
          return { ...prev, [convId]: merged };
        });
        // Re-home any rows that belong to a different conversation than this
        // channel's slug (a stranger whose message leaked into this DM's
        // slug). Each lands in its own `dm:<sender>` bucket so the user sees
        // it where it belongs instead of inside the wrong 1:1.
        for (const [cid, rows] of byConv) {
          if (cid === convId) continue;
          setMsgs((prev) => {
            const existing = prev[cid] ?? [];
            const byId = new Map<string, Msg>();
            for (const m of existing) byId.set(m.id, m);
            let changed = false;
            for (const m of rows) {
              if (!byId.has(m.id)) {
                byId.set(m.id, m);
                changed = true;
              }
            }
            if (!changed) return prev;
            const merged = Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
            saveCachedMsgs(repoRoot, cid, merged);
            return { ...prev, [cid]: merged };
          });
        }
        // Mention notify: first poll is silent (just hydrating); after that,
        // any new message mentioning me triggers the bridge below.
        if (!firstChatPoll.current && selfHandle) {
          for (const m of list) {
            if (notifiedMsgIds.current.has(m.id)) continue;
            rememberNotified(notifiedMsgIds.current, m.id);
            if (m.from_handle === selfHandle) continue;
            if (m.mentions.includes(selfHandle)) {
              window.dispatchEvent(
                new CustomEvent("aura:chat-mention", {
                  detail: { from: m.from_handle, body: m.body, channel },
                }),
              );
            }
          }
        } else {
          list.forEach((m) => rememberNotified(notifiedMsgIds.current, m.id));
        }
      } catch {
        /* channel may be empty / new */
      }
    },
    [repoRoot, selfHandle, selfKeys],
  );

  // Initial HTTP backfill (one round per known channel) so any history
  // before the WS opened is rendered. The WS is the live channel after
  // that — see the room socket effect below. We keep a 30s safety-net
  // poll for hidden tabs / closed sockets so messages never go missing
  // if a proxy kills the WS.
  useEffect(() => {
    if (chatBackgroundChannels.length === 0) return;
    let cancelled = false;
    // Fan the round out instead of walking it. These reads are independent
    // per channel, so serialising them made the whole safety-net poll cost the
    // SUM of every channel's round-trip — on a team with a DM per member that
    // is dozens of sequential hops, and the last channel in the list stayed
    // stale for the length of all the ones before it.
    const tick = async () => {
      if (cancelled) return;
      await Promise.all(chatBackgroundChannels.map((ch) => loadChatChannel(ch)));
      // Only arm mention toasts if this round actually finished for us — a
      // repo switch mid-flight leaves the flag for the next effect to own.
      if (!cancelled) firstChatPoll.current = false;
    };
    tick();
    if (!visible) return () => { cancelled = true; };
    const id = window.setInterval(tick, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [chatBackgroundChannels, loadChatChannel, visible]);

  // ── room WebSocket (loginless realtime fan-out) ───────────────────
  const wsHandlerRef = useRef<((msg: ChatMessage, channel: string) => void) | null>(null);
  useEffect(() => {
    wsHandlerRef.current = (m: ChatMessage, channel: string) => {
      const incoming = chatToMsg(m, selfKeys, myDevice?.device_id ?? null);
      // Route by the real sender, not the channel slug — a DM from person X
      // belongs in the DM with person X even if the slug is malformed or
      // collides (the "third party shows up inside my 1:1" bug). See
      // convIdForMessage.
      const convId = convIdForMessage(channel, incoming, selfHandle);
      setMsgs((prev) => {
        const existing = prev[convId] ?? [];
        const sameIdIdx = existing.findIndex((x) => x.id === incoming.id);
        if (sameIdIdx >= 0) {
          // Existing row — backfill cloud-assigned `seq` if the local
          // optimistic copy lacked it. Without this the read-cursor
          // anchor math can't find our own messages.
          if (
            typeof incoming.seq === "number" &&
            existing[sameIdIdx].seq !== incoming.seq
          ) {
            const next = [...existing];
            next[sameIdIdx] = { ...next[sameIdIdx], seq: incoming.seq };
            saveCachedMsgs(repoRoot, convId, next);
            return { ...prev, [convId]: next };
          }
          return prev;
        }
        // Self-echo dedup. We can NOT gate on `m.from_handle === selfHandle`
        // because the cloud broadcast carries whichever handle layer
        // `resolve_handle` stamped (email-local-part vs roster alias vs
        // override) — those diverge from `selfHandle` and from each other.
        //
        // Worse, that stamped handle is often my email-local-part, which —
        // during the brief window before `identity` (and thus `selfKeys`)
        // hydrates — isn't yet a confirmed self-key, so `incoming.fromMe`
        // reads FALSE at receive time and the echo slips through as a SECOND
        // bubble beside my optimistic row. Later, once identity loads, Bubble
        // re-derives `fromMe` and BOTH rows render as "me" → the "my message
        // shows twice, both tagged you" bug.
        //
        // Fix: don't depend on the echo being classified mine at receive time.
        // Also collapse when the incoming row lines up (body + ts) with a
        // still-PENDING optimistic row I authored — that row is unconditionally
        // mine regardless of hydration. A FOREIGN device id on the incoming row
        // vetoes this path, so a teammate who happens to send identical text is
        // never swallowed into my outgoing bubble. The cloud id is patched into
        // the local row so reactions / read-cursors keyed off it still resolve.
        // Window is 5min so a slow broadcast or a brief socket bounce that
        // re-delivers history still matches.
        const incomingForeignDevice =
          !!incoming.senderDeviceId &&
          !!myDevice?.device_id &&
          norm(incoming.senderDeviceId) !== norm(myDevice.device_id);
        const echoIdx =
          incoming.fromMe || !incomingForeignDevice
            ? existing.findIndex(
                (x) =>
                  x.fromMe &&
                  x.body.trim() === incoming.body.trim() &&
                  Math.abs(x.ts - incoming.ts) <= 300 &&
                  // Don't collapse into a row we've already reconciled to a
                  // cloud id, so two identical messages sent in quick
                  // succession each keep their own bubble.
                  x.id !== incoming.id &&
                  // When identity hasn't yet classified the echo as mine, only
                  // a genuinely pending optimistic row may absorb it — never a
                  // settled historical row — so identical texts sent long apart
                  // don't retro-collapse.
                  (incoming.fromMe || x.delivery_status === "pending"),
              )
            : -1;
        if (echoIdx >= 0) {
          const next = [...existing];
          next[echoIdx] = {
            ...next[echoIdx],
            id: incoming.id,
            seq:
              typeof incoming.seq === "number"
                ? incoming.seq
                : next[echoIdx].seq,
          };
          saveCachedMsgs(repoRoot, convId, next);
          return { ...prev, [convId]: next };
        }
        const merged = [...existing, incoming].sort((a, b) => a.ts - b.ts);
        saveCachedMsgs(repoRoot, convId, merged);
        return { ...prev, [convId]: merged };
      });
      if (!notifiedMsgIds.current.has(m.id)) {
        rememberNotified(notifiedMsgIds.current, m.id);
        if (
          m.from_handle !== selfHandle &&
          selfHandle &&
          m.mentions.includes(selfHandle)
        ) {
          window.dispatchEvent(
            new CustomEvent("aura:chat-mention", {
              detail: { from: m.from_handle, body: m.body, channel },
            }),
          );
        }
      }
    };
  }, [selfHandle, selfKeys, myDevice?.device_id]);

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let attempt = 0;

    const connect = async () => {
      if (cancelled) return;
      let roomId: string;
      try {
        roomId = await api.deviceRoomId(repoRoot);
      } catch {
        return;
      }
      if (cancelled) return;
      const origin = "wss://auravcs.com";
      // Attach the cloud bearer as ?token= so the server can enforce room
      // membership once AURA_ROOMS_REQUIRE_AUTH is on. Empty when signed out.
      const tok = await roomTokenParam();
      const url = `${origin}/api/v1/room/${encodeURIComponent(roomId)}/ws${
        tok ? `?${tok}` : ""
      }`;
      // Reactions snapshot — pulled before the WS opens so chips render
      // on first paint. We don't block the socket on this; a slow CDN
      // shouldn't keep the chat WS from coming up.
      void (async () => {
        try {
          const res = await fetch(
            `https://auravcs.com/api/v1/room/${encodeURIComponent(roomId)}/reactions`,
            { headers: await roomAuthHeaders() },
          );
          if (!res.ok) return;
          const j = (await res.json()) as { reactions?: ReactionRow[] };
          if (j.reactions?.length) reactionsStore.applySnapshot(j.reactions);
        } catch {
          /* offline / blocked — chips will populate live as new reactions arrive */
        }
      })();
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const frame = JSON.parse(ev.data);
          // Ephemeral typing pulse fanned out by the room hub — see
          // `RoomFrame::Typing` in aura-cloud rooms.rs.
          if (frame.kind === "typing") {
            window.dispatchEvent(
              new CustomEvent("aura:chat-typing", {
                detail: {
                  channel: frame.channel,
                  device_id: frame.device_id,
                  display: frame.display,
                  expires_at: frame.expires_at,
                },
              }),
            );
            return;
          }
          if (frame.kind === "reaction") {
            // Authoritative reaction event from the room hub. Update the
            // shared store; subscribed Bubbles will re-render their chip
            // strip for this msg_id only.
            reactionsStore.applyServer(
              String(frame.msg_id),
              String(frame.emoji),
              String(frame.device_id),
              !!frame.added,
            );
            return;
          }
          if (frame.kind === "read_cursor_update") {
            // Peer advanced their read cursor. Stash via the shared event
            // bus so the read-cursor reducer below (which owns the per-
            // conv map) picks it up without us reaching across closures.
            window.dispatchEvent(
              new CustomEvent("aura:chat-read-cursor", {
                detail: {
                  kind: "update",
                  channel: String(frame.channel ?? "general"),
                  device_id: String(frame.device_id ?? ""),
                  display: String(frame.display ?? ""),
                  last_read_seq: Number(frame.last_read_seq ?? 0),
                  last_read_at: String(frame.last_read_at ?? ""),
                },
              }),
            );
            return;
          }
          if (frame.kind === "cursors_snapshot" && Array.isArray(frame.cursors)) {
            window.dispatchEvent(
              new CustomEvent("aura:chat-read-cursor", {
                detail: { kind: "snapshot", cursors: frame.cursors },
              }),
            );
            return;
          }
          if (frame.kind !== "msg" || !frame.message) return;
          const m = frame.message as {
            id: string;
            channel: string;
            sender_device_id: string;
            sender_display: string;
            sender_email?: string;
            body: string;
            mentions?: string[];
            thread_parent?: string | null;
            is_agent?: boolean;
            created_at: string;
            seq?: number;
          };
          const ts = Math.floor(new Date(m.created_at).getTime() / 1000) || 0;
          // Never collapse onto the display NAME: two seats sharing a name
          // ("Ashiq" on two accounts) must not merge into one handle/bucket.
          // senderHandle falls back to a device-scoped token instead. The
          // reader still sees `from_name` (sender_display) below.
          const handle = senderHandle(m.sender_email, m.sender_device_id, m.sender_display);
          const synthetic: ChatMessage & { seq?: number } = {
            id: m.id,
            channel: m.channel,
            ts,
            from_handle: handle,
            from_name: m.sender_display,
            body: m.body,
            mentions: m.mentions ?? [],
            thread_parent: m.thread_parent ?? undefined,
            is_agent: !!m.is_agent,
            seq: typeof m.seq === "number" ? m.seq : undefined,
            from_device_id: m.sender_device_id || null,
          };
          wsHandlerRef.current?.(synthetic, m.channel);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        if (cancelled) return;
        scheduleReconnect();
      };
      socket.onerror = () => {
        // Let onclose handle the reconnect timer.
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect();

    // Outbound bridge: Composer dispatches `aura:ws-send` with a JSON-able
    // detail and we forward it down the live socket. Cheap escape hatch so
    // children don't need a socket prop.
    const sendHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify(detail));
      } catch {
        /* socket may have closed between checks; non-fatal */
      }
    };
    window.addEventListener("aura:ws-send", sendHandler);

    return () => {
      cancelled = true;
      window.removeEventListener("aura:ws-send", sendHandler);
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      try {
        socket?.close();
      } catch {
        /* noop */
      }
    };
  }, [repoRoot]);

  // ── #aura global channel WebSocket ────────────────────────────────
  //
  // Parallel subscription to the fixed `aura-global` cloud room so the
  // cross-repo Aura channel receives live messages regardless of which
  // repo the user has open. We keep this socket separate from the
  // per-repo one above so the room boundaries stay clean — typing,
  // reactions, and read-cursor frames stay scoped to the per-repo
  // socket; this one only forwards `message` frames as channel="aura"
  // into the shared wsHandlerRef. No reconnect backoff parity with
  // the main socket: a stale global feed degrades to "nothing live,
  // refresh on focus" rather than blocking the per-repo chat.
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let attempt = 0;

    const connect = async () => {
      if (cancelled) return;
      // The global commons room is login-gated (open to any signed-in user)
      // once the server flag is on — so it needs the bearer too.
      const tok = await roomTokenParam();
      if (cancelled) return;
      const url = `wss://auravcs.com/api/v1/room/${encodeURIComponent(
        AURA_GLOBAL_ROOM_ID,
      )}/ws${tok ? `?${tok}` : ""}`;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const frame = JSON.parse(ev.data);
          // Only `msg` frames matter for the global channel. Typing
          // / reactions / read-cursor are intentionally dropped here:
          // the cloud broadcasts them on this room too but we want
          // the global channel to be lightweight — body + sender only.
          // The cloud emits `RoomFrame::Msg { message }` (kind="msg") with
          // the payload NESTED under `frame.message` — same shape the
          // per-repo socket above parses. Reading `frame` directly (and
          // matching kind "message") silently dropped every Aura-channel
          // broadcast, so nobody but the sender ever saw those messages.
          if (frame.kind !== "msg" || !frame.message) return;
          const m = frame.message as {
            id: string;
            channel: string;
            body: string;
            sender_device_id?: string;
            sender_display: string;
            sender_email?: string;
            mentions?: string[];
            thread_parent?: string;
            is_agent?: boolean;
            created_at: string;
            seq?: number;
          };
          // Drop frames that aren't tagged for the aura channel — the
          // global room is dedicated to it today, but the server-side
          // shape could change.
          if (m.channel && m.channel !== AURA_GLOBAL_CHANNEL) return;
          const ts = m.created_at
            ? Math.floor(new Date(m.created_at).getTime() / 1000)
            : Math.floor(Date.now() / 1000);
          // Never collapse onto the display NAME: two seats sharing a name
          // ("Ashiq" on two accounts) must not merge into one handle/bucket.
          // senderHandle falls back to a device-scoped token instead. The
          // reader still sees `from_name` (sender_display) below.
          const handle = senderHandle(m.sender_email, m.sender_device_id, m.sender_display);
          const synthetic: ChatMessage & { seq?: number } = {
            id: m.id,
            channel: AURA_GLOBAL_CHANNEL,
            ts,
            from_handle: handle,
            from_name: m.sender_display,
            body: m.body,
            mentions: m.mentions ?? [],
            thread_parent: m.thread_parent ?? undefined,
            is_agent: !!m.is_agent,
            seq: typeof m.seq === "number" ? m.seq : undefined,
            from_device_id: m.sender_device_id || null,
          };
          wsHandlerRef.current?.(synthetic, AURA_GLOBAL_CHANNEL);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        if (cancelled) return;
        scheduleReconnect();
      };
      socket.onerror = () => {
        /* let onclose drive reconnect */
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      try {
        socket?.close();
      } catch {
        /* noop */
      }
    };
  }, []);

  // Typing pulse listener — peers' beacons fan in here.
  useEffect(() => {
    function onTyping(e: Event) {
      const d = (e as CustomEvent).detail as
        | { channel?: string; device_id?: string; display?: string; expires_at?: number }
        | undefined;
      if (!d?.channel || !d.device_id) return;
      // Filter out our own echo (cloud broadcasts to all subscribers).
      if (selfHandle && d.display && d.display.toLowerCase().replace(/[^a-z0-9_-]/g, "") === selfHandle) return;
      const key = `${d.channel}::${d.device_id}`;
      const expiresAt = d.expires_at && d.expires_at > 0
        ? d.expires_at
        : Math.floor(Date.now() / 1000) + 5;
      setTypingPeers((prev) => ({
        ...prev,
        [key]: { display: d.display ?? "Someone", expires_at: expiresAt, channel: d.channel! },
      }));
    }
    window.addEventListener("aura:chat-typing", onTyping);
    return () => window.removeEventListener("aura:chat-typing", onTyping);
  }, [selfHandle]);

  // Reap expired typing entries every second, but only while there is
  // something to reap and the window is on screen. This ran unconditionally
  // for the lifetime of the surface — a 1Hz wake-up that spent virtually all
  // of its time proving an empty map is still empty, and kept firing behind a
  // Cmd-Tab. Nobody is typing at you while you're in another app, and the
  // effect re-runs on the way back so a beacon that expired in the background
  // is dropped on the first tick after the tab returns rather than lingering.
  //
  // The cadence stays 1s: a peer's beacon carries a ~5s `expires_at`, so a
  // slower sweep would leave "… is typing" on screen visibly after they
  // stopped. Gating the timer's existence is the win, not stretching it.
  const hasTypingPeers = Object.keys(typingPeers).length > 0;
  useEffect(() => {
    if (!hasTypingPeers || !visible) return;
    const reap = () => {
      const now = Math.floor(Date.now() / 1000);
      setTypingPeers((prev) => {
        let changed = false;
        const next: typeof prev = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v.expires_at > now) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    };
    reap();
    const id = window.setInterval(reap, 1000);
    return () => window.clearInterval(id);
  }, [hasTypingPeers, visible]);

  // ── focus-from-event (ShareCodeDialog routes here after sending) ──
  useEffect(() => {
    function onFocus(e: Event) {
      const detail = (e as CustomEvent).detail as { channel?: string } | undefined;
      if (!detail?.channel) return;
      const ch = detail.channel;
      const convId = ch.startsWith("dm-")
        ? `dm:${norm(dmOtherSide(ch, selfHandle))}`
        : `ch:${ch}`;
      setActiveId(convId);
      setActiveThread(null);
      // Handled live, so nothing is left parked to re-fire on the next mount.
      clearPendingChatRoute();
    }
    window.addEventListener(CHAT_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(CHAT_FOCUS_EVENT, onFocus);
  }, [selfHandle]);

  // ── a destination parked before this surface existed ──
  // A tapped chat notification asks for the Team place and dispatches the
  // focus event in the same breath. When Team was closed, that event lands a
  // render before the listener above exists — so the destination waits in
  // `chatRoute` and is collected here, on the mount it was waiting for.
  // Declared after the listener so the re-dispatch has something to hear.
  useEffect(() => {
    const channel = takePendingChatRoute(repoRoot);
    if (channel) focusChatChannel(channel);
  }, [repoRoot]);

  // ── open-DM-by-handle (auto-DM deep-links + page/task mentions) ──
  // A clicked @person dispatches `aura:open-dm` with a bare handle; App flips
  // the sidebar to Team and we focus that 1:1 conversation. Matches the
  // `dm:<handle>` conv-id the focus handler above produces.
  useEffect(() => {
    function onOpenDm(e: Event) {
      const handle = (e as CustomEvent<{ handle?: string }>).detail?.handle;
      if (!handle) return;
      setActiveId(`dm:${norm(handle)}`);
      setActiveThread(null);
    }
    window.addEventListener("aura:open-dm", onOpenDm);
    return () => window.removeEventListener("aura:open-dm", onOpenDm);
  }, []);

  // ── conversation list (sorted, decorated with last msg + unread) ──
  const allConvs = useMemo<Conversation[]>(() => {
    const decorate = (c: Conversation): Conversation => {
      const list = msgs[c.id];
      const last = list?.[list.length - 1];
      // The rail preview is "what was last said here", so it walks back past
      // sync envelopes to the last thing a person actually wrote — otherwise
      // a channel's one-line preview was a fragment of raw JSON. If there is
      // nothing human in the channel at all it stays undefined and the rail
      // falls back to the conversation's hint. `lastTs` deliberately still
      // tracks the raw tail so recency ordering is unchanged.
      let lastHuman: Msg | undefined;
      for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
        const m = list![i];
        if (isHumanBody(m.body)) {
          lastHuman = m;
          break;
        }
      }
      const lr = lastRead[c.id] ?? 0;
      // Sync envelopes don't make a channel unread. They arrive constantly and
      // the stream doesn't render them, so counting them meant a badge saying
      // "3" over a channel that opens with nothing new in it.
      const fresh = list
        ? list.filter((m) => m.ts > lr && !m.fromMe && isHumanBody(m.body))
        : [];
      const unread = fresh.length;
      const mentionUnread = selfHandle
        ? fresh.filter((m) => m.mentions?.includes(selfHandle)).length
        : 0;
      return {
        ...c,
        lastBody: lastHuman?.body,
        lastTs: last?.ts ?? c.lastTs,
        unread,
        mentionUnread,
      };
    };
    return [projectConv, ...builtins, ...customs, ...peers]
      .map(decorate)
      // Search matches the handle too. A DM row is titled with the person's
      // name now, so handle-only matching would have hidden colleagues people
      // still think of by their git login — and name-only would hide them from
      // anyone who types the login.
      .filter((c) => {
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return (
          c.name.toLowerCase().includes(q) ||
          (c.handle ?? "").toLowerCase().includes(q)
        );
      });
  }, [projectConv, builtins, customs, peers, msgs, search, lastRead, selfHandle]);

  // Publish the total unread count for the sidebar's Team segment badge.
  // Mirrors the per-conv unread math above (ts > lastRead && !fromMe) so
  // the segment count equals the sum of the channel-rail badges.
  useEffect(() => {
    const convs = [projectConv, ...builtins, ...customs, ...peers];
    let total = 0;
    for (const c of convs) {
      const list = msgs[c.id];
      if (!list || list.length === 0) continue;
      const lr = lastRead[c.id] ?? 0;
      for (const m of list) {
        if (m.ts > lr && !m.fromMe && isHumanBody(m.body)) total += 1;
      }
    }
    publishTeamUnread({ total });
  }, [projectConv, builtins, customs, peers, msgs, lastRead]);

  // Focus filter: under "unread"/"mentions" keep only matching rows, but
  // always retain the active conversation so the open channel never
  // disappears out from under the user when it gets marked read.
  const passesFilter = useCallback(
    (c: Conversation): boolean => {
      if (c.id === activeId) return true;
      if (railFilter === "unread") return (c.unread ?? 0) > 0;
      if (railFilter === "mentions") return (c.mentionUnread ?? 0) > 0;
      return true;
    },
    [railFilter, activeId],
  );

  const channelRows = useMemo(
    () =>
      allConvs
        .filter((c) => c.kind === "project" || c.kind === "channel" || c.kind === "system")
        .filter(passesFilter)
        .sort(byRecency),
    [allConvs, passesFilter],
  );
  const dmRows = useMemo(
    () => allConvs.filter((c) => c.kind === "dm").filter(passesFilter).sort(byRecency),
    [allConvs, passesFilter],
  );
  const customRows = useMemo(
    () => allConvs.filter((c) => c.kind === "custom").filter(passesFilter).sort(byRecency),
    [allConvs, passesFilter],
  );

  // Team-wide tallies for the focus-filter chips' counters.
  const totalUnread = useMemo(
    () => allConvs.reduce((n, c) => n + (c.unread ?? 0), 0),
    [allConvs],
  );
  const totalMentions = useMemo(
    () => allConvs.reduce((n, c) => n + (c.mentionUnread ?? 0), 0),
    [allConvs],
  );

  const active = activeId ? allConvs.find((c) => c.id === activeId) ?? null : null;

  // Reset the in-channel message search when switching channels — a query
  // typed in #general shouldn't carry into a DM.
  useEffect(() => {
    setMsgSearchOpen(false);
    setMsgQuery("");
  }, [active?.id]);

  // ── mark-as-read when looking at a thread ─────────────────────────
  useEffect(() => {
    if (!active || activeThread) return;
    const list = msgs[active.id] ?? [];
    const max = list.reduce((a, m) => Math.max(a, m.ts), 0);
    if (!max) return;
    if ((lastRead[active.id] ?? 0) >= max) return;
    const next = { ...lastRead, [active.id]: max };
    setLastRead(next);
    persistLastRead(active.id, max);
  }, [active, activeThread, msgs, lastRead]);

  // `emittedCursorRef` is hoisted to the top of the component so the
  // cross-repo reset effect can clear it; the original declaration
  // lived here, immediately above the read-cursor emitter below.

  // ── emit read cursor when a channel becomes active / window focuses ─
  // The receipt rides the existing room WS (bridged via `aura:ws-send`)
  // so the cloud upserts our row in `chat_read_cursors` and fans out a
  // `read_cursor_update` to every other device in the channel. We emit
  // the highest cloud-acked `seq` we've seen — local-only optimistic
  // rows have no seq yet and can't anchor a receipt.
  useEffect(() => {
    if (!active || activeThread) return;
    const channelSlug = active.channel;
    if (!channelSlug) return; // project/system feeds don't fan out
    if (!visible) return;
    const list = msgs[active.id] ?? [];
    let maxSeq = 0;
    for (const m of list) {
      if (typeof m.seq === "number" && m.seq > maxSeq) maxSeq = m.seq;
    }
    if (maxSeq <= 0) return;
    if (!myDevice?.device_id) return;
    const prev = emittedCursorRef.current[channelSlug] ?? 0;
    if (maxSeq <= prev) return;
    emittedCursorRef.current = {
      ...emittedCursorRef.current,
      [channelSlug]: maxSeq,
    };
    window.dispatchEvent(
      new CustomEvent("aura:ws-send", {
        detail: {
          kind: "read_cursor",
          channel: channelSlug,
          device_id: myDevice.device_id,
          display: myDevice.display ?? "",
          last_read_seq: maxSeq,
        },
      }),
    );
  }, [active, activeThread, msgs, myDevice, visible]);

  const fetchActive = useCallback(async () => {
    if (!active) return;
    if (active.id === "project") return loadProjectFeed();
    if (active.id === "sentinel") return loadSentinelFeed();
    if (active.channel) await loadChatChannel(active.channel);
  }, [active, loadProjectFeed, loadSentinelFeed, loadChatChannel]);

  useEffect(() => {
    if (!active) return;
    fetchActive();
    if (!visible) return;
    const id = window.setInterval(fetchActive, 3000);
    return () => window.clearInterval(id);
  }, [active, fetchActive, visible]);

  // ── pinned-message set (per conv, persisted to localStorage) ──────
  // `pinnedByConv` is hoisted to the top of the component so the
  // cross-repo reset effect can clear it. Lazy-hydrate the pinned set
  // for whichever conv becomes active so we don't bother scanning
  // localStorage for every channel up front.
  useEffect(() => {
    if (!active) return;
    setPinnedByConv((prev) => {
      if (prev[active.id]) return prev;
      return { ...prev, [active.id]: loadPinned(active.id) };
    });
  }, [active]);

  const togglePin = useCallback((convId: string, msgId: string) => {
    setPinnedByConv((prev) => {
      const cur = new Set(prev[convId] ?? loadPinned(convId));
      if (cur.has(msgId)) cur.delete(msgId);
      else cur.add(msgId);
      persistPinned(convId, cur);
      return { ...prev, [convId]: cur };
    });
  }, []);

  // ── delivery_status poll for the active channel's outbox ─────────
  // 2 s tick — cheap file read on the Rust side. Merges pending/failed
  // into the rendered list; messages that exit the outbox flip back to
  // "delivered" so the badge clears automatically.
  useEffect(() => {
    if (!active?.channel) return;
    const channel = active.channel;
    const convId = active.id;
    let cancelled = false;
    const poll = async () => {
      try {
        const entries = await api.chatOutboxStatus(repoRoot, channel);
        if (cancelled) return;
        setMsgs((prev) => {
          const list = prev[convId];
          if (!list) return prev;
          const byId = new Map(entries.map((e) => [e.msg_id, e]));
          let dirty = false;
          const next = list.map((m) => {
            const entry = byId.get(m.id);
            if (entry) {
              const status: "pending" | "failed" = entry.failed ? "failed" : "pending";
              if (m.delivery_status !== status) {
                dirty = true;
                return { ...m, delivery_status: status };
              }
              return m;
            }
            // No outbox entry → cleared. Only drop a "pending" badge;
            // an explicit "failed" stays sticky until the user retries.
            if (m.delivery_status === "pending") {
              dirty = true;
              return { ...m, delivery_status: "delivered" as const };
            }
            return m;
          });
          return dirty ? { ...prev, [convId]: next } : prev;
        });
      } catch {
        /* outbox cmd may not be ready — silent */
      }
    };
    poll();
    if (!visible) return () => { cancelled = true; };
    const id = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, repoRoot, visible]);

  // Kick the outbox drain on mount so any leftover sends from a prior
  // process run get retried in the background.
  useEffect(() => {
    if (!repoRoot) return;
    api.chatOutboxDrainKickoff(repoRoot).catch(() => { /* not registered yet */ });
  }, [repoRoot]);

  // ── send ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (
      conv: Conversation,
      body: string,
      threadParent?: string,
      attachments?: ChatAttachment[],
      repoFiles?: RepoFileAttachment[],
    ) => {
      // II.9 first-send identity check — if the banner is visible AND
      // we haven't already prompted on this repo this session, open
      // the picker BEFORE the chat_send fires so the user's first
      // message in this repo gets attributed correctly. Cancel/skip
      // still proceeds with the send under the email-local-part
      // default — the dialog is purely additive.
      if (
        conv.channel &&
        identityBannerVisible &&
        !promptedReposRef.current.has(repoRoot)
      ) {
        promptedReposRef.current.add(repoRoot);
        setIdentityPickerOpen(true);
        // Intentionally do NOT block the send: the user can still
        // dismiss the picker and let the message ship under the default
        // identity. The dialog write triggers `aura:identity-updated`
        // which refreshes `selfHandle` for any subsequent sends.
      }
      // Both encoders are no-ops on empty arrays, so we can wrap the
      // body unconditionally. Repo-files go first because their sentinel
      // is shorter and we want attachments at the very tail (renderers
      // peel the tail-most sentinel first).
      const encoded = encodeAttachments(
        encodeRepoFiles(body, repoFiles ?? []),
        attachments ?? [],
      );
      if (!conv.channel) {
        // Project & sentinel handled by their own send paths.
        if (conv.id === "sentinel") {
          await api.sentinelSend(repoRoot, "desktop", "", "", encoded);
          loadSentinelFeed();
        }
        return;
      }
      // #aura-only pseudonym: if the user opted into a handle for the
      // worldwide channel, post under it. Every other channel keeps the
      // real name. This is a per-message sender override — no global
      // identity change (see ChannelDisclosureCard / chat_send's from_name).
      const auraHandle =
        conv.channel === AURA_GLOBAL_CHANNEL
          ? localStorage.getItem("aura.chat.handle.aura")
          : null;
      const msg = await api.chatSend({
        repoRoot,
        channel: conv.channel,
        body: encoded,
        threadParent,
        ...(auraHandle
          ? { fromName: auraHandle, fromHandle: auraHandle }
          : {}),
      });
      const convId = conv.id;
      setMsgs((prev) => {
        const list = prev[convId] ?? [];
        const optimistic: Msg = {
          ...chatToMsg(msg, selfKeys, myDevice?.device_id ?? null),
          // The optimistic row is always ours regardless of which handle
          // layer `chat_send` stamped — force it so the self-echo dedup
          // below reliably collapses the cloud broadcast into it.
          fromMe: true,
          delivery_status: "pending",
        };
        // The WS room broadcast (server-side fan-out) can land BEFORE
        // `api.chatSend()` resolves. It may arrive under the SAME id (skip by
        // id) OR — because the cloud re-stamps the sender handle and mints its
        // own id — under a DIFFERENT id, in which case a body/ts match against
        // an already-received row is the echo of THIS send. Appending then
        // would duplicate the bubble (symmetric to the WS-receiver dedup
        // above). A foreign device id on the existing row vetoes the body
        // match so we never fold our send into a teammate's identical text.
        const already = list.some(
          (m) =>
            m.id === optimistic.id ||
            (m.body.trim() === optimistic.body.trim() &&
              Math.abs(m.ts - optimistic.ts) <= 300 &&
              !(
                m.senderDeviceId &&
                myDevice?.device_id &&
                norm(m.senderDeviceId) !== norm(myDevice.device_id)
              )),
        );
        if (already) {
          return prev;
        }
        return { ...prev, [convId]: [...list, optimistic] };
      });
    },
    [repoRoot, selfHandle, selfKeys, loadSentinelFeed, identityBannerVisible],
  );

  const resendMessage = useCallback(
    async (channel: string, msgId: string) => {
      try {
        await api.chatResend(repoRoot, channel, msgId);
        // Flip the row back to pending so the badge reflects the retry.
        setMsgs((prev) => {
          const next: Record<string, Msg[]> = {};
          for (const [k, list] of Object.entries(prev)) {
            next[k] = list.map((m) =>
              m.id === msgId ? { ...m, delivery_status: "pending" as const } : m,
            );
          }
          return next;
        });
      } catch (e) {
        console.warn("resend failed", e);
      }
    },
    [repoRoot],
  );

  // ── claim ─────────────────────────────────────────────────────────
  const claim = useCallback(async () => {
    try {
      const m = await api.teamClaim(repoRoot);
      applyManifest(m);
      const id = await refreshIdentity(repoRoot);
      applyIdentity(id);
    } catch (e) {
      console.warn("claim failed", e);
    }
  }, [repoRoot]);

  // ── create channel ────────────────────────────────────────────────
  // Shared submit path for the CreateChannelWizard. Slugifies the name to the
  // handle, creates via the additive channel_meta visibility, optionally sets
  // the topic through the same teamChannelUpdate the Settings editor uses, then
  // jumps to the new channel. Private channels seed the creator as the sole
  // member+admin; fuller member management lives in Settings → Team → Channels.
  const createChannel = useCallback(
    async ({ name, visibility, topic }: CreateChannelInput) => {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      if (!slug) return;
      await api.teamChannelCreate(
        repoRoot,
        slug,
        visibility === "private"
          ? { visibility: "private", members: [] }
          : undefined,
      );
      const t = topic?.trim();
      if (t) {
        await api.teamChannelUpdate(repoRoot, slug, { topic: t });
      }
      await loadTeam();
      setActiveId(`ch:${slug}`);
      setCreatingChannel(false);
    },
    [repoRoot, loadTeam],
  );

  // Rail "+" affordance: open the full-screen wizard instead of firing native
  // browser popups. The wizard owns name/topic/visibility and calls
  // createChannel on submit.
  const promptCreateChannel = useCallback(() => {
    setCreatingChannel(true);
  }, []);

  // ── custom channel tabs (team-shared URL tabs) ────────────────────
  // Both mutate team.json through the Rust commands and adopt the
  // returned manifest, so the new tab strip re-derives from the same
  // source every other device reads. Errors bubble to the caller — the
  // add-tab form surfaces them inline.
  const addChannelTab = useCallback(
    async (slug: string, label: string, url: string) => {
      const m = await api.teamChannelTabAdd(repoRoot, slug, label, url);
      applyManifest(m);
    },
    [repoRoot],
  );

  const removeChannelTab = useCallback(
    async (slug: string, tabId: string) => {
      const m = await api.teamChannelTabRemove(repoRoot, slug, tabId);
      applyManifest(m);
    },
    [repoRoot],
  );

  // ── derived: active members + thread/replies state ───────────────
  const activePinnedSet = active ? pinnedByConv[active.id] : undefined;
  const activeMsgsRaw = active ? msgs[active.id] ?? NO_MSGS : NO_MSGS;
  const activeMsgs = useMemo(() => {
    // The sync layers post their envelopes into the same channels people
    // talk in, so the stream carries both. An envelope has nothing in it to
    // read — it rendered as a wall of `{"v":1,"op":"upsert",…}` under a
    // teammate's name — and it should not count as a thread or earn its
    // author a roster seat either, both of which are derived from here.
    // `activeMsgsRaw` is still returned below for anything that wants the
    // unfiltered stream.
    const human = activeMsgsRaw.filter((m) => isHumanBody(m.body));
    if (!activePinnedSet || activePinnedSet.size === 0) return human;
    return human.map((m) =>
      activePinnedSet.has(m.id) ? { ...m, pinned: true } : m,
    );
  }, [activeMsgsRaw, activePinnedSet]);
  // Roster for the active conversation. Per-repo channels use the git-team
  // manifest as before. The worldwide `#aura` channel has no per-repo
  // membership — it's "everyone on Aura, anywhere" — so its roster is the
  // set of people this device has actually seen post there (seeded with
  // yourself). Without this the header/rail counted only the local repo
  // team, which read as just "1". Identical to `members` for every other
  // conversation, so nothing else changes.
  const activeRoster = useMemo<TeamMember[]>(() => {
    const base =
      active?.channel !== AURA_GLOBAL_CHANNEL
        ? members
        : auraRosterFromStream(
            activeMsgs,
            members,
            selfHandle,
            myDevice?.display ?? selfHandle,
          );
    // Collapse the LOCAL user's own duplicate seats into a single row. One
    // person routinely holds two roster seats — their GitHub login (`ashiq`,
    // a strong self-key) and their git-email local-part (`ashiqwayanad007`, a
    // weak one) — and both resolve to "me", so the rail would otherwise show
    // the user to themselves twice ("two of my account"). We only ever fold
    // OUR OWN seats: a member is self when its handle/email matches our
    // selfKeys or it's an explicitly-linked seat. Teammates' distinct seats
    // are untouched. Prefer the seat whose handle is our current selfHandle as
    // the survivor, else the most-committed one.
    const isMemberSelf = (m: TeamMember) =>
      m.handle === selfHandle ||
      isSelfSender(m.handle, selfKeys) ||
      (!!m.email && isSelfSender(m.email, selfKeys)) ||
      isMemberLinkedSelf(m);
    const selves = base.filter(isMemberSelf);
    if (selves.length <= 1) return base;
    const survivor =
      selves.find((m) => m.handle === selfHandle) ??
      [...selves].sort((a, b) => (b.commits ?? 0) - (a.commits ?? 0))[0];
    return base.filter((m) => m === survivor || !isMemberSelf(m));
  }, [
    active?.channel,
    activeMsgs,
    members,
    selfHandle,
    myDevice?.display,
    selfKeys,
    isMemberLinkedSelf,
  ]);

  // Memoised, like every other derived collection here: these three are read
  // straight out of the returned model, so a fresh array/map each render would
  // keep that model unstable no matter what the memo below does.
  const topLevel = useMemo(
    () => activeMsgs.filter((m) => !m.thread_parent),
    [activeMsgs],
  );
  // In-channel search filters the visible top-level stream by body or
  // sender (case-insensitive). Empty query → the full stream.
  const msgQ = msgQuery.trim().toLowerCase();
  const shownTopLevel = useMemo(
    () =>
      msgQ
        ? topLevel.filter(
            (m) =>
              m.body.toLowerCase().includes(msgQ) ||
              m.sender.toLowerCase().includes(msgQ),
          )
        : topLevel,
    [msgQ, topLevel],
  );
  const threadCounts = useMemo(() => countThreads(activeMsgs), [activeMsgs]);
  const lastReadActive = active ? lastRead[active.id] ?? 0 : 0;

  // Peer read cursors filtered to the active channel and excluding our
  // own device. The MessageStream + Bubble use this to decide which
  // peers' avatars appear under the "Seen by …" row of each message.
  const activeChannelCursors = useMemo<ReadCursorEntry[]>(() => {
    if (!active?.channel) return [];
    const ch = active.channel;
    const mine = myDevice?.device_id ?? "";
    const out: ReadCursorEntry[] = [];
    for (const entry of Object.values(readCursors)) {
      if (entry.channel !== ch) continue;
      if (mine && entry.device_id === mine) continue;
      out.push(entry);
    }
    // Highest cursor first — UI surfaces the furthest-along peer first.
    out.sort((a, b) => b.last_read_seq - a.last_read_seq);
    return out;
  }, [active, myDevice, readCursors]);

  // ── render shell ──────────────────────────────────────────────────
  // One-column collapse: show rail OR thread, controlled by active.
  const showRail = wide || !active;
  const showCenter = wide || !!active;
  // Members are a slide-over peek (not a permanent column): the stream
  // keeps full width and the roster overlays the right edge only when
  // the header toggle asks for it. Dropping the old `veryWide` gate lets
  // it work in the narrow ADE sidebar context too.
  const showMembersRail =
    membersOpen &&
    !!active &&
    active.kind !== "project" &&
    active.kind !== "system";

  // ── the model ─────────────────────────────────────────────────────
  // Memoised because TeamChatProvider hands this straight to a context that
  // wraps the entire Team shell: a fresh literal here re-renders every pane
  // below it on every tick of every poll in this file, even when not one field
  // moved. Everything listed is a state value, a setter, a ref, or an already-
  // memoised callback/derivation, so the identity only turns over when the
  // model genuinely changes.
  return useMemo(
    () => ({
      activeId,
      setActiveId,
      activeThread,
      setActiveThread,
      channelTab,
      setChannelTab,
      cloudAccount,
      cloudConnected,
      setCloudConnected,
      creatingChannel,
      setCreatingChannel,
      doctorReport,
      setDoctorReport,
      identity,
      setIdentity,
      identityPickerOpen,
      setIdentityPickerOpen,
      lastRead,
      setLastRead,
      manifest,
      setManifest,
      dupSuggestions,
      confirmDuplicate,
      rejectDuplicate,
      membersOpen,
      setMembersOpen,
      msgQuery,
      setMsgQuery,
      msgs,
      setMsgs,
      msgSearchOpen,
      setMsgSearchOpen,
      myDevice,
      setMyDevice,
      panelW,
      setPanelW,
      pinnedByConv,
      setPinnedByConv,
      pinsOpen,
      setPinsOpen,
      railFilter,
      setRailFilter,
      readCursors,
      setReadCursors,
      search,
      setSearch,
      typingPeers,
      setTypingPeers,
      active,
      activeChannelCursors,
      activeMsgs,
      activeMsgsRaw,
      activeRoster,
      activePinnedSet,
      addChannelTab,
      allConvs,
      builtins,
      callSnap,
      channelRows,
      chatBackgroundChannels,
      claim,
      createChannel,
      customRows,
      customs,
      dmRows,
      emittedCursorRef,
      fetchActive,
      firstChatPoll,
      identityBannerKind: identityBannerKindValue,
      identityBannerVisible,
      lastReadActive,
      loadChatChannel,
      loadProjectFeed,
      loadSentinelFeed,
      loadTeam,
      members,
      msgQ,
      myVoiceChannel,
      notifiedMsgIds,
      passesFilter,
      peers,
      prevRepoRef,
      projectConv,
      promptCreateChannel,
      promptedReposRef,
      railWidth,
      refreshDoctor,
      removeChannelTab,
      resendMessage,
      rootRef,
      selfHandle,
      selfKeys,
      selfLinks,
      linkSelf,
      unlinkSelf,
      isMemberLinkedSelf,
      sendMessage,
      showCenter,
      showMembersRail,
      shownTopLevel,
      showRail,
      threadCounts,
      togglePin,
      topLevel,
      totalMentions,
      totalUnread,
      visible,
      voiceByChannel,
      wide,
      wsHandlerRef,
    }),
    // Every field above, so nothing can go stale behind the memo. There is no
    // exhaustive-deps lint in this package to catch a drifting pair, so a new
    // key on the object needs a matching entry here by hand.
    [
      activeId,
      setActiveId,
      activeThread,
      setActiveThread,
      channelTab,
      setChannelTab,
      cloudAccount,
      cloudConnected,
      setCloudConnected,
      creatingChannel,
      setCreatingChannel,
      doctorReport,
      setDoctorReport,
      identity,
      setIdentity,
      identityPickerOpen,
      setIdentityPickerOpen,
      lastRead,
      setLastRead,
      manifest,
      setManifest,
      dupSuggestions,
      confirmDuplicate,
      rejectDuplicate,
      membersOpen,
      setMembersOpen,
      msgQuery,
      setMsgQuery,
      msgs,
      setMsgs,
      msgSearchOpen,
      setMsgSearchOpen,
      myDevice,
      setMyDevice,
      panelW,
      setPanelW,
      pinnedByConv,
      setPinnedByConv,
      pinsOpen,
      setPinsOpen,
      railFilter,
      setRailFilter,
      readCursors,
      setReadCursors,
      search,
      setSearch,
      typingPeers,
      setTypingPeers,
      active,
      activeChannelCursors,
      activeMsgs,
      activeMsgsRaw,
      activeRoster,
      activePinnedSet,
      addChannelTab,
      allConvs,
      builtins,
      callSnap,
      channelRows,
      chatBackgroundChannels,
      claim,
      createChannel,
      customRows,
      customs,
      dmRows,
      emittedCursorRef,
      fetchActive,
      firstChatPoll,
      identityBannerKindValue,
      identityBannerVisible,
      lastReadActive,
      loadChatChannel,
      loadProjectFeed,
      loadSentinelFeed,
      loadTeam,
      members,
      msgQ,
      myVoiceChannel,
      notifiedMsgIds,
      passesFilter,
      peers,
      prevRepoRef,
      projectConv,
      promptCreateChannel,
      promptedReposRef,
      railWidth,
      refreshDoctor,
      removeChannelTab,
      resendMessage,
      rootRef,
      selfHandle,
      selfKeys,
      selfLinks,
      linkSelf,
      unlinkSelf,
      isMemberLinkedSelf,
      sendMessage,
      showCenter,
      showMembersRail,
      shownTopLevel,
      showRail,
      threadCounts,
      togglePin,
      topLevel,
      totalMentions,
      totalUnread,
      visible,
      voiceByChannel,
      wide,
      wsHandlerRef,
    ],
  );
}

/** The full team-chat application model: everything `useTeamChat` exposes.
 *  The presentation panes (ConversationList / ConversationView / ContextPanel)
 *  take this bundle as a prop so the container owns the single hook instance
 *  and the panes stay pure-presentational. */
export type TeamChatModel = ReturnType<typeof useTeamChat>;
