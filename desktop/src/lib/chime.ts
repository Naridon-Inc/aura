// In-app notification chimes — short synthesized tones for chat / huddle
// events. Built on the Web Audio API so there are NO bundled audio assets to
// load (CSP-safe) and no network. Each sound is a tiny 1–3 note motif with a
// soft exponential attack/release so it reads as a gentle "ping", never a
// harsh beep.
//
// This is the FOCUSED-window counterpart to the OS notification's own `sound`
// (which only fires while the app is unfocused). Together they mean a new
// message is audible whether or not the user is looking at Aura. Muting is a
// user preference persisted in localStorage; `playChime()` no-ops when muted
// or when the browser hasn't granted an audio context yet.

export type ChimeKind = "message" | "mention" | "huddle" | "send";

const MUTE_KEY = "aura.chime.muted";

let ctx: AudioContext | null = null;

/** Lazily create (and resume) a shared AudioContext. Returns null when audio
 *  isn't available — outside a browser, or before the platform grants one. */
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    // A context that started suspended (no user gesture yet) resumes silently
    // once the platform allows it — best-effort, ignore the rejection.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function isChimeMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setChimeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* preference unavailable — sound just stays at its current state */
  }
}

// A note is [frequencyHz, startOffsetSec, durationSec, peakGain].
type Note = [number, number, number, number];

const MOTIFS: Record<ChimeKind, Note[]> = {
  // Two rising notes — a friendly "you got a message".
  message: [
    [659.25, 0, 0.16, 0.13],
    [880, 0.085, 0.2, 0.11],
  ],
  // Three brighter notes — "someone @mentioned you"; more insistent.
  mention: [
    [659.25, 0, 0.13, 0.14],
    [880, 0.075, 0.13, 0.13],
    [1174.66, 0.16, 0.24, 0.12],
  ],
  // Warm perfect-fifth swell — "a huddle started / someone joined".
  huddle: [
    [523.25, 0, 0.3, 0.12],
    [783.99, 0.02, 0.34, 0.1],
  ],
  // Very short soft blip — local "message sent" acknowledgement.
  send: [[720, 0, 0.08, 0.06]],
};

/** Play a short chime for the given event kind. No-ops when muted or when no
 *  audio context is available. Never throws. */
export function playChime(kind: ChimeKind): void {
  if (isChimeMuted()) return;
  const ac = audio();
  if (!ac) return;
  try {
    const now = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = 1;
    master.connect(ac.destination);
    for (const [freq, off, dur, peak] of MOTIFS[kind]) {
      const osc = ac.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ac.createGain();
      const t0 = now + off;
      // Soft attack + exponential release — no click, no harshness.
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }
  } catch {
    /* audio scheduling failed — a missed chime is never worth surfacing */
  }
}
