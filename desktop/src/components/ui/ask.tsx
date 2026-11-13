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

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Input } from "./input";
import "./ask.css";

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

/** Ask a yes/no question. Resolves false on Escape and on cancel — the safe
 *  answer is always the one you get by leaving. */
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
  // The action button closes the dialog as well as answering, and the close
  // arrives as "they left". The first answer is the one that counts.
  const settled = React.useRef(false);
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    pending.kind === "form"
      ? Object.fromEntries(pending.req.fields.map((f) => [f.name, f.value ?? ""]))
      : {},
  );

  const leave = React.useCallback(() => {
    if (settled.current) return;
    settled.current = true;
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
    if (settled.current) return;
    if (pending.kind === "form") {
      if (missing.length > 0) return;
      pending.resolve(values);
    } else if (pending.kind === "confirm") pending.resolve(true);
    else pending.resolve();
    settled.current = true;
    onDone();
  }, [pending, values, missing.length, onDone]);

  const onOpenChange = (open: boolean) => {
    if (!open) leave();
  };
  const body = pending.req.body;
  // With no body there is no description to point at; saying so keeps the
  // dialog from pointing at one that is not there. With a body, the dialog
  // links it on its own.
  const describedBy = body ? {} : { "aria-describedby": undefined };

  if (pending.kind === "form") {
    const req = pending.req;
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent
          className="ui-ask"
          {...describedBy}
          // Focus what they came here to do: the first box, its text selected
          // so a prefilled name can be typed over.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            firstFieldRef.current?.focus();
            firstFieldRef.current?.select();
          }}
        >
          <DialogHeader>
            <DialogTitle>{req.title}</DialogTitle>
            {body && <DialogDescription className="ui-ask-body">{body}</DialogDescription>}
          </DialogHeader>
          {req.fields.map((f, i) => (
            <label key={f.name} className="ui-form-field">
              {f.label}
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
          <DialogFooter>
            <Button variant="outline" onClick={leave}>
              Cancel
            </Button>
            <Button disabled={missing.length > 0} onClick={accept}>
              {req.submitLabel ?? "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const danger = pending.kind === "confirm" && pending.req.tone === "danger";
  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent className="ui-ask" {...describedBy}>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending.req.title}</AlertDialogTitle>
          {body && (
            <AlertDialogDescription className="ui-ask-body">{body}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {pending.kind === "confirm" && (
            <AlertDialogCancel onClick={leave}>
              {pending.req.cancelLabel ?? "Cancel"}
            </AlertDialogCancel>
          )}
          <AlertDialogAction
            className={danger ? "ui-button-danger" : undefined}
            onClick={accept}
          >
            {pending.kind === "confirm"
              ? (pending.req.confirmLabel ?? "Continue")
              : (pending.req.dismissLabel ?? "OK")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
