// Replaying the recorded wire into the store the components read.
//
// `wire-recording.json` is captured off a real socket by
// `aura-cloud/tests/e2e/run.sh` — a real server, a real Postgres, real clients
// — and tagged with which peer received each frame. Both the assertions in
// `../wire.test.ts` and the visual harness in `../__harness__` fold it through
// here, so the screenshots and the tests are looking at the same state rather
// than at two separately-invented approximations of it.

import recording from "./wire-recording.json";
import { applyFrame, ensureEntry, sessions } from "../../../lib/sessionLiveRegistry";
import { parseServerFrame } from "../../../lib/sessionLiveParse";
import type { SessionLiveState } from "../../../lib/sessionLiveModel";

export type RecordedFrame = { peer: string; frame: Record<string, unknown> };

export const RECORDED = recording.frames as RecordedFrame[];
export const SESSION_ID = recording.session;

/** Peers in the recording, in the order they first appear. */
export function peers(): string[] {
  const seen: string[] = [];
  for (const { peer } of RECORDED) if (!seen.includes(peer)) seen.push(peer);
  return seen;
}

export type Replay = {
  /** State after the peer's last frame. */
  final: SessionLiveState;
  /** State after each frame, oldest first. */
  steps: SessionLiveState[];
};

/**
 * Replay one peer's frames into a fresh store entry, exactly as the live client
 * would, keeping the state after every frame as well as the last one.
 *
 * The steps are not bookkeeping. A session is a sequence of moments and the
 * interesting screens are in the middle of it: the guest in this recording is a
 * watcher for a while and then gets promoted, so "what a watcher sees" is a
 * state that exists partway through and is gone by the end. Looking only at the
 * final state would quietly show the wrong screen and still look fine.
 */
export function replay(peer: string): Replay {
  const id = `${SESSION_ID}:${peer}`;
  sessions.delete(id);
  const entry = ensureEntry(id);
  const steps: SessionLiveState[] = [];
  for (const rec of RECORDED) {
    if (rec.peer !== peer) continue;
    const frame = parseServerFrame(rec.frame);
    if (!frame) continue;
    applyFrame(entry, frame);
    steps.push(entry.state); // replaced, never mutated — safe to keep
  }
  return { final: entry.state, steps };
}

/** The last moment the predicate held — the screen just before it changed. */
export function lastWhere(
  steps: readonly SessionLiveState[],
  pred: (s: SessionLiveState) => boolean,
): SessionLiveState {
  const hit = [...steps].reverse().find(pred);
  if (!hit) throw new Error("the recording never reached that state");
  return hit;
}
