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
  SentinelMessage,
} from "../../../lib/api";
import type { ActivityPayload, Msg } from "./types";
import { isSelfSender, norm, type SelfKeys } from "./identity";
import { dmOtherSide } from "./channels";

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

export function chatToMsg(m: ChatMessage, selfKeys: SelfKeys): Msg {
  // `seq` is set on cloud-acked rows; the file-backed JSONL may not
  // carry it, in which case read-cursor comparisons skip the message
  // until the WS broadcast lands and re-merges with a populated seq.
  //
  // `fromMe` is resolved against the full self-key set rather than a
  // single handle string: `resolve_handle` stamps `from_handle` under
  // whichever identity layer (override / roster / email-local-part) was
  // active at send time, so older messages of ours can carry a different
  // handle than the current `selfHandle`. See domain/identity.ts.
  return {
    id: m.id,
    ts: m.ts,
    sender: m.from_handle,
    body: m.body,
    fromMe: isSelfSender(m.from_handle, selfKeys),
    kind: "msg",
    mentions: m.mentions,
    thread_parent: m.thread_parent,
    is_agent: m.is_agent,
    seq: typeof m.seq === "number" ? m.seq : undefined,
  };
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
  return line.length > 240 ? line.slice(0, 237) + "…" : line;
}
