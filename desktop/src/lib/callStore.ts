// Singleton snapshot of the currently-live huddle, published by
// CallPanel and consumed by:
//
//   1. StatusBar (CallStatusPill) — persistent mic/leave control,
//      visible from any workpane while a call is active.
//   2. ScreenshareTab workpane — attaches the active LiveKit screen
//      track to a full-area <video> element.
//
// Why a singleton instead of React Context: the call lives at the App
// root inside <CallPanel>, but the StatusBar and any open workpane sit
// in completely different subtrees with no shared provider. Lifting
// <LiveKitRoom> to wrap everything would require restructuring App.tsx
// and risk re-mounting the SFU connection on unrelated re-renders. A
// useSyncExternalStore-backed singleton gives every consumer the same
// snapshot without a single new render boundary.
//
// The store holds *references* to LiveKit Track objects (not raw
// MediaStreamTracks). Consumers call `track.attach(el)` / `track.detach(el)`
// directly, which is the standard LiveKit pattern and the same one
// used by <VideoTrack> / <ParticipantTile> internally.
//
// State is cleared on `leave()` — there's no persistence here. A
// reload mid-call drops the singleton; CallPanel's own reconnect path
// (via the channel-list rejoin button) is what rehydrates it.
//
// Mic toggle + leave are exposed as imperative functions so the pill
// doesn't need to dispatch synthetic events back into CallPanel — the
// store calls into the LiveKit LocalParticipant directly when present.

import { useSyncExternalStore } from "react";
import type { LocalParticipant, Track } from "livekit-client";

export type CallScreenshareTrack = {
  /** Stable identifier — `<participantSid>:<trackSid>`. The
   *  ScreenshareTab uses this as a React key and the workpane id
   *  suffix so swapping which participant is sharing doesn't reuse
   *  the same <video> element (LiveKit's attach() is per-element). */
  key: string;
  /** Display name of the sharer (falls back to identity, then
   *  "Someone"). Shown in the workpane title strip and the pill's
   *  share badge. */
  participantName: string;
  /** Raw LiveKit Track. Consumer calls `track.attach(el)` to bind
   *  the MediaStream to a <video>. Stays the same instance across
   *  snapshot updates so the <video>'s effect can skip re-attach. */
  track: Track;
  /** True when the local user is the publisher (used by the pill +
   *  workpane to badge "you're sharing"). */
  isLocal: boolean;
};

export type CallSnapshot = {
  /** Are we currently joined to a LiveKit room? Token mint /
   *  connect-in-progress is reflected as `connecting`. */
  active: boolean;
  /** Spinner-state — the token is being minted or LiveKitRoom is
   *  still connecting. `active` flips true once HuddleUI mounts. */
  connecting: boolean;
  /** Repo root the huddle is scoped to — needed for the open-channel
   *  click-through from the pill. */
  repoRoot: string | null;
  /** `#channel` slug (without the leading hash). */
  channel: string | null;
  /** Display name for the channel (CommsPanel may pretty-print it). */
  channelName: string | null;
  /** Mirror of `LocalParticipant.isMicrophoneEnabled`. Drives the
   *  pill's mic/muted glyph. */
  micEnabled: boolean;
  /** Mirror of `LocalParticipant.isScreenShareEnabled`. */
  screenshareEnabled: boolean;
  /** Mirror of `LocalParticipant.isCameraEnabled`. Drives the dock's
   *  camera button on/off tint and gates the call-stage camera tile. */
  cameraEnabled: boolean;
  /** All currently-subscribed screenshare tracks (local + remote).
   *  Empty until someone shares. ScreenshareTab picks the first
   *  entry; the pill shows a count badge when >0. */
  screenshareTracks: CallScreenshareTrack[];
};

const EMPTY: CallSnapshot = {
  active: false,
  connecting: false,
  repoRoot: null,
  channel: null,
  channelName: null,
  micEnabled: false,
  screenshareEnabled: false,
  cameraEnabled: false,
  screenshareTracks: [],
};

let snapshot: CallSnapshot = EMPTY;
const subs = new Set<() => void>();
// Held only while a LiveKitRoom is connected — used by the pill's
// imperative mic-toggle / leave handlers. Cleared on `clearCall()`.
let liveLocalParticipant: LocalParticipant | null = null;
// Monotonic epoch — bumped on clearCall + setCallConnecting so an
// in-flight publishCallState() from a pre-unmount render can't land
// after the room was torn down (the bug that left the leave-button
// stuck "in call" until app restart). HuddleUI captures the epoch on
// mount via `currentCallEpoch()` and passes it to every publishCallState
// — late writes whose epoch is stale get dropped.
let epoch = 0;
// Mic level (0..1). Lives in its own atom because it changes ~10 Hz
// and we don't want to re-render every CallSnapshot consumer at that
// rate. Only the VU meter subscribes via useCallMicLevel().
let micLevel = 0;
const micLevelSubs = new Set<() => void>();

function emit() {
  for (const fn of subs) fn();
}

function setSnapshot(next: CallSnapshot) {
  // Identity-equal snapshot returns; useSyncExternalStore relies on
  // reference equality to skip re-renders.
  if (
    next.active === snapshot.active &&
    next.connecting === snapshot.connecting &&
    next.repoRoot === snapshot.repoRoot &&
    next.channel === snapshot.channel &&
    next.channelName === snapshot.channelName &&
    next.micEnabled === snapshot.micEnabled &&
    next.screenshareEnabled === snapshot.screenshareEnabled &&
    next.cameraEnabled === snapshot.cameraEnabled &&
    next.screenshareTracks.length === snapshot.screenshareTracks.length &&
    next.screenshareTracks.every(
      (t, i) =>
        snapshot.screenshareTracks[i] &&
        snapshot.screenshareTracks[i].key === t.key &&
        snapshot.screenshareTracks[i].track === t.track,
    )
  ) {
    return;
  }
  snapshot = next;
  emit();
}

/** CallPanel calls this on `pending` flip — the pill flips into a
 *  "connecting…" state without waiting for the LiveKit handshake. */
export function setCallConnecting(opts: {
  repoRoot: string;
  channel: string;
  channelName: string;
}): void {
  epoch += 1;
  setSnapshot({
    ...EMPTY,
    connecting: true,
    repoRoot: opts.repoRoot,
    channel: opts.channel,
    channelName: opts.channelName,
  });
}

/** Called from HuddleUI on every render (cheap — setSnapshot
 *  deep-compares) to keep the singleton in sync with LiveKit state. */
/** HuddleUI calls this once on mount and passes the returned value to
 *  every publishCallState — late writes (from a pre-unmount render
 *  whose useEffect flushed after clearCall ran) carry a stale epoch
 *  and get dropped. */
export function currentCallEpoch(): number {
  return epoch;
}

export function publishCallState(opts: {
  repoRoot: string;
  channel: string;
  channelName: string;
  micEnabled: boolean;
  screenshareEnabled: boolean;
  cameraEnabled: boolean;
  screenshareTracks: CallScreenshareTrack[];
  localParticipant: LocalParticipant | null;
  epoch?: number;
}): void {
  // Guard against late writes after teardown. clearCall() bumps the
  // global epoch; a HuddleUI render that captured the old epoch will
  // fail this check and skip the resurrection.
  if (opts.epoch !== undefined && opts.epoch !== epoch) return;
  liveLocalParticipant = opts.localParticipant;
  setSnapshot({
    active: true,
    connecting: false,
    repoRoot: opts.repoRoot,
    channel: opts.channel,
    channelName: opts.channelName,
    micEnabled: opts.micEnabled,
    screenshareEnabled: opts.screenshareEnabled,
    cameraEnabled: opts.cameraEnabled,
    screenshareTracks: opts.screenshareTracks,
  });
}

/** HuddleUI publishes mic audio level here at ~10 Hz. Lives in its
 *  own atom so the rest of the snapshot consumers don't re-render at
 *  audio rate. Drops stale-epoch writes too. */
export function publishMicLevel(level: number, callEpoch?: number): void {
  if (callEpoch !== undefined && callEpoch !== epoch) return;
  if (!snapshot.active) {
    // Drop level pings after teardown.
    if (micLevel !== 0) {
      micLevel = 0;
      for (const fn of micLevelSubs) fn();
    }
    return;
  }
  const clamped = Math.max(0, Math.min(1, level));
  if (Math.abs(clamped - micLevel) < 0.01) return;
  micLevel = clamped;
  for (const fn of micLevelSubs) fn();
}

function getMicLevel(): number {
  return micLevel;
}

function subscribeMicLevel(fn: () => void): () => void {
  micLevelSubs.add(fn);
  return () => {
    micLevelSubs.delete(fn);
  };
}

/** Subscribe to the mic VU. Only the StatusBar meter should call this. */
export function useCallMicLevel(): number {
  return useSyncExternalStore(subscribeMicLevel, getMicLevel, getMicLevel);
}

// --- Participant roster (call-stage view) --------------------------------
//
// The main CallSnapshot deliberately omits the full participant list —
// the dock + pill only need screenshare tracks + local toggle state, and
// folding a speaking-rate roster into that snapshot would re-render the
// dock every time someone starts/stops talking. The call-stage view
// (ScreenshareTab upgraded into a grid) is the only surface that needs
// the roster, so it lives in its own atom with its own subscribers —
// same separation the mic-level atom uses. HuddleUI publishes it from
// inside the Room context (the only place LiveKit exposes participants).

export type CallParticipant = {
  /** LiveKit session id — stable React key for the tile. */
  sid: string;
  identity: string;
  /** Display name (name → identity → "Someone"). */
  name: string;
  isLocal: boolean;
  /** Active-speaker flag from LiveKit — drives the green tile ring. */
  isSpeaking: boolean;
  micEnabled: boolean;
  /** Live camera Track when the participant's webcam is on, else null.
   *  The stage attaches it to a <video>; null → avatar-on-gradient. */
  cameraTrack: Track | null;
};

let participants: CallParticipant[] = [];
const participantSubs = new Set<() => void>();

/** HuddleUI publishes the live roster here on every participant /
 *  speaking / camera change. Shallow-equal guard skips no-op emits so
 *  the stage doesn't re-render when nothing visible changed. Drops
 *  stale-epoch writes like the other publishers. */
export function publishCallParticipants(
  list: CallParticipant[],
  callEpoch?: number,
): void {
  if (callEpoch !== undefined && callEpoch !== epoch) return;
  const same =
    list.length === participants.length &&
    list.every((p, i) => {
      const q = participants[i];
      return (
        q !== undefined &&
        q.sid === p.sid &&
        q.name === p.name &&
        q.isSpeaking === p.isSpeaking &&
        q.micEnabled === p.micEnabled &&
        q.cameraTrack === p.cameraTrack
      );
    });
  if (same) return;
  participants = list;
  for (const fn of participantSubs) fn();
}

function getCallParticipants(): CallParticipant[] {
  return participants;
}

function subscribeCallParticipants(fn: () => void): () => void {
  participantSubs.add(fn);
  return () => {
    participantSubs.delete(fn);
  };
}

/** React hook — the call-stage grid subscribes here for the live
 *  roster. Empty array when no call is active. */
export function useCallParticipants(): CallParticipant[] {
  return useSyncExternalStore(
    subscribeCallParticipants,
    getCallParticipants,
    getCallParticipants,
  );
}

/** Reset the singleton when CallPanel tears the room down. Bumps the
 *  epoch so any in-flight publishCallState whose callback was scheduled
 *  before this call (e.g. a pre-unmount HuddleUI render that hadn't
 *  flushed its useEffect yet) drops on the floor. */
export function clearCall(): void {
  epoch += 1;
  liveLocalParticipant = null;
  micLevel = 0;
  participants = [];
  setSnapshot(EMPTY);
  for (const fn of micLevelSubs) fn();
  for (const fn of participantSubs) fn();
}

/** Pill mic toggle — flips the LocalParticipant's mic if we have one.
 *  Returns the requested next state so the caller can optimistically
 *  reflect it (the real value will land via the next publishCallState
 *  tick once LiveKit fires the participant-events). */
export async function toggleCallMic(): Promise<void> {
  const lp = liveLocalParticipant;
  if (!lp) return;
  try {
    await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled);
  } catch (e) {
    console.warn("callStore.toggleCallMic failed", e);
  }
}

/** Dock camera button — publishes / unpublishes the local webcam in the
 *  live room. Huddles start voice-only (`<LiveKitRoom video={false}>`),
 *  so this is the on-demand path that turns the camera on; the new value
 *  lands back in the snapshot via HuddleUI's next publishCallState tick.
 *  No-ops (and the button stays inert) when no call is live. */
export async function toggleCallCamera(): Promise<void> {
  const lp = liveLocalParticipant;
  if (!lp) return;
  try {
    await lp.setCameraEnabled(!lp.isCameraEnabled);
  } catch (e) {
    console.warn("callStore.toggleCallCamera failed", e);
  }
}

// --- Persistent mic + deafen preferences ---------------------------------
//
// The user identity bar owns the source-of-truth for mic-enabled / deafened
// state across calls. We persist both in localStorage so a user who muted
// themselves before joining stays muted at join time, and a user who
// deafened mid-call stays deafened next time too. Defaults:
//   - mic  → enabled  (parity with how huddles started before)
//   - deafen → off
//
// Each setter writes through to LiveKit *if* a call is currently active —
// otherwise it just records the preference for the next join. The CallPanel
// join flow reads `getMicEnabledPreference()` after `LiveKitRoom` connects
// and applies it before LiveKit's default `audio={true}` settles, so the
// stored preference wins.

const MIC_PREF_KEY = "aura.voice.micEnabledDefault";
const DEAFEN_PREF_KEY = "aura.voice.deafenedDefault";

function readBoolPref(key: string, defaultValue: boolean): boolean {
  try {
    const raw =
      typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    if (raw === null) return defaultValue;
    return raw === "true";
  } catch {
    return defaultValue;
  }
}

function writeBoolPref(key: string, value: boolean): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // localStorage can throw in private mode / quota errors — preference
    // simply doesn't persist across reload, but the in-call effect still
    // applies because callers re-call the setter on every toggle.
  }
}

export function getMicEnabledPreference(): boolean {
  return readBoolPref(MIC_PREF_KEY, true);
}

export function getDeafenedPreference(): boolean {
  return readBoolPref(DEAFEN_PREF_KEY, false);
}

/** Persist mic-enabled preference; if a call is live, flip LiveKit too. */
export async function setMicEnabledPreference(enabled: boolean): Promise<void> {
  writeBoolPref(MIC_PREF_KEY, enabled);
  const lp = liveLocalParticipant;
  if (!lp) return;
  try {
    if (lp.isMicrophoneEnabled !== enabled) {
      await lp.setMicrophoneEnabled(enabled);
    }
  } catch (e) {
    console.warn("callStore.setMicEnabledPreference failed", e);
  }
}

/** Persist deafen preference; if a call is live, mute the
 *  <RoomAudioRenderer> audio elements immediately. The dock has its own
 *  effect that re-applies this on a 1s interval to catch new remote
 *  participants joining, so calling this once is enough at toggle time. */
export function setDeafenedPreference(deafened: boolean): void {
  writeBoolPref(DEAFEN_PREF_KEY, deafened);
  if (typeof document === "undefined") return;
  if (!snapshot.active) return;
  const audios = document.querySelectorAll<HTMLAudioElement>(
    "audio[data-lk-source], audio[data-lk-track-source]",
  );
  audios.forEach((el) => {
    el.muted = deafened;
  });
}

/** Pill leave button — dispatches the existing `aura:leave-huddle`
 *  event so CallPanel's hardLeave path runs (unpublish tracks +
 *  room.disconnect + state cleanup). Kept as an event so this module
 *  doesn't need to import React or the call lifecycle directly. */
export function leaveCall(): void {
  window.dispatchEvent(new CustomEvent("aura:leave-huddle"));
}

/** Exposed for soundboard / VU meter / anything that needs to publish
 *  a synthetic track into the active room. Returns null when no call
 *  is live. */
export function liveCallLocalParticipant(): LocalParticipant | null {
  return liveLocalParticipant;
}

/** Compose the stable workpane id for a given huddle. The
 *  ScreenshareTab keys off this so re-sharing inside the same huddle
 *  re-uses the existing tab. */
export function callScreenshareWorkpaneId(
  repoRoot: string,
  channel: string,
): string {
  return `${repoRoot}::${channel}`;
}

/** Parse a workpane id back into `{repoRoot, channel}` — used by the
 *  ScreenshareTab to match the current snapshot. Returns null if the
 *  id is malformed (older persisted layout entries). */
export function parseScreenshareWorkpaneId(
  id: string,
): { repoRoot: string; channel: string } | null {
  const idx = id.indexOf("::");
  if (idx <= 0 || idx >= id.length - 2) return null;
  return { repoRoot: id.slice(0, idx), channel: id.slice(idx + 2) };
}

function getSnapshot(): CallSnapshot {
  return snapshot;
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** React hook — every consumer that wants the live call state. */
export function useCallSnapshot(): CallSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
