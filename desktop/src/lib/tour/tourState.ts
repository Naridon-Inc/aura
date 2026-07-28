// One-time "Get started" tour gate. Mirrors the What's-New show-once idiom
// (lib/releaseNotes): a single localStorage key, set on finish or skip so the
// tour never nags again.
//
// Sequenced AFTER first-run onboarding — it only becomes pending once
// `aura.onboarding.complete` is set, so the tour and the onboarding flow never
// stack on the same launch. That also means the two audiences are covered:
// existing, already-onboarded users (the ones who report the app is hard to
// read) get the tour on their next launch; brand-new users get it the launch
// after they finish onboarding.

const SEEN_KEY = "aura.tour.getStarted.seen";
const ONBOARDING_COMPLETE_KEY = "aura.onboarding.complete";

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Mark the tour seen so it never auto-opens again. */
export function markTourSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode — best-effort; worst case it shows once more */
  }
}

/** Re-arm the auto-run (used by a "reset tips" affordance). Replay from
 *  Settings uses a direct event and does not need this. */
export function resetTourSeen(): void {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Whether to auto-open the tour on this launch: onboarding done + not seen. */
export function tourPending(): boolean {
  try {
    if (localStorage.getItem(ONBOARDING_COMPLETE_KEY) !== "1") return false;
  } catch {
    return false;
  }
  return !tourSeen();
}
