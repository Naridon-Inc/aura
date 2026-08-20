/** Team (chat) bounded context — message model converters.
 *
 *  Pure functions that turn the various wire/log shapes (cloud chat rows,
 *  git commits, intent-log entries, sentinel agent messages) into the
 *  unified `Msg` the stream renders, plus the thread-count reducer and the
 *  intent-body cleaners. Lifted verbatim from CommsPanel — no behaviour
 *  change, just relocated into the domain layer the stream builds on. */

import type {
  ChatMessage,
  CommitEntry,
  IntentEntry,
  IntentRow,
  SentinelMessage,
  TeamMember,
} from "../../../lib/api";
import type { ActivityPayload, Msg } from "./types";
import { isSelfSender, norm, type SelfKeys } from "./identity";
import { dmOtherSide } from "./channels";
import { truncate } from "../../../lib/truncate";

/** The conversation bucket a message belongs to.
 *
 *  Channels route by slug (`ch:<slug>`). DMs route to the *peer* — the one
 *  participant who isn't us — and CRUCIALLY an incoming message routes by
 *  its real SENDER, never by the channel slug alone. The whole team shares
 *  one room and a DM's slug is whatever the sender's client computed, so a
 *  malformed, stale, or colliding slug would otherwise drop a third party's
 *  message into an unrelated 1:1 (the "I see shahabas inside my DM with
 *  ijas" bug). A message from person X belongs in the DM with person X,
 *  full stop. Our own sends carry no peer in the sender field, so they fall
 *  back to the other side of the slug we authored (trustworthy for us). */
export function convIdForMessage(
  channel: string,
  msg: Pick<Msg, "sender" | "fromMe">,
  selfHandle: string,
): string {
  if (!channel.startsWith("dm-")) return `ch:${channel}`;
  // The self-DM scratch pad is a single-party conversation with `dm:<me>`.
  if (channel.startsWith("dm-self-")) return `dm:${norm(selfHandle)}`;
  if (!msg.fromMe) {
    const sender = norm(msg.sender);
    if (sender) return `dm:${sender}`;
  }
  return `dm:${norm(dmOtherSide(channel, selfHandle))}`;
}

export function countThreads(msgs: Msg[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of msgs) {
    if (m.thread_parent) {
      out.set(m.thread_parent, (out.get(m.thread_parent) ?? 0) + 1);
    }
  }
  return out;
}

export function chatToMsg(
  m: ChatMessage,
  selfKeys: SelfKeys,
  myDeviceId?: string | null,
): Msg {
  // `seq` is set on cloud-acked rows; the file-backed JSONL may not
  // carry it, in which case read-cursor comparisons skip the message
  // until the WS broadcast lands and re-merges with a populated seq.
  //
  // `fromMe` is resolved against the full self-key set rather than a
  // single handle string: `resolve_handle` stamps `from_handle` under
  // whichever identity layer (override / roster / email-local-part) was
  // active at send time, so older messages of ours can carry a different
  // handle than the current `selfHandle`. The device id is passed so a
  // weak (email-local-part) match on a colleague who shares our git email
  // is rejected — see domain/identity.ts.
  const senderDeviceId = m.from_device_id ?? null;
  return {
    id: m.id,
    ts: m.ts,
    sender: m.from_handle,
    body: m.body,
    fromMe: isSelfSender(m.from_handle, selfKeys, {
      senderDeviceId,
      myDeviceId,
    }),
    kind: "msg",
    mentions: m.mentions,
    thread_parent: m.thread_parent,
    is_agent: m.is_agent,
    seq: typeof m.seq === "number" ? m.seq : undefined,
    senderDeviceId,
  };
}

/** Derive the roster for the worldwide `#aura` channel from the stream
 *  itself. Unlike a per-repo channel, `#aura` has no `manifest.members`
 *  list — it's "everyone on Aura, anywhere", so its membership is simply
 *  the set of distinct people this device has actually seen post there,
 *  seeded with the local user so the room is never empty. This is the
 *  honest client-side answer to "who's in here": real participants, not
 *  the local git-repo team (which showed just "1").
 *
 *  A global sender who also happens to be a repo teammate keeps their
 *  full roster row (status, admin, presence); everyone else becomes a
 *  minimal row keyed on their handle. Agents and system/activity rows are
 *  excluded — this counts *users*. Presence (`last_seen`) is left at 0 for
 *  people we have no beacon for, so the rail honestly shows them offline
 *  rather than faking a live dot from a message timestamp. */
export function auraRosterFromStream(
  stream: Msg[],
  members: TeamMember[],
  selfHandle: string,
  selfName: string,
): TeamMember[] {
  const byHandle = new Map<string, TeamMember>();
  const add = (handle: string, firstSeen: number, selfSeed = false) => {
    if (!handle) return;
    const existing = byHandle.get(handle);
    if (existing) {
      // Keep the earliest first-seen we've observed for this participant.
      if (firstSeen > 0 && (existing.first_seen === 0 || firstSeen < existing.first_seen)) {
        byHandle.set(handle, { ...existing, first_seen: firstSeen });
      }
      return;
    }
    const known = members.find((x) => x.handle === handle);
    if (known) {
      byHandle.set(handle, known);
      return;
    }
    byHandle.set(handle, {
      email: "",
      name: selfSeed ? selfName || handle : handle,
      handle,
      commits: 0,
      first_seen: firstSeen,
      last_seen: 0,
      claimed: selfSeed,
      admin: false,
    });
  };
  // Seed self first so "you" is always present and the count is never 0.
  if (selfHandle) add(selfHandle, 0, true);
  for (const m of stream) {
    if (m.kind !== "msg" || m.is_agent) continue;
    add(m.sender, m.ts);
  }
  return Array.from(byHandle.values());
}

// ── project-feed converters ──────────────────────────────────────────
//
// Project conv ("Lumi" / repo name) renders aura's own activity stream:
// commits, sentinel intents, snapshots, agent-to-agent sentinel messages.
// These are NOT chat — they're a structured activity feed. Each helper
// produces a `kind: "activity"` row whose body is rendered as an
// ActivityRow (icon · agent · headline · timestamp, click to expand).

export function commitToMsg(c: CommitEntry): Msg {
  const short = (c.sha || "").slice(0, 7);
  const badges: ActivityPayload["badges"] = [];
  if (short) badges.push({ label: short, tone: "neutral" });
  if (c.branch) badges.push({ label: c.branch, tone: "neutral" });
  return {
    id: `commit-${c.sha}`,
    ts: c.timestamp,
    sender: c.author || "git",
    body: c.subject,
    fromMe: false,
    kind: "activity",
    activity: {
      type: "commit",
      title: c.subject,
      commitSha: c.sha,
      badges: badges.length > 0 ? badges : undefined,
    },
  };
}

export function intentToMsg(it: IntentEntry): Msg {
  const badges: ActivityPayload["badges"] = [];
  if (it.branch) badges.push({ label: it.branch, tone: "neutral" });
  if (it.commit) badges.push({ label: it.commit.slice(0, 7), tone: "neutral" });
  if (it.status) {
    const tone: "good" | "warn" | "neutral" =
      it.status === "ok" || it.status === "applied" ? "good"
      : it.status === "failed" || it.status === "rejected" ? "warn"
      : "neutral";
    badges.push({ label: it.status, tone });
  }
  const body = cleanIntentBody(it.intent);
  return {
    // Stable id-or-timestamp fallback (matches commitToMsg/sentinelToMsg).
    // The project feed re-sorts intents+commits by ts on every 10s poll, so
    // an array-index fallback would shift and remount the row — flickering
    // away any expanded state. Timestamp is stable across re-sorts.
    id: `intent-${it.id || it.timestamp}`,
    ts: it.timestamp,
    sender: it.agent || "aura",
    body,
    fromMe: false,
    kind: "activity",
    activity: {
      type: "intent",
      title: firstLine(body),
      // Only carry `detail` when there's MORE to show than the headline
      // — otherwise the expanded view just repeats the title.
      detail: hasMoreThanFirstLine(body) ? body : undefined,
      files: it.changeset?.files,
      commitSha: it.commit || undefined,
      badges: badges.length > 0 ? badges : undefined,
    },
  };
}

// ── intent feed as readable, session-grouped chat ────────────────────
//
// The project feed used to spray one dense "aura INTENT · <truncated>" row
// per logged intent — a firehose that read like a machine log, not a team.
// Instead we cluster intents into the working SESSION they belong to and
// render them as ordinary chat: a session's opening intent becomes a normal
// message (agent avatar · name · full prose), and every later intent in that
// session hangs off it as a thread reply. The channel then reads as one story
// per session, and the play-by-play accrues live inside the thread as the
// agent keeps working — the way a teammate narrates "here's what I'm doing"
// and then follows up in the thread.

// Which actor an intent is attributed to. `agent_id` is *which AI* produced
// the work, so we surface that as the author. The orchestrator's routing id
// is `aura-manager`, but its product name in the UI is just "Aura" (never
// "Aura Manager"), so we fold that down. Empty ids fall back to "aura".
function intentActor(r: IntentRow): string {
  const a = (r.agent_id || "").trim();
  if (!a || a === "aura-manager" || a === "manager") return "aura";
  return a;
}

// One intent row → one readable chat message. Body is the cleaned intent
// prose (envelope tags stripped), authored by the acting agent, never "from
// me" (activity is observed, not sent). `threadParent` is set for every
// intent after a session's first so it files into that session's thread.
function intentRowToMsg(r: IntentRow, id: string, threadParent?: string): Msg {
  return {
    id,
    ts: r.timestamp || 0,
    sender: intentActor(r),
    body: cleanIntentBody(r.intent),
    fromMe: false,
    kind: "msg",
    is_agent: true,
    // Read out of the work log, not sent to anyone — the `thread_parent`
    // below groups a session's intents, it does not mean someone replied.
    derived: true,
    thread_parent: threadParent,
  };
}

// A durable session key for one intent row. Rows stamped with a real session
// id (a Claude jsonl stem, or a native-chat "manager" id) cluster on it. Rows
// with neither — older intents logged before session-stamping shipped — fall
// back to a rolling per-actor gap: consecutive intents by the same agent
// within SESSION_GAP_SECS are one working stretch; a longer pause opens a new
// one. `gap` carries the running per-actor state across the sorted pass.
const SESSION_GAP_SECS = 20 * 60;
function sessionKeyForRow(
  r: IntentRow,
  gap: Map<string, { key: string; ts: number }>,
): string {
  if (r.claude_session_id) return `sid:${r.claude_session_id}`;
  if (r.manager_session_id) return `mgr:${r.manager_session_id}`;
  const who = intentActor(r);
  const ts = r.timestamp || 0;
  const prev = gap.get(who);
  const key = prev && ts - prev.ts <= SESSION_GAP_SECS ? prev.key : `gap:${who}:${ts}`;
  gap.set(who, { key, ts });
  return key;
}

/** Turn the raw intent log into session-grouped, human-readable chat rows.
 *
 *  Emits one top-level `kind:"msg"` per session (its opening intent) plus a
 *  `thread_parent`-linked reply for each subsequent intent in that session.
 *  The stream's existing top-level filter hides the replies from the channel
 *  and surfaces them through the thread view + reply chip — so grouping needs
 *  no stream changes, and the thread grows live on each feed poll. */
export function intentRowsToSessionMsgs(rows: IntentRow[]): Msg[] {
  if (!rows || rows.length === 0) return [];
  // Ascending by time — the order a story is told in. Drop rows whose intent
  // is empty once the XML envelope is stripped, so we never mint a blank
  // bubble (nor orphan a thread under a blank parent).
  const sorted = [...rows]
    .filter((r) => cleanIntentBody(r.intent).trim().length > 0)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (sorted.length === 0) return [];

  const gap = new Map<string, { key: string; ts: number }>();
  const order: string[] = [];
  const groups = new Map<string, IntentRow[]>();
  for (const r of sorted) {
    const k = sessionKeyForRow(r, gap);
    let g = groups.get(k);
    if (!g) {
      g = [];
      groups.set(k, g);
      order.push(k);
    }
    g.push(r);
  }

  const out: Msg[] = [];
  for (const k of order) {
    const g = groups.get(k)!;
    // Parent id keys on the session, not on a row — stable as the session
    // grows, so an open thread stays anchored and React never remounts the
    // channel row when a new intent lands mid-session.
    const parentId = `sess-${k}`;
    out.push(intentRowToMsg(g[0], parentId));
    for (let i = 1; i < g.length; i++) {
      const r = g[i];
      const childId = r.signed_block_id
        ? `intent-${r.signed_block_id}`
        : `${parentId}-r${i}`;
      out.push(intentRowToMsg(r, childId, parentId));
    }
  }
  return out;
}

export function sentinelToMsg(m: SentinelMessage): Msg {
  const sender = m.from_agent || "agent";
  const tag = m.to_session ? ` → ${m.to_session.slice(0, 8)}` : " (broadcast)";
  return {
    id: m.id || `sent-${m.timestamp}`,
    ts: m.timestamp,
    sender,
    body: `${m.content}${tag}`,
    fromMe: sender === "desktop",
    kind: "msg",
  };
}

// Intent bodies sometimes get logged with the XML envelope still wrapped
// around them (`<intent>…</intent>\n<parameter name="intent_type">BugFix`).
// Strip those tags and the parameter blocks so the row reads as plain prose.
export function cleanIntentBody(raw: string | undefined | null): string {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/<\/?intent[^>]*>/gi, "");
  s = s.replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, "");
  s = s.replace(/<parameter\b[^>]*>[\s\S]*$/gi, "");
  s = s.replace(/<\/parameter>/gi, "");
  s = s.replace(/<[a-zA-Z/!?][^>]*>/g, "");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// True if the multi-line intent has content beyond the first line — i.e.
// expanding the row actually reveals something new.
export function hasMoreThanFirstLine(s: string): boolean {
  const lines = (s || "").split(/\r?\n/);
  if (lines.length <= 1) return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim().length > 0) return true;
  }
  return false;
}

// First non-empty line of a multi-line string, with a soft cap so a
// runaway intent doesn't blow out the row height when collapsed.
export function firstLine(s: string): string {
  const line = (s || "").split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return truncate(line, 240);
}
