// ask — the app asking you a question, in the app.
//
// Nineteen surfaces stopped and asked the operating system to ask for them:
// 38 calls — 22 `window.confirm`, 8 `window.prompt`, 8 `window.alert`. Every
// one draws a grey system sheet in the system font, titled with the bundle
// name, over an app that has its own dialogs (`components/Dialog`, 15 of them)
// and its own recipe for the bespoke ones (`ui/modalSurface`, 5 more).
//
// The cost is not only that they look like a different product:
//
//   · `window.confirm` has two buttons and you cannot label them. So the
//     sixteen destructive questions in this app — delete a channel and
//     everything said in it, delete an agent profile and the Claude login
//     inside it, remove a worktree from disk — are all answered by pressing a
//     button that says OK. The one word that tells you what you are about to
//     destroy is the one word the OS will not let you write.
//
//   · It blocks the webview. Every streaming terminal, every agent transcript
//     and every animation in the window stops until the sheet is dismissed —
//     in an app whose whole point is watching work happen live.
//
//   · `window.prompt` returns a bare string with nowhere to put a label, a
//     placeholder, a hint or an error. Two surfaces wanted two fields from
//     you, so they asked twice in a row: "Tab name", then "Tab URL". Cancel
//     the second sheet and the name you typed is gone with no way back.
//
// So: one host, mounted once, and three promise-shaped calls that read the
// same way at the call site as the ones they replace.
//
//     if (!(await askConfirm({ title: "Delete #general?", … }))) return;
//     const v = await askText({ title: "Topic for #general", … });
//     await askNotice({ title: "…", body: "…" });
//
// `askForm` takes the two-field case in one sheet, so a question with two
// halves is one question again.
//
// If the host is not mounted — a surface rendered outside the app shell, a
// test — these fall back to the native call rather than resolving to nothing.
// A question that silently answers itself is worse than an ugly sheet.

import * as React from "react";
import { createPortal } from "react-dom";

import { Button } from "./button";
import { Input } from "./input";
import {
  MODAL_BACKDROP,
  MODAL_BODY,
  MODAL_FOOTER,
  MODAL_HEADER,
  MODAL_PANEL,
  MODAL_TITLE,
} from "./modalSurface";
import { cn } from "../../lib/utils";

export type AskField = {
  /** Key this field's answer lands under. */
  name: string;
  /** What to call it above the box. */
  label: string;
  placeholder?: string;
  /** Prefilled text. */
  value?: string;
  /** Empty is refused when true. */
  required?: boolean;
};

export type ConfirmRequest = {
  /** The question itself, ending in "?". */
  title: string;
  /** What happens if they say yes — the consequence, in plain words. */
  body?: string;
  /** The verb, not "OK": "Delete", "Remove", "Forget", "Install". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` paints the primary red and is the default for anything that
   *  destroys something. */
  tone?: "default" | "danger";
};

export type FormRequest = {
  title: string;
  body?: string;
  fields: AskField[];
  submitLabel?: string;
};

export type NoticeRequest = {
  title: string;
  body?: string;
  dismissLabel?: string;
};

type Pending = { id: number } & (
  | { kind: "confirm"; req: ConfirmRequest; resolve: (v: boolean) => void }
  | {
      kind: "form";
      req: FormRequest;
      resolve: (v: Record<string, string> | null) => void;
    }
  | { kind: "notice"; req: NoticeRequest; resolve: () => void }
);

/** Set by `AskHost` while it is mounted. One host, one queue. */
let enqueue: ((p: Pending) => void) | null = null;
let nextId = 1;

/** Ask a yes/no question. Resolves false on Escape, on the backdrop, and on
 *  cancel — the safe answer is always the one you get by leaving. */
export function askConfirm(req: ConfirmRequest): Promise<boolean> {
  if (!enqueue) {
    return Promise.resolve(
      window.confirm(req.body ? `${req.title}\n\n${req.body}` : req.title),
    );
  }
  const push = enqueue;
  return new Promise<boolean>((resolve) =>
    push({ id: nextId++, kind: "confirm", req, resolve }),
  );
}

/** Ask for one or more values in a single sheet. Resolves null if they leave. */
export function askForm(req: FormRequest): Promise<Record<string, string> | null> {
  if (!enqueue) {
    const out: Record<string, string> = {};
    for (const f of req.fields) {
      const v = window.prompt(f.label, f.value ?? "");
      if (v === null) return Promise.resolve(null);
      out[f.name] = v;
    }
    return Promise.resolve(out);
  }
  const push = enqueue;
  return new Promise<Record<string, string> | null>((resolve) =>
    push({ id: nextId++, kind: "form", req, resolve }),
  );
}

/** The one-value case. Resolves null if they leave. */
export function askText(opts: {
  title: string;
  body?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  submitLabel?: string;
  required?: boolean;
}): Promise<string | null> {
  return askForm({
    title: opts.title,
    body: opts.body,
    submitLabel: opts.submitLabel,
    fields: [
      {
        name: "value",
        label: opts.label ?? opts.title,
        value: opts.value,
        placeholder: opts.placeholder,
        required: opts.required,
      },
    ],
  }).then((r) => (r === null ? null : (r.value ?? "")));
}

/** Tell them something went wrong, or cannot happen yet. One button. */
export function askNotice(req: NoticeRequest): Promise<void> {
  if (!enqueue) {
    window.alert(req.body ? `${req.title}\n\n${req.body}` : req.title);
    return Promise.resolve();
  }
  const push = enqueue;
  return new Promise<void>((resolve) => push({ id: nextId++, kind: "notice", req, resolve }));
}

function Sheet({ pending, onDone }: { pending: Pending; onDone: () => void }) {
  const firstFieldRef = React.useRef<HTMLInputElement>(null);
  const primaryRef = React.useRef<HTMLButtonElement>(null);
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    pending.kind === "form"
      ? Object.fromEntries(pending.req.fields.map((f) => [f.name, f.value ?? ""]))
      : {},
  );

  const leave = React.useCallback(() => {
    if (pending.kind === "confirm") pending.resolve(false);
    else if (pending.kind === "form") pending.resolve(null);
    else pending.resolve();
    onDone();
  }, [pending, onDone]);

  const missing =
    pending.kind === "form"
      ? pending.req.fields.filter((f) => f.required && !(values[f.name] ?? "").trim())
      : [];

  const accept = React.useCallback(() => {
    if (pending.kind === "confirm") pending.resolve(true);
    else if (pending.kind === "form") {
      if (missing.length > 0) return;
      pending.resolve(values);
    } else pending.resolve();
    onDone();
  }, [pending, values, missing.length, onDone]);

  React.useEffect(() => {
    // Focus what they came here to do: type in the first box, or answer.
    const t = window.setTimeout(() => {
      (firstFieldRef.current ?? primaryRef.current)?.focus();
      firstFieldRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        leave();
      }
    }
    // Capture, so a surface underneath does not close on the same Escape.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leave]);

  const danger = pending.kind === "confirm" && pending.req.tone === "danger";
  const body = pending.req.body;

  return createPortal(
    <div
      className={cn(MODAL_BACKDROP, "z-[70] flex items-start justify-center pt-[18vh]")}
      onMouseDown={leave}
      role="presentation"
    >
      <div
        className={cn(MODAL_PANEL, "max-w-[420px]")}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={pending.req.title}
      >
        <div className={MODAL_HEADER}>
          <span className={MODAL_TITLE}>{pending.req.title}</span>
        </div>

        {(body || pending.kind === "form") && (
          <div className={cn(MODAL_BODY, "flex flex-col gap-3")}>
            {body && (
              <p className="whitespace-pre-line text-sm leading-relaxed text-text-2">{body}</p>
            )}
            {pending.kind === "form" &&
              pending.req.fields.map((f, i) => (
                <label key={f.name} className="flex flex-col gap-1">
                  <span className="text-xs text-text-3">{f.label}</span>
                  <Input
                    ref={i === 0 ? firstFieldRef : undefined}
                    value={values[f.name] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.name]: e.currentTarget.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        accept();
                      }
                    }}
                  />
                </label>
              ))}
          </div>
        )}

        <div className={MODAL_FOOTER}>
          {pending.kind !== "notice" && (
            <Button variant="secondary" size="sm" onClick={leave}>
              {pending.kind === "confirm" ? (pending.req.cancelLabel ?? "Cancel") : "Cancel"}
            </Button>
          )}
          <Button
            ref={primaryRef}
            variant={danger ? "destructive" : "default"}
            size="sm"
            disabled={missing.length > 0}
            onClick={accept}
          >
            {pending.kind === "confirm"
              ? (pending.req.confirmLabel ?? "Continue")
              : pending.kind === "form"
                ? (pending.req.submitLabel ?? "Save")
                : (pending.req.dismissLabel ?? "OK")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Mount once, near the root. Without it every ask falls back to the OS sheet. */
export function AskHost() {
  const [queue, setQueue] = React.useState<Pending[]>([]);

  React.useEffect(() => {
    enqueue = (p) => setQueue((q) => [...q, p]);
    return () => {
      enqueue = null;
    };
  }, []);

  const head = queue[0];
  const drop = React.useCallback(() => setQueue((q) => q.slice(1)), []);
  if (!head) return null;
  // Keyed so a second question starts with its own state, not the first's.
  return <Sheet key={head.id} pending={head} onDone={drop} />;
}
