// Short "system bell" blip for xterm BEL (`\a`) bytes, gated by the
// terminal.bell pref (settingsStore). WebAudio so there's no asset to
// bundle; a shared AudioContext is created lazily on first use — by then
// the terminal has long since had a user gesture, so the autoplay policy
// is satisfied.

let ctx: AudioContext | null = null;

export function playTerminalBell() {
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.04, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  } catch {
    /* audio unavailable — best-effort */
  }
}
