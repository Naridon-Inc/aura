// A tiny, general-purpose toast store. One instance app-wide; `<Toaster/>`
// (mounted once in App) subscribes and renders the stack. Anything can raise a
// toast from anywhere without prop-drilling:
//
//   import { toast } from "../lib/toast";
//   toast.success("Saved", "Your changes are on disk.");
//   toast.show({
//     tone: "accent",
//     title: "New update available",
//     actions: [
//       { label: "See changes", onClick: openNotes },
//       { label: "Restart", variant: "primary", onClick: restart },
//     ],
//     durationMs: null,           // sticky — no auto-dismiss ring
//   });
//
// Toasts with a finite `durationMs` auto-dismiss, and the close button draws a
// countdown ring that drains over that duration (paused while hovered). Sticky
// toasts (durationMs: null) show a plain close button. Pass a stable `id` to
// dedupe/replace an existing toast instead of stacking a duplicate.

import type { ReactNode } from "react";

export type ToastTone = "info" | "success" | "warning" | "danger" | "accent";

export type ToastAction = {
  label: string;
  onClick: () => void | Promise<void>;
  /** `primary` = filled accent button; otherwise a quiet ghost button. */
  variant?: "primary" | "default";
  /** Keep the toast open after the click (default: dismiss on click). Use for
   *  actions that kick off background work the toast should keep narrating. */
  keepOpen?: boolean;
};

export type ToastInput = {
  /** Stable id → calling `show` again with the same id replaces in place
   *  rather than stacking a duplicate. Auto-generated when omitted. */
  id?: string;
  title?: string;
  message?: ReactNode;
  tone?: ToastTone;
  actions?: ToastAction[];
  /** Auto-dismiss after this many ms, showing a draining countdown ring on the
   *  close button. `null` (or 0) = sticky: no timer, plain close button.
   *  Omitted → a sensible default based on tone (see `resolveDuration`). */
  durationMs?: number | null;
  /** Show the close (✕) button. Default true. A non-dismissible sticky toast is
   *  only sensible when an action will dismiss it programmatically. */
  dismissible?: boolean;
  /** Optional leading glyph/element. Falls back to a tone dot. */
  icon?: ReactNode;
};

export type Toast = Required<Pick<ToastInput, "id" | "tone" | "dismissible">> &
  Omit<ToastInput, "id" | "tone" | "dismissible"> & {
    durationMs: number | null;
    createdAt: number;
  };

// Tones that imply "the user probably wants to read/act on this" default to
// sticky; transient confirmations auto-dismiss.
const DEFAULT_DURATIONS: Record<ToastTone, number | null> = {
  success: 5000,
  info: 6000,
  accent: 7000,
  warning: null,
  danger: null,
};

function resolveDuration(input: ToastInput): number | null {
  if (input.durationMs !== undefined) {
    return input.durationMs === 0 ? null : input.durationMs;
  }
  // An action-bearing toast asks for a decision — don't yank it away by default.
  if (input.actions && input.actions.length > 0) return null;
  return DEFAULT_DURATIONS[input.tone ?? "info"];
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let seq = 0;

function emit(): void {
  // Fresh array identity so useSyncExternalStore / setState re-renders.
  const snapshot = toasts;
  listeners.forEach((l) => l(snapshot));
}

function upsert(next: Toast): void {
  const idx = toasts.findIndex((t) => t.id === next.id);
  if (idx >= 0) {
    const copy = toasts.slice();
    copy[idx] = next;
    toasts = copy;
  } else {
    toasts = [...toasts, next];
  }
  emit();
}

export const toast = {
  show(input: ToastInput): string {
    const id = input.id ?? `toast-${++seq}-${globalThis.performance?.now?.() ?? seq}`;
    upsert({
      id,
      tone: input.tone ?? "info",
      dismissible: input.dismissible ?? true,
      title: input.title,
      message: input.message,
      actions: input.actions,
      icon: input.icon,
      durationMs: resolveDuration(input),
      createdAt: Date.now(),
    });
    return id;
  },
  success(title: string, message?: ReactNode, extra?: Partial<ToastInput>): string {
    return this.show({ tone: "success", title, message, ...extra });
  },
  info(title: string, message?: ReactNode, extra?: Partial<ToastInput>): string {
    return this.show({ tone: "info", title, message, ...extra });
  },
  warning(title: string, message?: ReactNode, extra?: Partial<ToastInput>): string {
    return this.show({ tone: "warning", title, message, ...extra });
  },
  danger(title: string, message?: ReactNode, extra?: Partial<ToastInput>): string {
    return this.show({ tone: "danger", title, message, ...extra });
  },
  dismiss(id: string): void {
    const next = toasts.filter((t) => t.id !== id);
    if (next.length !== toasts.length) {
      toasts = next;
      emit();
    }
  },
  clear(): void {
    if (toasts.length) {
      toasts = [];
      emit();
    }
  },
  /** Current toasts (for the renderer's getSnapshot). */
  get(): Toast[] {
    return toasts;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
