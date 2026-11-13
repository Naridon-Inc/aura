// A toast owned by a component: it is on screen while <LiveToast> is mounted,
// says whatever its props say on every render, and goes when it unmounts. For
// a host whose toast follows its own state (an update that moves from
// "working" to "done", a crash report that opens into its details) — the host
// renders the toast it wants and the store keeps one copy, in its place in
// the stack.
//
//   {phase === "failed" && (
//     <LiveToast id="cli-update" tone="danger" title="…" onDismiss={() => setPhase(null)} />
//   )}
//
// When the person closes it the host hears `onDismiss`, and when its timer
// runs out `onAutoClose`; either way the host should stop rendering it. Until
// it does, the same notice stays closed — a host that renders again a moment
// later (or never listens for the timer) does not put it back. A different
// notice (a new title, tone or id) shows as usual.

import { useEffect, useRef } from "react";
import { toast, type ToastInput } from "../lib/toast";
import { noticeKey, shouldResend } from "../lib/toastTimer";

export function LiveToast({ id, ...input }: ToastInput & { id: string }) {
  // The notice its timer or the person last closed.
  const closed = useRef<string | null>(null);
  const key = noticeKey({ id, tone: input.tone, title: input.title });
  // Every render: the store copy follows the props (callbacks included).
  useEffect(() => {
    if (!shouldResend(closed.current, key)) return;
    closed.current = null;
    toast.show({
      id,
      ...input,
      onDismiss: (t) => {
        closed.current = key;
        input.onDismiss?.(t);
      },
      onAutoClose: (t) => {
        closed.current = key;
        input.onAutoClose?.(t);
      },
    });
  });
  useEffect(() => () => toast.dismiss(id), [id]);
  return null;
}
