/** Scribble — one block.
 *
 *  A discrete, addressable line. A leading checkbox marks it a *task*; a plain
 *  line is a *note* — you always write freely, and a line only becomes a task
 *  when you add a checkbox (the gutter circle, or typing `[] ` at the start).
 *  The body is one line: while you're editing it, a bare auto-growing textarea
 *  holds the raw markdown; when idle it renders inline (**bold**, *italic*,
 *  @mention, gif) so the highlight shows. A tiny trailing chip carries who /
 *  when (and, for a finished task, who checked it); a task carried from an
 *  earlier day shows an amber "carry Nd". Hover a live block to pin it (many
 *  pins allowed) or remove it. Past days render read-only. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Pin, X } from "lucide-react";
import type { TeamMember } from "../../../lib/api";
import { InlineText } from "./InlineText";
import {
  daysBetween,
  dayKey,
  formatAge,
  type ScribbleBlock as Block,
} from "./scribbleModel";

/** Compact date for a task carried from more than a day ago, e.g. "Jul 20". */
function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** A bare, auto-growing single-field editor: no chrome, grows to fit wrapped
 *  text, and turns Enter into "new block" (Shift+Enter is ignored — blocks are
 *  single units). */
function BlockInput({
  value,
  autoFocus,
  placeholder,
  onChange,
  onEnter,
  onFocus,
  onBlur,
}: {
  value: string;
  autoFocus?: boolean;
  placeholder?: string;
  onChange: (text: string) => void;
  onEnter: () => boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow to fit the content — no inner scrollbar, no fixed height.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // Focus on mount when spawned via Enter or click (never for the passive
  // trailing draft, which mounts with autoFocus off so it can't steal focus).
  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [autoFocus]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={(e) => {
        // A block is one line — Enter starts a new block, and even Shift+Enter
        // never inserts a raw newline (that would split into two blocks on
        // save/reload).
        if (e.key === "Enter") {
          e.preventDefault();
          if (!e.shiftKey) onEnter();
        }
      }}
      className="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[12.5px] leading-snug text-text-1 outline-none placeholder:text-text-5"
    />
  );
}

export function ScribbleBlock({
  block,
  members,
  nowMs,
  editable,
  autoFocus,
  onChangeText,
  onToggleTask,
  onToggleDone,
  onTogglePin,
  onRemove,
  onEnter,
}: {
  block: Block;
  members: TeamMember[];
  nowMs: number;
  editable: boolean;
  autoFocus?: boolean;
  onChangeText: (text: string) => void;
  onToggleTask: () => void;
  onToggleDone: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onEnter: () => boolean;
}) {
  const [editing, setEditing] = useState(false);
  const isEmpty = block.text.trim().length === 0;
  // While editing (or empty, or just spawned) show the raw textarea; otherwise
  // render the inline markdown so bold / italic / gifs highlight.
  const showInput = editable && (editing || isEmpty || Boolean(autoFocus));

  const carried =
    block.isTask && !block.done && dayKey(block.createdAt) !== dayKey(nowMs);
  const carriedDays = carried ? daysBetween(block.createdAt, nowMs) : 0;

  const metaTitle = [
    block.author ? `added by @${block.author}` : "added",
    new Date(block.createdAt).toLocaleString(),
    block.done && block.doneBy ? `· done by @${block.doneBy}` : "",
    block.done && block.doneAt
      ? `at ${new Date(block.doneAt).toLocaleString()}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="group relative flex items-start gap-2 rounded px-2 py-[3px] hover:bg-bg-2/50">
      {/* gutter — checkbox for tasks; a faint "make a task" circle on hover for
          notes; a dot for read-only notes. Aligned to the first text line. */}
      <div className="flex h-[18px] w-4 flex-shrink-0 items-center justify-center">
        {block.isTask ? (
          <button
            type="button"
            disabled={!editable}
            onClick={onToggleDone}
            className={`${block.done ? "text-accent" : "text-text-4"} ${
              editable ? "hover:text-text-2" : "cursor-default opacity-80"
            }`}
            aria-label={block.done ? "Mark as not done" : "Mark as done"}
          >
            {block.done ? <CheckCircle2 size={14} /> : <Circle size={14} />}
          </button>
        ) : editable ? (
          <button
            type="button"
            onClick={onToggleTask}
            title="Make this a task"
            aria-label="Make this a task"
            className="text-text-5 opacity-0 transition-opacity hover:text-text-2 group-hover:opacity-70"
          >
            <Circle size={14} />
          </button>
        ) : (
          <span className="h-1 w-1 rounded-full bg-text-5" aria-hidden />
        )}
      </div>

      {/* body — one line: raw textarea while editing, rendered inline when idle */}
      <div className="min-w-0 flex-1 py-[1px]">
        {showInput ? (
          <BlockInput
            value={block.text}
            autoFocus={Boolean(autoFocus) || editing}
            placeholder="Write…  **bold**, *italic*, @mention, gif — [] for a task"
            onChange={onChangeText}
            onEnter={onEnter}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
          />
        ) : (
          <InlineText
            text={block.text}
            members={members}
            onClick={editable ? () => setEditing(true) : undefined}
            className={`block break-words text-[12.5px] leading-snug ${
              editable ? "cursor-text" : ""
            } ${block.done ? "text-text-4 line-through" : "text-text-1"}`}
          />
        )}
      </div>

      {/* inline status — always on, content-sized, so the body reaches the
          row's end. A carried task shows "Yesterday" (one day) or its short
          date (older); a finished task shows who checked it. */}
      <div className="flex flex-shrink-0 items-center gap-1 pt-[1px] text-[10px] leading-[18px]">
        {carried &&
          (carriedDays === 1 ? (
            <span
              className="rounded bg-amber/10 px-1 text-amber"
              title={metaTitle}
            >
              Yesterday
            </span>
          ) : (
            <span className="text-[9.5px] text-text-5" title={metaTitle}>
              {shortDate(block.createdAt)}
            </span>
          ))}
        {block.done && block.doneBy && (
          <span className="text-accent-green/80" title={metaTitle}>
            ✓ @{block.doneBy}
          </span>
        )}
        {block.pinned && <Pin size={9} className="text-accent" aria-label="Pinned" />}
      </div>

      {/* hover actions — an overlay pinned to the right edge. It's absolute, so
          it never reserves layout width: the body owns the full row until you
          hover, then the meta + pin/remove float in over the end. */}
      {!isEmpty && (
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md bg-bg-2/95 px-1.5 py-0.5 text-[10px] opacity-0 shadow-sm ring-1 ring-line-soft/60 transition-opacity group-hover:opacity-100">
          <span className="text-text-5" title={metaTitle}>
            {block.author ? `@${block.author} · ` : ""}
            {formatAge(block.createdAt, nowMs)}
          </span>
          {editable && (
            <>
              <button
                type="button"
                onClick={onTogglePin}
                title={block.pinned ? "Unpin" : "Pin"}
                className={`p-0.5 ${
                  block.pinned ? "text-accent" : "text-text-5 hover:text-text-2"
                }`}
                aria-label={block.pinned ? "Unpin" : "Pin"}
              >
                <Pin size={11} />
              </button>
              <button
                type="button"
                onClick={onRemove}
                title="Remove"
                className="p-0.5 text-text-5 hover:text-red"
                aria-label="Remove"
              >
                <X size={11} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
