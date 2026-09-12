// What to say when the Aura Pro usage read fails.
//
// AURA-265's sibling, AURA-266: Brain & models showed `Aura Pro · Signed in`
// and, directly beneath, `Couldn't load your usage.` — with no reason, no
// time, and a Refresh that produced the same eight words five seconds later.
// The detail was not missing; it was deliberately withheld. The panel only
// printed `err` when there was *also* a quota or an expired session to hang
// it on, so the one case with nothing else on screen was the one case that
// said nothing at all.
//
// `kind` comes off the backend (`AuraProQuotaError`) and is already precise:
// `offline` never reached the cloud, `server` reached it and the answer was
// unusable, `unsupported` means this build has no Aura Pro brain in it, and
// `unauthorized` is handled elsewhere because it is the only one signing in
// again can mend.

export type QuotaFailure = {
  /** The sentence in place of the number. */
  title: string;
  /** What to do about it, or null when there is nothing useful to add. */
  hint: string | null;
  /** Whether pressing Refresh could plausibly change the answer. */
  retryable: boolean;
};

export function quotaFailure(kind: string | null | undefined): QuotaFailure {
  switch (kind) {
    case "offline":
      return {
        title: "Aura couldn’t reach the cloud.",
        hint: "Your usage is still counting — this is only the reading of it.",
        retryable: true,
      };
    case "server":
      return {
        title: "The cloud didn’t answer with a usable number.",
        hint: "Nothing on this machine needs fixing. Try again in a minute.",
        retryable: true,
      };
    case "unsupported":
      return {
        // Not a failure the reader caused and not one Refresh can mend.
        title: "This build of Aura can’t show Aura Pro usage.",
        hint: "Update Aura and it comes back.",
        retryable: false,
      };
    default:
      return {
        title: "Couldn’t load your usage.",
        hint: null,
        retryable: true,
      };
  }
}

/** "Last tried just now" / "Last tried 2m ago".
 *
 *  Present so a Refresh that fails the same way is visibly a *new* attempt.
 *  Without it the screen is byte-identical before and after the press, which
 *  is what made the button read as inert. */
export function lastTriedLabel(atMs: number | null, nowMs: number): string | null {
  if (atMs == null) return null;
  const secs = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (secs < 5) return "Last tried just now";
  if (secs < 60) return `Last tried ${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `Last tried ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `Last tried ${hrs}h ago`;
}
