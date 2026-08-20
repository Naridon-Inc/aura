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
//
// This is the most frequently fired sound in the app — every turn of every
// agent ends with one. That makes it the sound that most badly needs to let go
// of the audio device afterwards, which is why the context comes from
// `audioOutput` rather than being owned here. See that module's header for
// what a permanently-running context does to connected AirPods.

import { playOutputSound } from "./audioOutput";

const PREF_KEY = "aura.sound.completion";

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

/** Play one short two-note rise. No-op when the pref is off, when the
 *  Web Audio API is unavailable, or within the dedupe window. Always
 *  fire-and-forget — a failed chime must never break a turn. */
export function playCompletionChime(): void {
  if (!completionSoundEnabled()) return;
  const now = Date.now();
  if (now - lastPlayed < DEDUPE_MS) return;
  lastPlayed = now;

  playOutputSound((ac, t0) => {
    // A gentle major third (E5 → G#5), each a soft sine with a quick
    // attack and an exponential tail — calm, not a jarring alert.
    const notes: Array<{ freq: number; at: number; dur: number }> = [
      { freq: 659.25, at: 0, dur: 0.16 },
      { freq: 830.61, at: 0.11, dur: 0.22 },
    ];
    let endsAt = t0;
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
      const stopAt = start + n.dur + 0.02;
      osc.stop(stopAt);
      // The context outlives the chime, so the graph has to be swept or a
      // day of agent turns leaves hundreds of dead nodes hanging off it.
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          /* already torn down */
        }
      };
      if (stopAt > endsAt) endsAt = stopAt;
    }
    return endsAt;
  });
}
