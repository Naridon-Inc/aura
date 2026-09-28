// Keep a Claude tab's Chat view on the conversation its CLI is actually in.
//
// A PTY tab shows one process two ways: the terminal is the CLI itself, the
// Chat view reads the CLI's transcript JSONL. Which JSONL used to be decided
// once, when the tab mounted, and tailed for the life of the tab. But the
// conversation inside the CLI is not fixed — `/resume` moves the same process
// onto another session's transcript and `/clear` starts a fresh one — so after
// either, the terminal showed one conversation and the Chat view another, with
// nothing to reconcile them.
//
// The backend answers "which conversation is this PTY's CLI in" from Claude
// Code's own per-process registry (`agent_pty_claude_session`). This module is
// the frontend half: decide when the chat has to move, and keep asking.

import type { LiveClaudeSession } from "./api";

/** What a tab's Chat view is reading: a Claude session and its transcript.
 *  `filePath` is null while that session has nothing on disk yet. */
export type ChatBinding = { sessionId: string; filePath: string | null };

/** The binding before anything is known — every real session differs from it. */
export const NO_BINDING: ChatBinding = { sessionId: "", filePath: null };

/** How often a tab asks which conversation its CLI is in. A switch shows up in
 *  the chat within this long; each ask is a directory read of a dozen tiny
 *  files, so it is cheap enough to do often. */
export const FOLLOW_INTERVAL_MS = 1500;

/** Where the chat must go next, or null to stay where it is.
 *
 *  No answer from the CLI (`live` null) is never a reason to move: that is a
 *  daemon-backed tab, an older Claude Code, or a CLI still starting, and the
 *  chat keeps what it has. A different session is the switch itself. The same
 *  session gaining a transcript is the tail end of a `/clear`: Claude writes
 *  the file with the first prompt, and the chat can only start reading then. */
export function followDecision(
  bound: ChatBinding,
  live: LiveClaudeSession | null,
): ChatBinding | null {
  if (!live || !live.session_id) return null;
  if (live.session_id !== bound.sessionId)
    return { sessionId: live.session_id, filePath: live.file_path };
  if (live.file_path && live.file_path !== bound.filePath)
    return { sessionId: live.session_id, filePath: live.file_path };
  return null;
}

// Which Claude session each transcript channel's events came from. Module
// scope on purpose, the same lifetime as the event store it describes: a tab
// that remounts finds its channel still full, and has to know whose
// conversation that is before it decides to keep it.
const channelSession = new Map<string, string>();

export function noteTranscriptSession(channel: string, sessionId: string) {
  channelSession.set(channel, sessionId);
}

export function transcriptSessionOf(channel: string): string | undefined {
  return channelSession.get(channel);
}

export function forgetTranscriptSession(channel: string) {
  channelSession.delete(channel);
}

/** Should `channel` be reloaded from `target`'s transcript?
 *
 *  An empty channel always is — that is the remount-with-nothing-cached case.
 *  A full one is kept, so a brief detach or a turn in flight is never
 *  clobbered, UNLESS its events are known to belong to another conversation:
 *  keeping those is exactly the stale chat this module exists to prevent. */
export function needsReplay(
  eventCount: number,
  channelSessionId: string | undefined,
  target: string,
): boolean {
  if (eventCount === 0) return true;
  return channelSessionId !== undefined && channelSessionId !== target;
}

/** Ask `probe` which conversation the CLI is in every `intervalMs`, and hand
 *  each move to `rebind`. One ask at a time: a slow transcript load finishes
 *  before the next ask starts, so two moves never race each other. A failed
 *  ask or move is retried on the next tick against the binding that actually
 *  took. Returns the stop function. */
export function followClaudeSession(opts: {
  initial: ChatBinding;
  probe: () => Promise<LiveClaudeSession | null>;
  rebind: (next: ChatBinding) => Promise<void>;
  intervalMs?: number;
}): () => void {
  const intervalMs = opts.intervalMs ?? FOLLOW_INTERVAL_MS;
  let bound = opts.initial;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      const next = followDecision(bound, await opts.probe());
      if (next && !stopped) {
        await opts.rebind(next);
        bound = next;
      }
    } catch {
      /* the next tick asks again */
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
