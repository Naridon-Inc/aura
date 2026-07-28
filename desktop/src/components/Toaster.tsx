// The single mount point for the general toast store (`lib/toast.ts`). Renders
// the live stack bottom-right. Each auto-dismissing toast's close button draws a
// countdown ring that drains over the toast's lifetime and pauses while the
// card is hovered — so a toast never vanishes out from under a reader. Sticky
// toasts (durationMs: null) show a plain close button.
//
// The card itself is `ui/toast` — the shape every notification host in the app
// shares. This file only owns the store subscription and the action wiring.
//
// Mount once, near the root:  <Toaster />

import { useEffect, useState } from "react";
import { toast, type Toast, type ToastAction } from "../lib/toast";
import {
  ToastActionButton,
  ToastCard,
  ToastRingKeyframes,
  ToastStack,
} from "./ui/toast";

/** Subscribe to the toast store. */
function useToasts(): Toast[] {
  const [list, setList] = useState<Toast[]>(() => toast.get());
  useEffect(() => toast.subscribe(setList), []);
  return list;
}

function ActionButton({ action, onAfter }: { action: ToastAction; onAfter: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <ToastActionButton
      variant={action.variant === "primary" ? "primary" : "default"}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await action.onClick();
          if (!action.keepOpen) onAfter();
        } finally {
          setBusy(false);
        }
      }}
    >
      {action.label}
    </ToastActionButton>
  );
}

function ToastRow({ t }: { t: Toast }) {
  const [paused, setPaused] = useState(false);
  const [entered, setEntered] = useState(false);
  const dismiss = () => toast.dismiss(t.id);

  // Slide/fade in on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <ToastCard
      tone={t.tone}
      role={t.tone === "danger" ? "alert" : "status"}
      title={t.title}
      message={t.message}
      icon={t.icon}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onDismiss={t.dismissible ? dismiss : undefined}
      durationMs={t.durationMs}
      paused={paused}
      className={
        entered
          ? "translate-y-0 opacity-100 transition-[opacity,transform] duration-150 ease-out"
          : "translate-y-2 opacity-0 transition-[opacity,transform] duration-150 ease-out"
      }
      actions={
        t.actions && t.actions.length > 0
          ? t.actions.map((a, i) => <ActionButton key={i} action={a} onAfter={dismiss} />)
          : undefined
      }
    />
  );
}

export function Toaster() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <ToastStack reverse zIndex={9999}>
      {toasts.map((t) => (
        <ToastRow key={t.id} t={t} />
      ))}
      <ToastRingKeyframes />
    </ToastStack>
  );
}
