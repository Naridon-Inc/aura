// Turn-end completion chime — Aura's analog of Conductor's signature
// "completion sounds" (Conductor 0.52.0). A short, soft two-note rise
// played the moment a turn finishes, so you can look away and still know
// the agent is done.
//
// Cross-agent by design: every turn-end seam fires the same chime —
//   - native Aura brain  → ManagerChatView `manager-stream` done /
//                          `manager-chat-chunk` end
//   - any CLI agent      → agentStreamStore `result` (running → false)
// so it sounds identically whether the turn ran through the native brain
// or Claude / Codex / Gemini / Cursor / Kimi / OpenCode.
//
// Why synthesized (Web Audio) instead of an .mp3 asset: it's a few bytes
// of code, themeable by changing two frequencies, needs no bundling, and
// never blocks on a network/file fetch. The LiveKit `soundboard.ts` route
// is a different beast — it pipes clips into a call; this plays locally.

const PREF_KEY = "aura.sound.completion";

// One shared AudioContext, lazily created on first play. Browsers suspend
// contexts created before a user gesture; we resume on demand. Re-created
// if it ever lands in a closed state.
let ctx: AudioContext | null = null;

// Self-dedupe: two turn-end seams (or a rapid burst of subagent turns) can
// land within a few ms. Swallow a second chime inside this window so the
// user hears one clean tone, not a stack.
let lastPlayed = 0;
const DEDUPE_MS = 700;

/** Whether the completion chime is enabled. Defaults ON — the delight is
 *  the point; an explicit "off" in localStorage opts out. */
export function completionSoundEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Persist the on/off preference. */
export function setCompletionSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* private mode / quota — preference just won't persist */
  }
}

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx || ctx.state === "closed") {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Play one short two-note rise. No-op when the pref is off, when the
 *  Web Audio API is unavailable, or within the dedupe window. Always
 *  fire-and-forget — a failed chime must never break a turn. */
export function playCompletionChime(): void {
  if (!completionSoundEnabled()) return;
  const now = Date.now();
  if (now - lastPlayed < DEDUPE_MS) return;
  lastPlayed = now;

  const ac = ensureCtx();
  if (!ac) return;

  try {
    const t0 = ac.currentTime;
    // A gentle major third (E5 → G#5), each a soft sine with a quick
    // attack and an exponential tail — calm, not a jarring alert.
    const notes: Array<{ freq: number; at: number; dur: number }> = [
      { freq: 659.25, at: 0, dur: 0.16 },
      { freq: 830.61, at: 0.11, dur: 0.22 },
    ];
    for (const n of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = n.freq;
      const start = t0 + n.at;
      const peak = 0.14;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + n.dur + 0.02);
    }
  } catch {
    /* swallow — audio is a nicety, never load-bearing */
  }
}
