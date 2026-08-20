// Thin, fire-and-forget wrapper over the telemetry backend so feature call
// sites stay one-liners. Everything is consent- and key-gated in telemetry.rs,
// so calling these freely is safe: nothing leaves the machine until the user
// has opted in, and never anything but the fixed scalar fields we pass here.
//
// Keep `feature` (and any extra props) to short, stable, content-free tokens —
// they become PostHog property values. Never pass file paths, repo names,
// prompt text, code, or anything a person typed.

import { api } from "./api";
import { isIgnorableThrow } from "./runtimeNoise";

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

// ── Activation ────────────────────────────────────────────────────────────
//
// The one question every other number depends on: of the people who install
// Aura, how many reach the point where it does something for them? A funnel
// only answers that if each step is counted once per install — otherwise a
// user who opens ten projects looks like ten people who got halfway.

/** The ordered steps from "it launched" to "Aura did the thing it is for". */
export type ActivationStep =
  | "consent_answered"
  | "project_opened"
  | "agent_started"
  | "intent_logged";

/** Record an activation step, once per install, forever. */
export function trackActivation(
  step: ActivationStep,
  props?: Record<string, string | number | boolean>,
): void {
  void api
    .telemetryTrackOnce(`activation:${step}`, "flow_step", {
      flow: "activation",
      step,
      ...(props ?? {}),
    })
    .catch(() => {
      /* best-effort */
    });
}

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Record that something broke, by shape only. `where` names the surface and
 * `kind` the class of failure (an error's constructor name, a status code) —
 * never the message, which routinely carries paths, prompts and repo names.
 * A count of "the PR pane failed to load, TypeError" is enough to find a bug
 * and carries nothing about the person who hit it.
 */
export function trackError(where: string, kind: string): void {
  void api
    .telemetryTrack("app_error", { where, kind })
    .catch(() => {
      /* best-effort */
    });
}

/** Classify a thrown value without touching its message. */
export function errorKind(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  if (err === null) return "null";
  return typeof err;
}

/**
 * Report uncaught errors and unhandled promise rejections. Installed once at
 * boot: until now a crash in the webview left no trace anywhere, so a whole
 * surface could be broken in the field and look perfectly healthy from here.
 */
export function installErrorReporting(): void {
  window.addEventListener("error", (e) => {
    if (isIgnorableThrow(e.error ?? e.message)) return;
    trackError("window", errorKind(e.error));
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (isIgnorableThrow(e.reason)) return;
    trackError("promise", errorKind(e.reason));
  });
}
