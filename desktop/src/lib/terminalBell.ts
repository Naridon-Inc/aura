// Short "system bell" blip for xterm BEL (`\a`) bytes, gated by the
// terminal.bell pref (settingsStore). WebAudio so there's no asset to
// bundle.
//
// This is the highest-frequency sound in the app after the completion chime —
// every agent CLI in every terminal pane rings it, sometimes several times a
// minute. The AudioContext therefore does NOT live here: it comes from
// `audioOutput`, which suspends it once the blip has decayed so Aura stops
// holding the Mac's audio route between bells. A held route is what makes
// connected AirPods bounce between the Mac and the phone — see the header of
// `audioOutput.ts`.

import { playOutputSound } from "./audioOutput";

export function playTerminalBell() {
  playOutputSound((ctx, t0) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.04, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    const stopAt = t0 + 0.16;
    osc.stop(stopAt);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* already torn down */
      }
    };
    return stopAt;
  });
}
