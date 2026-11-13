// A tiny, general-purpose toast store. One instance app-wide; `<Toaster/>`
// (mounted once in App) subscribes and renders the stack bottom-right. Anything
// can raise a toast from anywhere without prop-drilling:
//
//   import { toast } from "../lib/toast";
//   toast.success("Saved", "Your changes are on disk.");
//   toast.show({
//     title: "Branch pushed",
//     actions: [{ label: "Open pull request", onClick: openPr }],
//   });
//
// Every toast closes itself after five seconds unless it asks for a decision
// (it carries actions) or is still working (`tone: "loading"`); the close
// button draws a ring that fills over that time and stops while the pointer is
// over the stack. Pass a stable `id` to replace a toast in place instead of
// stacking a duplicate — its place in the stack is kept.

import type { ReactNode } from "react";

export type ToastTone = "info" | "success" | "warning" | "danger" | "accent" | "loading";

export type ToastAction = {
  label: string;
  onClick: () => void | Promise<void>;
  /** `primary` = the filled button; otherwise the quiet one beside it. */
  variant?: "primary" | "default";
  /** Keep the toast open after the click (default: dismiss on click). Use for
   *  actions that kick off background work the toast should keep narrating. */
  keepOpen?: boolean;
};

/** Why a toast left the stack. */
export type ToastCloseReason =
  /** The person closed it: the close button, or a swipe. */
  | "dismiss"
  /** Its timer ran out. */
  | "auto"
  /** One of its actions ran. */
  | "action"
  /** Code took it down (`toast.dismiss`). */
  | "programmatic";

export type ToastInput = {
  /** Stable id → calling `show` again with the same id replaces in place
   *  rather than stacking a duplicate. Auto-generated when omitted. */
  id?: string;
  title?: string;
  message?: ReactNode;
  tone?: ToastTone;
  actions?: ToastAction[];
  /** A control row of its own in place of `actions`, drawn under the text —
   *  for a toast whose buttons carry state (a busy spinner, a disabled one). */
  actionRow?: ReactNode;
  /** Close after this many ms. `null` (or 0) = stays until closed.
   *  Omitted → see `resolveDuration`. */
  durationMs?: number | null;
  /** Show the close button (and allow the swipe away). Default true, except
   *  for a toast that is still working. A toast that can't be closed is only
   *  sensible when code or one of its actions takes it down. */
  dismissible?: boolean;
  /** Replaces the tone's glyph. */
  icon?: ReactNode;
  /** Accessible name of the close button. Default "Close toast". */
  dismissLabel?: string;
  /** The person closed it (close button or swipe) — not a timeout, not an
   *  action, not code. */
  onDismiss?: (t: Toast) => void;
  /** Its timer ran out. */
  onAutoClose?: (t: Toast) => void;
};

export type Toast = Required<Pick<ToastInput, "id" | "tone" | "dismissible">> &
  Omit<ToastInput, "id" | "tone" | "dismissible"> & {
    durationMs: number | null;
    createdAt: number;
  };

/** How long a toast stays when the caller doesn't say. */
export const DEFAULT_DURATION_MS = 5000;

/** How long a toast stays: what the caller asked for, else five seconds —
 *  except a toast that is still working, or one that asks for a decision,
 *  which stays until it is answered. */
export function resolveDuration(input: ToastInput): number | null {
  if (input.durationMs !== undefined) {
    return input.durationMs === 0 || input.durationMs === Infinity
      ? null
      : input.durationMs;
  }
  if (input.tone === "loading") return null;
  if (input.actionRow != null) return null;
  if (input.actions && input.actions.length > 0) return null;
  return DEFAULT_DURATION_MS;
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
    // Replacing keeps its age, so it keeps its place in the stack.
    copy[idx] = { ...next, createdAt: toasts[idx].createdAt };
    toasts = copy;
  } else {
    toasts = [...toasts, next];
  }
  emit();
}

function remove(id: string): Toast | null {
  const gone = toasts.find((t) => t.id === id) ?? null;
  if (!gone) return null;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
  return gone;
}

export const toast = {
  show(input: ToastInput): string {
    const id = input.id ?? `toast-${++seq}-${globalThis.performance?.now?.() ?? seq}`;
    upsert({
      ...input,
      id,
      tone: input.tone ?? "info",
      dismissible: input.dismissible ?? input.tone !== "loading",
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
  loading(title: string, message?: ReactNode, extra?: Partial<ToastInput>): string {
    return this.show({ tone: "loading", title, message, ...extra });
  },
  /** Take a toast down from code. Its `onDismiss` does not run — that is for
   *  the person closing it. */
  dismiss(id: string): void {
    remove(id);
  },
  /** Take a toast down for a reason, and tell it why: the renderer's close
   *  button, swipe, timer and actions all come through here. */
  close(id: string, reason: ToastCloseReason): void {
    const gone = remove(id);
    if (!gone) return;
    if (reason === "dismiss") gone.onDismiss?.(gone);
    else if (reason === "auto") gone.onAutoClose?.(gone);
  },
  clear(): void {
    if (toasts.length) {
      toasts = [];
      emit();
    }
  },
  /** Current toasts, oldest first (for the renderer's getSnapshot). */
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
