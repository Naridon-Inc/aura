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
// Deliberately minimal: one dismissible card, bottom-right, danger tone. It
// sticks until dismissed (a start failure is worth reading, not auto-vanishing)
// and is mounted once at the app root next to the plugin/crash toast hosts.

import { useEffect, useState } from "react";
import { ToastCard, ToastStack } from "./ui/toast";

type ActiveError = { message: string; key: number };

let nextKey = 1;

export function HuddleErrorToast() {
  const [errors, setErrors] = useState<ActiveError[]>([]);

  useEffect(() => {
    const onError = (e: Event) => {
      const detail = (e as CustomEvent<{ message?: string }>).detail;
      const message =
        detail && typeof detail.message === "string" && detail.message.trim()
          ? detail.message.trim()
          : "The huddle server didn't answer. Try again in a moment.";
      // Collapse a repeated identical error (double-fire from the CallPanel +
      // HuddleUI listeners) into the one card instead of stacking duplicates.
      setErrors((prev) =>
        prev.some((x) => x.message === message)
          ? prev
          : [{ message, key: nextKey++ }, ...prev].slice(0, 3),
      );
    };
    window.addEventListener("aura:huddle-error", onError as EventListener);
    return () =>
      window.removeEventListener("aura:huddle-error", onError as EventListener);
  }, []);

  if (errors.length === 0) return null;

  const dismiss = (key: number) =>
    setErrors((prev) => prev.filter((x) => x.key !== key));

  return (
    <ToastStack zIndex={10000}>
      {errors.map((err) => (
        <ToastCard
          key={err.key}
          tone="danger"
          role="alert"
          title="The huddle didn't start"
          message={err.message}
          onDismiss={() => dismiss(err.key)}
        />
      ))}
    </ToastStack>
  );
}
