// Reusable @-mention UI primitives.
//
// <MentionInput> wraps a <textarea> (or <input>) with an autocomplete
// popover that fires when the user types `@`. Tab/Enter inserts the
// selected handle; Esc dismisses.
//
// <MentionedText> renders plain text with `@handle` tokens replaced by
// hover-card chips. Drop in anywhere a mention should be linkable —
// task descriptions, chat bubbles, note preview, etc.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { TeamMember } from "../lib/api";
import {
  activeMention,
  filterMembers,
  membersByHandle,
  parseMentions,
} from "../lib/mentions";

// ─── Input ─────────────────────────────────────────────────────────────

type MentionInputHandle = {
  focus: () => void;
  blur: () => void;
};

type MentionInputProps = {
  value: string;
  onChange: (next: string) => void;
  members: TeamMember[];
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  rows?: number;
  /** Fired when user presses Enter without Shift — caller decides whether
   *  to treat it as submit (e.g. chat send). Return true to suppress
   *  the default newline; return false to keep newline behavior. */
  onSubmit?: () => boolean | void;
  /** When true the component renders as a single-line <input> instead. */
  inline?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Optional callback fired whenever the user picks a mention. */
  onMention?: (handle: string) => void;
};

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(
  function MentionInput(
    {
      value,
      onChange,
      members,
      placeholder,
      className,
      style,
      rows = 3,
      onSubmit,
      inline = false,
      autoFocus,
      disabled,
      onMention,
    },
    ref,
  ) {
    const taRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
    const [caret, setCaret] = useState(0);
    const [activeIndex, setActiveIndex] = useState(0);

    useImperativeHandle(ref, () => ({
      focus: () => taRef.current?.focus(),
      blur: () => taRef.current?.blur(),
    }));

    const mention = useMemo(
      () => activeMention(value, caret),
      [value, caret],
    );
    const candidates = useMemo(
      () => (mention ? filterMembers(members, mention.query) : []),
      [mention, members],
    );

    // Keep activeIndex within bounds when the candidate list changes.
    useEffect(() => {
      if (activeIndex >= candidates.length) setActiveIndex(0);
    }, [candidates.length, activeIndex]);

    function applySelection(handle: string) {
      if (!mention) return;
      const next =
        value.slice(0, mention.start) +
        "@" +
        handle +
        " " +
        value.slice(caret);
      const newCaret = mention.start + handle.length + 2; // @ + handle + space
      onChange(next);
      onMention?.(handle);
      // Re-focus and set caret on next tick so React commits the new value first.
      window.setTimeout(() => {
        const el = taRef.current;
        if (el && "setSelectionRange" in el) {
          el.focus();
          el.setSelectionRange(newCaret, newCaret);
          setCaret(newCaret);
        }
      }, 0);
    }

    function handleKeyDown(
      e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
    ) {
      if (mention && candidates.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % candidates.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex(
            (i) => (i - 1 + candidates.length) % candidates.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applySelection(candidates[activeIndex].handle);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          // Closing the popover means moving caret away from the @.
          setCaret((c) => c); // no-op to re-evaluate
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey && onSubmit && !inline) {
        // Caller wants to treat plain Enter as submit (chat composers).
        const suppress = onSubmit();
        if (suppress) e.preventDefault();
      }
    }

    function handleSelectionChange() {
      const el = taRef.current;
      if (!el) return;
      setCaret(el.selectionStart ?? 0);
    }

    const sharedProps = {
      value,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
        onChange(e.target.value);
        setCaret(e.target.selectionStart ?? 0);
      },
      onSelect: handleSelectionChange,
      onKeyUp: handleSelectionChange,
      onClick: handleSelectionChange,
      onKeyDown: handleKeyDown,
      placeholder,
      className,
      style,
      autoFocus,
      disabled,
    };

    return (
      <div className="relative w-full">
        {inline ? (
          <input
            ref={(el) => {
              taRef.current = el;
            }}
            type="text"
            {...sharedProps}
          />
        ) : (
          <textarea
            ref={(el) => {
              taRef.current = el;
            }}
            rows={rows}
            {...sharedProps}
          />
        )}
        {mention && candidates.length > 0 && (
          <MentionPopover
            candidates={candidates}
            activeIndex={activeIndex}
            onPick={(handle) => applySelection(handle)}
            onHover={(i) => setActiveIndex(i)}
          />
        )}
      </div>
    );
  },
);

function MentionPopover({
  candidates,
  activeIndex,
  onPick,
  onHover,
}: {
  candidates: TeamMember[];
  activeIndex: number;
  onPick: (handle: string) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div
      className="absolute z-50 bottom-full left-0 mb-1 min-w-[220px] max-w-[300px] max-h-56 overflow-y-auto rounded-lg border border-line-soft bg-bg-1 p-1 shadow-[var(--shadow-flyout)]"
    >
      <ul className="py-1">
        {candidates.map((m, i) => (
          <li key={m.handle || m.email}>
            <button
              type="button"
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                // mousedown so the focus stays on the textarea
                e.preventDefault();
                onPick(m.handle);
              }}
              className={`w-full text-left px-2.5 py-1.5 text-[12px] flex items-baseline gap-2 ${
                i === activeIndex ? "bg-bg-2 text-text-1" : "text-text-3"
              }`}
            >
              <span className="font-medium text-text-1">@{m.handle}</span>
              <span className="text-[11px] text-text-4 truncate">
                {m.name || m.email}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Renderer ──────────────────────────────────────────────────────────

type MentionedTextProps = {
  text: string;
  members?: TeamMember[];
  /** Optional click handler for the chip — usually opens a user popover. */
  onMentionClick?: (handle: string) => void;
  className?: string;
};

export function MentionedText({
  text,
  members = [],
  onMentionClick,
  className,
}: MentionedTextProps): ReactNode {
  const lookup = useMemo(() => membersByHandle(members), [members]);
  const tokens = useMemo(() => parseMentions(text), [text]);
  return (
    <span className={className}>
      {tokens.map((tok, i) => {
        if (tok.kind === "text") return <span key={i}>{tok.text}</span>;
        const known = lookup.get(tok.handle);
        return (
          <span
            key={i}
            role={onMentionClick ? "button" : undefined}
            onClick={() => onMentionClick?.(tok.handle)}
            title={known ? `${known.name || known.email}` : "unknown handle"}
            className={`inline-flex items-baseline px-1 rounded font-medium cursor-pointer ${
              known
                ? "text-accent bg-accent/10 hover:bg-accent/20"
                : "text-text-4 bg-bg-2 border border-line-soft"
            }`}
          >
            @{tok.handle}
          </span>
        );
      })}
    </span>
  );
}
