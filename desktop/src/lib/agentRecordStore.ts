//! Live view of the record an agent keeps for itself.
//!
//! Some CLIs stream their structure over the wire and the chat can read it as
//! it arrives. Others — Codex, Kimi — run as full TUIs and paint a screen,
//! while writing the actual conversation to an append-only JSONL file beside
//! the session. For those, the file is the source of truth and the terminal is
//! a rendering of it, so the chat reads the file:
//!
//!   codex    → ~/.codex/sessions/…/rollout-*.jsonl          (codex_rollout_read)
//!   kimi     → ~/.kimi-code/sessions/…/agents/main/wire.jsonl   (kimi_wire_read)
//!   opencode → ~/.local/share/opencode/opencode.db         (opencode_record_read)
//!   pi       → ~/.pi/agent/sessions/--<cwd>--/*.jsonl          (pi_session_read)
//!
//! Each backend hands back only what changed since a cursor, so this store
//! keeps `(path, offset)` per repo, accumulates the parsed records, and wakes
//! subscribers. The matching `normalize*` adapter turns those records into the
//! same normalized events every other engine produces, so the transcript
//! renderer never learns that these four are different.
//!
//! The two halves of that cursor mean whatever the engine needs them to. For
//! the JSONL pair they are a filename and a byte offset. OpenCode keeps its
//! conversation in SQLite, so `path` is its session id and `offset` is a
//! millisecond timestamp — a part row there is UPDATED in place as a tool call
//! settles, and a byte cursor would deliver the request and never the result.
//! Both still satisfy the one rule this store cares about: a changed `path`
//! means a different conversation, and everything accumulated is stale.
//!
//! One store per (agent, repo root), shared by every subscriber: two tabs on
//! the same workspace read one file, not two.
//!
//! The poll paces itself by what it finds. Locating the file costs a directory
//! scan (Codex) or an index read (Kimi), so a flat 1 Hz tick would keep
//! re-checking something that has nothing new in it. Instead the cadence
//! follows the conversation: quick while output is landing, slower once it
//! goes quiet, slowest when this agent has never run here at all.

import { useEffect, useState } from "react";

import { api, type AgentRecordChunk } from "./api";

/** How long to wait before the next read, by what the last one returned. */
const STREAMING_MS = 400; // records still arriving — keep up with the agent
const IDLE_MS = 1500; // a record exists but is quiet
const ABSENT_MS = 6000; // this agent has never run in this repo

/** Reads a slice of one engine's record. */
type Reader = (
  repoRoot: string,
  path: string | null,
  sinceOffset: number,
) => Promise<AgentRecordChunk>;

/** Agent id → its record reader. An agent absent from this table streams its
 *  structure some other way (or not at all) and is read from the PTY. */
const READERS: Record<string, Reader> = {
  codex: (repoRoot, path, offset) => api.codexRolloutRead(repoRoot, path, offset),
  kimi: (repoRoot, path, offset) => api.kimiWireRead(repoRoot, path, offset),
  opencode: (repoRoot, path, offset) =>
    api.opencodeRecordRead(repoRoot, path, offset),
  pi: (repoRoot, path, offset) => api.piSessionRead(repoRoot, path, offset),
};

/** True when this agent keeps a record the chat can read instead of the
 *  terminal. */
export function hasAgentRecord(agentId: string): boolean {
  return READERS[agentId] != null;
}

type Entry = {
  agentId: string;
  repoRoot: string;
  /** The file being tailed, echoed back so the backend can tell a
   *  continuation from a fresh session. */
  path: string | null;
  offset: number;
  sessionId: string | null;
  /** Parsed records, oldest first. Replaced (not mutated) when it grows, so
   *  `useMemo` downstream sees a new identity and re-normalizes. */
  records: unknown[];
  subs: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** A read is in flight — never overlap them, or two chunks race to advance
   *  the same offset and one of them is dropped. */
  reading: boolean;
};

const entries = new Map<string, Entry>();

/** NUL joins the two halves because it is the one byte a path cannot contain,
 *  so no repo root can ever collide with another agent's key. Written as an
 *  escape, not typed literally — a raw NUL in the source makes git treat this
 *  whole file as binary, and an editor that strips control characters would
 *  quietly change the key instead of failing. */
function keyOf(agentId: string, repoRoot: string): string {
  return `${agentId}\u0000${repoRoot}`;
}

function ensure(agentId: string, repoRoot: string): Entry {
  const key = keyOf(agentId, repoRoot);
  const found = entries.get(key);
  if (found) return found;
  const entry: Entry = {
    agentId,
    repoRoot,
    path: null,
    offset: 0,
    sessionId: null,
    records: [],
    subs: new Set(),
    timer: null,
    reading: false,
  };
  entries.set(key, entry);
  return entry;
}

function emit(entry: Entry) {
  for (const fn of entry.subs) fn();
}

function parse(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // The backend holds back a half-written record until its newline
      // lands, so a line that still won't parse is genuinely malformed.
      // Skipping it costs one event; throwing would cost the transcript.
    }
  }
  return out;
}

async function read(entry: Entry): Promise<number> {
  const reader = READERS[entry.agentId];
  if (!reader) return ABSENT_MS;
  const chunk = await reader(entry.repoRoot, entry.path, entry.offset);

  if (!chunk.path) {
    // No record for this repo yet. The agent may not have started writing.
    return ABSENT_MS;
  }

  const fresh = parse(chunk.lines);
  // `reset` means the record rotated (a new session) or was truncated
  // underneath us — what we accumulated belongs to a conversation that is no
  // longer the one on screen.
  entry.records = chunk.reset ? fresh : entry.records.concat(fresh);
  entry.path = chunk.path;
  entry.offset = chunk.offset;
  entry.sessionId = chunk.session_id;

  if (chunk.reset || fresh.length > 0) emit(entry);
  return fresh.length > 0 ? STREAMING_MS : IDLE_MS;
}

function schedule(entry: Entry, delay: number) {
  if (entry.subs.size === 0) return;
  entry.timer = setTimeout(() => {
    void pump(entry);
  }, delay);
}

async function pump(entry: Entry) {
  entry.timer = null;
  if (entry.reading || entry.subs.size === 0) return;
  entry.reading = true;
  let next = IDLE_MS;
  try {
    next = await read(entry);
  } catch {
    // A failed read is not a reason to stop watching — the file may be
    // mid-rotation. Back off to the idle cadence and try again.
    next = IDLE_MS;
  } finally {
    entry.reading = false;
  }
  schedule(entry, next);
}

/** Tail this agent's record for this repo, for as long as the caller is
 *  mounted. `supported` is false for every engine that has no record to read,
 *  and the poll does not exist for those — the caller keeps its PTY view. */
export function useAgentRecord(
  agentId: string,
  repoRoot: string | null,
): { records: unknown[]; sessionId: string | null; supported: boolean } {
  const [, force] = useState(0);
  const supported = hasAgentRecord(agentId);
  const watching = supported ? repoRoot : null;

  useEffect(() => {
    if (!watching) return;
    const entry = ensure(agentId, watching);
    const fn = () => force((n) => n + 1);
    entry.subs.add(fn);
    // First read is immediate: a chat that takes a second to appear reads as
    // broken, and re-reading from a known offset costs nothing.
    if (!entry.timer && !entry.reading) void pump(entry);
    return () => {
      entry.subs.delete(fn);
      if (entry.subs.size === 0 && entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    };
  }, [agentId, watching]);

  if (!watching) return { records: [], sessionId: null, supported };
  const entry = entries.get(keyOf(agentId, watching));
  return {
    records: entry?.records ?? [],
    sessionId: entry?.sessionId ?? null,
    supported,
  };
}

/** Drop what we've accumulated for an agent in a repo. The file on disk is
 *  unaffected — the next read starts over from the top of whichever record is
 *  current. */
export function forgetAgentRecord(agentId: string, repoRoot: string) {
  const key = keyOf(agentId, repoRoot);
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entries.delete(key);
}
