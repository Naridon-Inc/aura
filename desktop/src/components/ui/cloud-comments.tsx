// Comments on a shared chat: threads under a turn (or on the workspace as a
// whole), each a first comment and its replies, and the small box they are
// written in. A box offers teammates as you type "@". You can change or
// delete only what you wrote; a deleted comment keeps its place and says so.
// A thread can be marked resolved, and reopened.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, CornerDownRight, Pencil, RotateCcw, Sparkles, Trash2 } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "./avatar";
import { Button } from "./button";
import { matchSuggestions, SuggestionRow, type ComposerSuggestion } from "./composerSuggestions";
import { Tooltip } from "./tooltip";
import "./cloud-feedback.css";

export type CommentAuthor = { name: string; initials: string; color: string; photo?: string };

export type CommentView = {
  id: string;
  author: CommentAuthor;
  /** "3m ago". */
  when: string;
  edited: boolean;
  deleted: boolean;
  body: string;
  /** You wrote it, so you may change or delete it. */
  own: boolean;
};

export type ThreadView = {
  id: string;
  root: CommentView;
  replies: CommentView[];
  resolved: boolean;
};

/** The folded thread's one line: "2 comments · Priya, Sam". */
export function ThreadFold({ line, open, onToggle }: { line: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="ui-thread-fold" aria-expanded={open} onClick={onToggle}>
      <CornerDownRight aria-hidden="true" />
      <span>{line}</span>
    </button>
  );
}

// ── The box ─────────────────────────────────────────────────────────────────

/** A comment's words with each @mention marked. */
function Said({ body }: { body: string }) {
  const parts = body.split(/(@[A-Za-z0-9][A-Za-z0-9-]*)/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="ui-comment-mention">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function CommentBox({
  placeholder,
  suggestions = [],
  submitLabel = "Comment",
  initial = "",
  autoFocus = false,
  max = 4000,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  /** Teammates offered as you type "@". */
  suggestions?: ComposerSuggestion[];
  submitLabel?: string;
  initial?: string;
  autoFocus?: boolean;
  max?: number;
  /** Resolves true once it took; the box empties then. */
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [cursor, setCursor] = useState(initial.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!autoFocus) return;
    const el = field.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(32, Math.min(160, el.scrollHeight))}px`;
  }, [value]);

  const token = value.slice(0, cursor).match(/(?:^|\s)@([^\s]*)$/);
  const matching = !dismissed && token ? matchSuggestions(suggestions, "@", token[1]) : [];
  const at = Math.min(active, Math.max(0, matching.length - 1));
  const text = value.trim();
  const tooLong = text.length > max;

  const pick = (s: ComposerSuggestion) => {
    if (!token) return;
    const start = cursor - token[1].length - 1;
    const insert = s.insertText.endsWith(" ") ? s.insertText : `${s.insertText} `;
    const next = value.slice(0, start) + insert + value.slice(cursor);
    setValue(next);
    setCursor(start + insert.length);
    setDismissed(true);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(start + insert.length, start + insert.length);
    });
  };
  const submit = () => {
    if (!text || busy || tooLong) return;
    setBusy(true);
    void onSubmit(text)
      .then((ok) => {
        if (ok) {
          setValue("");
          setCursor(0);
        }
      })
      .finally(() => setBusy(false));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (matching.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((at + (e.key === "ArrowDown" ? 1 : -1) + matching.length) % matching.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(matching[at]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="ui-comment-box" data-busy={busy || undefined}>
      {matching.length > 0 && (
        <div className="ui-composer-suggestions ui-comment-suggestions" role="listbox" id={listId} aria-label="Mention suggestions">
          {matching.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              data-kind={item.kind}
              aria-selected={i === at}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== at && setActive(i)}
              onClick={() => pick(item)}
            >
              <SuggestionRow item={item} query={token?.[1] ?? ""} />
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={field}
        value={value}
        rows={1}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-controls={matching.length ? listId : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setCursor(e.target.selectionStart ?? e.target.value.length);
          setDismissed(false);
          setActive(0);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKey}
      />
      <div className="ui-comment-box-row">
        {tooLong && <span className="ui-comment-box-note">{`${text.length - max} characters too long`}</span>}
        <span style={{ flex: 1 }} />
        {onCancel && (
          <Button variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="xs" disabled={!text || busy || tooLong} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

// ── One comment ─────────────────────────────────────────────────────────────

export type CommentHandlers = {
  onEdit: (id: string, body: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  /** Put the comment in the prompt box; absent for whoever can't prompt here. */
  onSendToAgent?: (c: CommentView) => void;
  /** "Send to Claude". */
  sendLabel?: string;
};

function Face({ author }: { author: CommentAuthor }) {
  return (
    <Avatar className="ui-comment-face" style={{ background: author.color }}>
      {author.photo && <AvatarImage src={author.photo} alt="" />}
      <AvatarFallback>{author.initials}</AvatarFallback>
    </Avatar>
  );
}

export function CommentItem({
  c,
  suggestions,
  handlers,
  tools,
}: {
  c: CommentView;
  suggestions?: ComposerSuggestion[];
  handlers: CommentHandlers;
  /** More buttons on the comment's row (resolve, on a thread's first). */
  tools?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (c.deleted)
    return (
      <div className="ui-comment" data-comment-id={c.id} data-deleted>
        <span className="ui-comment-face ui-comment-face-gone" aria-hidden="true" />
        <div className="ui-comment-main">
          <p className="ui-comment-gone">Comment deleted</p>
        </div>
      </div>
    );
  return (
    <div className="ui-comment" data-comment-id={c.id}>
      <Face author={c.author} />
      <div className="ui-comment-main">
        <div className="ui-comment-head">
          <span className="ui-comment-name">{c.author.name}</span>
          <span className="ui-comment-when">
            {c.when}
            {c.edited ? " · edited" : ""}
          </span>
          <span className="ui-comment-tools">
            {!editing && handlers.onSendToAgent && (
              <Tooltip content={`Put this in the prompt box. You still choose to send it.`}>
                <Button variant="ghost" size="xs" onClick={() => handlers.onSendToAgent?.(c)}>
                  <Sparkles />
                  {handlers.sendLabel ?? "Send to the agent"}
                </Button>
              </Tooltip>
            )}
            {!editing && c.own && !confirming && (
              <>
                <Tooltip content="Edit">
                  <Button variant="ghost" size="iconXs" aria-label="Edit comment" onClick={() => setEditing(true)}>
                    <Pencil />
                  </Button>
                </Tooltip>
                <Tooltip content="Delete">
                  <Button variant="ghost" size="iconXs" aria-label="Delete comment" onClick={() => setConfirming(true)}>
                    <Trash2 />
                  </Button>
                </Tooltip>
              </>
            )}
            {confirming && (
              <>
                <span className="ui-comment-when">Delete this comment?</span>
                <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
                  Keep
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  onClick={() => void handlers.onDelete(c.id).finally(() => setConfirming(false))}
                >
                  Delete
                </Button>
              </>
            )}
            {!editing && !confirming && tools}
          </span>
        </div>
        {editing ? (
          <CommentBox
            placeholder="Edit your comment"
            initial={c.body}
            submitLabel="Save"
            suggestions={suggestions}
            autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={(body) =>
              body === c.body
                ? Promise.resolve(true).then((ok) => (setEditing(false), ok))
                : handlers.onEdit(c.id, body).then((ok) => (ok && setEditing(false), ok))
            }
          />
        ) : (
          <p className="ui-comment-body">
            <Said body={c.body} />
          </p>
        )}
      </div>
    </div>
  );
}

// ── A thread ────────────────────────────────────────────────────────────────

export function CommentThread({
  t,
  suggestions,
  handlers,
  onReply,
  onResolve,
  onReopen,
  above,
}: {
  t: ThreadView;
  suggestions?: ComposerSuggestion[];
  handlers: CommentHandlers;
  onReply: (rootId: string, body: string) => Promise<boolean>;
  onResolve: (rootId: string) => Promise<boolean>;
  onReopen: (rootId: string) => Promise<boolean>;
  /** Drawn over the thread: which message it is on, in the Comments tab. */
  above?: ReactNode;
}) {
  const [replying, setReplying] = useState(false);
  const resolve = t.resolved ? (
    <Tooltip content="Open this thread again">
      <Button variant="ghost" size="xs" onClick={() => void onReopen(t.id)}>
        <RotateCcw />
        Reopen
      </Button>
    </Tooltip>
  ) : (
    <Tooltip content="Mark this thread as done">
      <Button variant="ghost" size="xs" onClick={() => void onResolve(t.id)}>
        <Check />
        Resolve
      </Button>
    </Tooltip>
  );
  return (
    <section className="ui-thread" data-thread-id={t.id} data-resolved={t.resolved || undefined}>
      {above}
      <CommentItem c={t.root} suggestions={suggestions} handlers={handlers} tools={resolve} />
      {t.replies.length > 0 && (
        <div className="ui-thread-replies">
          {t.replies.map((r) => (
            <CommentItem key={r.id} c={r} suggestions={suggestions} handlers={handlers} />
          ))}
        </div>
      )}
      {!t.resolved &&
        (replying ? (
          <div className="ui-thread-replies">
            <CommentBox
              placeholder="Reply, or @mention a teammate"
              submitLabel="Reply"
              suggestions={suggestions}
              autoFocus
              onCancel={() => setReplying(false)}
              onSubmit={(body) => onReply(t.id, body)}
            />
          </div>
        ) : (
          <button type="button" className="ui-thread-reply" onClick={() => setReplying(true)}>
            Reply
          </button>
        ))}
    </section>
  );
}
