// Surfaces a failed huddle start to the user.
//
// The call plumbing (CallPanel) is headless as of v0.2.8 — on a token-mint /
// SFU-connect failure it calls `clearCall()` and broadcasts an
// `aura:huddle-error` CustomEvent, but nothing rendered that event, so the dock
// just fell back to idle and the user saw a huddle silently do nothing. A
// huddle that won't start is almost always a SERVER-side gap (LiveKit URL /
// API key / secret unset, or the SFU unreachable) — `api.callsToken` now throws
// a plain-language reason, and this tiny host makes it visible.
//
// Deliberately minimal: one error toast in the shared stack. It stays until
// closed (a start failure is worth reading, not auto-vanishing). Renders
// nothing itself; mounted once at the app root.

import { useEffect } from "react";
import { toast } from "../lib/toast";

export function HuddleErrorToast() {
  useEffect(() => {
    const onError = (e: Event) => {
      const detail = (e as CustomEvent<{ message?: string }>).detail;
      const message =
        detail && typeof detail.message === "string" && detail.message.trim()
          ? detail.message.trim()
          : "The huddle server didn't answer. Try again in a moment.";
      // The id is the reason, so a repeated identical error (double-fire from
      // the CallPanel + HuddleUI listeners) lands on the one toast instead of
      // stacking a duplicate.
      toast.danger("The huddle didn't start", message, {
        id: `huddle-error:${message}`,
        durationMs: null,
      });
    };
    window.addEventListener("aura:huddle-error", onError as EventListener);
    return () =>
      window.removeEventListener("aura:huddle-error", onError as EventListener);
  }, []);

  return null;
}
