// Soundboard player.
//
// `playClipForActiveCall(clipId)` reads the bytes from the Tauri side,
// decodes them via an AudioContext, ships them into the live LiveKit
// room as a one-shot LocalAudioTrack, and unpublishes when the clip
// finishes.
//
// Why an AudioContext route instead of just <audio>.play() locally?
// LiveKit needs a MediaStreamTrack to publish, and there's no portable
// way to turn an HTMLAudioElement output into a MediaStream other than
// AudioContext.createMediaStreamDestination(). The route is:
//
//   bytes  →  decodeAudioData → AudioBufferSourceNode → MediaStreamDest
//                                                        ↓
//                              new LocalAudioTrack(destination.audio)
//                                                        ↓
//                                room.localParticipant.publishTrack
//
// Remote participants hear it as a second audio track on the local
// participant. We could also mix it with the mic via a GainNode chain
// — leaving that for later; the dual-track approach works on the
// receiver side without any custom subscription logic.

import { LocalAudioTrack, type LocalParticipant } from "livekit-client";
import { api, type SoundboardClip } from "./api";

// Minimal duck type for the LiveKit LocalParticipant — typing exactly
// against `LocalParticipant` here would force every caller to import
// `livekit-client` just to satisfy the signature. We only need the two
// publish/unpublish methods at runtime.
type SoundboardParticipant = Pick<
  LocalParticipant,
  "publishTrack" | "unpublishTrack"
>;

// AudioContext is heavy; reuse one across plays. Re-create on resume
// if the OS suspended it (browser autoplay policies).
let audioCtx: AudioContext | null = null;
function ctx(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Hold one publication per clip play so an overlapping play (user
// presses two hotkeys quickly) doesn't cancel the first.
type ActivePlay = {
  source: AudioBufferSourceNode;
  destination: MediaStreamAudioDestinationNode;
  track: LocalAudioTrack | null;
};
const active = new Set<ActivePlay>();

export async function listSoundboardClips(
  repoRoot: string,
): Promise<SoundboardClip[]> {
  return api.soundboardList(repoRoot);
}

export async function uploadSoundboardClip(
  repoRoot: string,
  file: File,
): Promise<SoundboardClip> {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const nameRoot = file.name.replace(/\.[^.]+$/, "");
  const buf = await file.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buf));
  return api.soundboardUpload(repoRoot, nameRoot, ext, bytes);
}

export async function deleteSoundboardClip(
  repoRoot: string,
  clipId: string,
): Promise<void> {
  return api.soundboardDelete(repoRoot, clipId);
}

/** Play a clip for everyone in the active LiveKit call. Returns a
 *  promise that resolves when the clip finishes (or rejects if the
 *  read / decode / publish fails). The caller can also fire-and-forget. */
export async function playSoundboardClip(
  repoRoot: string,
  clipId: string,
  localParticipant: SoundboardParticipant | null,
): Promise<void> {
  if (!localParticipant) {
    throw new Error("soundboard: no active LiveKit participant");
  }
  const raw = await api.soundboardRead(repoRoot, clipId);
  const bytes = new Uint8Array(raw);
  const arr = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const decoded = await ctx().decodeAudioData(arr);

  const destination = ctx().createMediaStreamDestination();
  const source = ctx().createBufferSource();
  source.buffer = decoded;
  source.connect(destination);
  // Also play locally so the sender hears it (LiveKit doesn't loop
  // back published tracks to the publisher).
  source.connect(ctx().destination);

  const audioTrack = destination.stream.getAudioTracks()[0];
  if (!audioTrack) {
    throw new Error("soundboard: no audio track from destination");
  }
  const liveTrack = new LocalAudioTrack(audioTrack);
  const play: ActivePlay = { source, destination, track: liveTrack };
  active.add(play);

  await localParticipant.publishTrack(liveTrack);

  return new Promise<void>((resolve) => {
    source.onended = () => {
      try {
        localParticipant.unpublishTrack(liveTrack, true);
      } catch (e) {
        console.warn("soundboard: unpublishTrack failed", e);
      }
      try {
        source.disconnect();
        destination.disconnect();
      } catch {
        /* fine */
      }
      active.delete(play);
      resolve();
    };
    source.start();
    // Hard cap at 10s — soundboard clips should be short; if the clip
    // is longer we still stop publishing so we don't accidentally
    // broadcast a song through the SFU.
    window.setTimeout(() => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }, 10_000);
  });
}

/** Stop any in-flight clips. Used when the call ends. */
export function stopAllSoundboardClips(): void {
  for (const play of active) {
    try {
      play.source.stop();
    } catch {
      /* ignore */
    }
  }
  active.clear();
}

// --- Built-in seed clips ---------------------------------------------------
//
// Three procedural clips synthesized via AudioContext at play-time. They
// always appear before user-uploaded clips in the popover. No file storage
// needed — the audio is generated on demand from a small descriptor.

type SeedClip = {
  id: string;
  name: string;
  emoji: string;
  /** Build the AudioBuffer for this seed at the given context's sample rate. */
  build: (sampleRate: number) => AudioBuffer;
};

function makeBuffer(
  sampleRate: number,
  durationSec: number,
  fn: (t: number, i: number) => number,
): AudioBuffer {
  const len = Math.floor(sampleRate * durationSec);
  const buf = ctx().createBuffer(1, len, sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = fn(i / sampleRate, i);
  }
  return buf;
}

function envelope(t: number, dur: number): number {
  // Short attack, then linear decay to silence over the clip duration.
  const attack = 0.005;
  if (t < attack) return t / attack;
  return Math.max(0, 1 - (t - attack) / (dur - attack));
}

const SEEDS: SeedClip[] = [
  {
    id: "seed-boop",
    name: "Boop",
    emoji: "🔔",
    build: (sr) =>
      makeBuffer(sr, 0.12, (t) => {
        const env = envelope(t, 0.12);
        return 0.4 * env * Math.sign(Math.sin(2 * Math.PI * 880 * t));
      }),
  },
  {
    id: "seed-fanfare",
    name: "Fanfare",
    emoji: "🎉",
    build: (sr) =>
      makeBuffer(sr, 0.45, (t) => {
        const notes = [261.63, 329.63, 392.0, 523.25];
        const step = Math.min(notes.length - 1, Math.floor(t / 0.11));
        const freq = notes[step];
        const localT = t - step * 0.11;
        const env = envelope(localT, 0.11);
        // Triangle wave for a warmer attack than sine.
        const phase = 2 * Math.PI * freq * t;
        const tri = (2 / Math.PI) * Math.asin(Math.sin(phase));
        return 0.35 * env * tri;
      }),
  },
  {
    id: "seed-sad-trombone",
    name: "Sad Trombone",
    emoji: "😢",
    build: (sr) =>
      makeBuffer(sr, 0.6, (t) => {
        const freq = 320 - (t / 0.6) * 160;
        const env = envelope(t, 0.6);
        return 0.35 * env * Math.sin(2 * Math.PI * freq * t);
      }),
  },
];

export type SoundboardSeed = {
  id: string;
  name: string;
  emoji: string;
};

export function listSoundboardSeeds(): SoundboardSeed[] {
  return SEEDS.map((s) => ({ id: s.id, name: s.name, emoji: s.emoji }));
}

export async function playSoundboardSeed(
  seedId: string,
  localParticipant: SoundboardParticipant | null,
): Promise<void> {
  if (!localParticipant) {
    throw new Error("soundboard: no active LiveKit participant");
  }
  const seed = SEEDS.find((s) => s.id === seedId);
  if (!seed) throw new Error(`soundboard: unknown seed ${seedId}`);

  const decoded = seed.build(ctx().sampleRate);

  const destination = ctx().createMediaStreamDestination();
  const source = ctx().createBufferSource();
  source.buffer = decoded;
  source.connect(destination);
  source.connect(ctx().destination);

  const audioTrack = destination.stream.getAudioTracks()[0];
  if (!audioTrack) throw new Error("soundboard: no audio track");
  const liveTrack = new LocalAudioTrack(audioTrack);
  const play: ActivePlay = { source, destination, track: liveTrack };
  active.add(play);

  await localParticipant.publishTrack(liveTrack);
  return new Promise<void>((resolve) => {
    source.onended = () => {
      try {
        localParticipant.unpublishTrack(liveTrack, true);
      } catch {
        /* ignore */
      }
      try {
        source.disconnect();
        destination.disconnect();
      } catch {
        /* ignore */
      }
      active.delete(play);
      resolve();
    };
    source.start();
  });
}
