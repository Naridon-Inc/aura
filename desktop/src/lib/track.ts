// Thin, fire-and-forget wrapper over the telemetry backend so feature call
// sites stay one-liners. Everything is consent- and key-gated in telemetry.rs,
// so calling these freely is safe: nothing leaves the machine until the user
// has opted in, and never anything but the fixed scalar fields we pass here.
//
// Keep `feature` (and any extra props) to short, stable, content-free tokens —
// they become PostHog property values. Never pass file paths, repo names,
// prompt text, code, or anything a person typed.

import { api } from "./api";

/** Record that a named feature was used (PostHog `feature_used` event). */
export function trackFeature(
  feature: string,
  props?: Record<string, string | number | boolean>,
): void {
  void api.telemetryTrack("feature_used", { feature, ...(props ?? {}) }).catch(
    () => {
      /* best-effort; telemetry must never break a user action */
    },
  );
}

/** Record a step in a multi-step flow (PostHog `flow_step` event). */
export function trackFlow(
  flow: string,
  step: string,
  props?: Record<string, string | number | boolean>,
): void {
  void api
    .telemetryTrack("flow_step", { flow, step, ...(props ?? {}) })
    .catch(() => {
      /* best-effort */
    });
}
