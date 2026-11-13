// The parts a toast is drawn from: the glyph for its kind, the round close
// button that sits on its top-left corner (and fills a ring as the toast's
// time runs out), and the small buttons under its text. `Toaster.tsx` lays
// them out and stacks the toasts; the look lives in `toast.css`.

import { X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ToastTone } from "../../lib/toast";
import { AsciiSpinner } from "./ascii-spinner";
import "./toast.css";

/** What a toast is, for its glyph. A tone with no glyph of its own (`accent`)
 *  is a plain message. */
export type ToastKind = "normal" | "success" | "info" | "warning" | "error" | "loading";

export function toastKind(tone: ToastTone): ToastKind {
  switch (tone) {
    case "success":
    case "info":
    case "warning":
    case "loading":
      return tone;
    case "danger":
      return "error";
    case "accent":
      return "normal";
  }
}

const GLYPHS: Record<"success" | "info" | "warning" | "error", { d: string; viewBox: string }> = {
  success: {
    viewBox: "0 0 20 20",
    d: "M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882L9.16 12.1l-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z",
  },
  info: {
    viewBox: "0 0 20 20",
    d: "M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM11 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z",
  },
  warning: {
    viewBox: "0 0 24 24",
    d: "M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z",
  },
  error: {
    viewBox: "0 0 20 20",
    d: "M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  },
};

/** The kind's glyph, drawn in the toast's text colour; nothing for a plain
 *  message. A toast that is still working shows the app's loader. */
export function ToastKindIcon({ kind }: { kind: ToastKind }) {
  if (kind === "loading") return <AsciiSpinner size={14} />;
  if (kind === "normal") return null;
  const g = GLYPHS[kind];
  return (
    <svg width="20" height="20" viewBox={g.viewBox} fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={g.d} />
    </svg>
  );
}

/** The glyph a toast of this kind shows, or null for a plain message: the
 *  toast then keeps no empty slot for one, so its title sits at the edge. */
export function toastGlyph(kind: ToastKind): ReactNode {
  return kind === "normal" ? null : <ToastKindIcon kind={kind} />;
}

/** The round close button on the toast's top-left corner. On a toast that
 *  closes itself, a ring around the ✕ fills as its time runs out. */
export function ToastCloseButton({
  label = "Close toast",
  onClick,
}: {
  label?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-label={label} data-close-button="" onClick={onClick}>
      <span className="aura-toast-close-icon" aria-hidden="true">
        <svg className="aura-toast-close-progress" viewBox="0 0 20 20">
          <circle className="aura-toast-close-progress-circle" cx="10" cy="10" r="8" />
        </svg>
        <X className="aura-toast-close-glyph" />
      </span>
    </button>
  );
}

/** A button under the toast's text. `primary` is the filled one; the other is
 *  the quiet one beside it. Shows the loader while its work runs. */
export function ToastButton({
  primary,
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  primary: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-button=""
      data-action={primary ? "" : undefined}
      data-cancel={primary ? undefined : ""}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <AsciiSpinner size={10} />}
      {children}
    </button>
  );
}
