// Avatar-picker dropdown for human assignees. Replaces the free-text
// git-handle input on tasks. Sources its option set from team members
// (`team_load`) so misspellings and ghost handles are no longer
// possible. The trigger is a compact pill (avatar + handle); the
// dropdown lists members with a typeahead filter.
//
// Keyboard: ↑/↓ navigates, Enter selects, Esc closes. Click-outside
// closes. The "Unassigned" row clears the value.
//
// OO.3 — supports multi-select via the `values` + `onChangeMulti`
// props. When those are provided the trigger renders an avatar
// stack (overlapping circles, +N overflow chip) instead of the
// single-handle pill, and the dropdown rows toggle membership
// instead of committing-and-closing. Single-select callers stay on
// the original `value` + `onChange` props, so this is a strict
// superset of the prior contract.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { TeamMember } from "../lib/api";

type SingleProps = {
  value: string | null | undefined;
  onChange: (handle: string | null) => void;
  /** Multi-select props are mutually exclusive with single-select. */
  values?: never;
  onChangeMulti?: never;
};

type MultiProps = {
  /** OO.3 multi-assignee value. Render order drives the avatar
   *  stack order; the trigger collapses overflow into "+N" once it
   *  exceeds `maxAvatars`. */
  values: string[];
  /** Receives the full next list — easier for the caller to feed
   *  straight into `tasks_update`'s `assignee_ids`. */
  onChangeMulti: (handles: string[]) => void;
  /** Single-select props are mutually exclusive with multi-select. */
  value?: never;
  onChange?: never;
};

type CommonProps = {
  members: TeamMember[];
  /** Optional placeholder shown inside the trigger when value is empty. */
  placeholder?: string;
  /** When true the trigger is a tiny chip suited for table cells. */
  dense?: boolean;
  /** Disable interaction (read-only mode). */
  disabled?: boolean;
  /** Multi-mode only — cap the avatar stack at this many before
   *  collapsing overflow to a "+N" chip. Defaults to 3. */
  maxAvatars?: number;
  /** Which edge of the trigger the dropdown hugs. Use `right` from
   *  right-edge containers (peek side rail) so the popover grows
   *  leftward and doesn't clip past the window edge. */
  align?: "left" | "right";
};

type Props = (SingleProps | MultiProps) & CommonProps;

// Every avatar reads the same. A teammate's initial is an identity label, not
// a status, so it stays on the neutral ramp — colour in this app is reserved
// for work that is in flight, finished, or broken.
const AVATAR_TINT = {
  background: "var(--color-bg-2)",
  color: "var(--color-text-2)",
} as const;

function initialOf(m: TeamMember): string {
  const src = (m.name || m.handle || "?").trim();
  return src.charAt(0).toUpperCase();
}

export function AssigneePicker(props: Props) {
  const {
    members,
    placeholder = "Unassigned",
    dense = false,
    disabled = false,
    maxAvatars = 3,
    align = "left",
  } = props;
  const isMulti = props.values !== undefined;
  // Snapshot the active selection set as a stable array regardless of
  // single/multi mode so the dropdown can highlight rows with one
  // lookup. Empty for single-mode when value is null.
  const selectedSet = useMemo<Set<string>>(() => {
    if (isMulti) return new Set(props.values ?? []);
    const v = (props as SingleProps).value;
    return new Set(v ? [v] : []);
  }, [isMulti, isMulti ? props.values : (props as SingleProps).value]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ranked = members
      .filter((m) => m.handle && m.handle.length > 0)
      .filter((m) =>
        !q ||
        m.handle.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)),
      );
    ranked.sort((a, b) => (b.commits || 0) - (a.commits || 0));
    return ranked.slice(0, 40);
  }, [members, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      const insideTrigger = rootRef.current?.contains(t) ?? false;
      // The portalled dropdown lives outside `rootRef`, so we have to
      // accept clicks landing in it as "inside" — otherwise typing a
      // search query would dismiss on first mousedown.
      const insidePopover = popoverRef.current?.contains(t) ?? false;
      if (!insideTrigger && !insidePopover) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Compute fixed-position coords so the portalled dropdown follows
  // the trigger even when ancestors scroll or resize. Anchored to the
  // trigger's right edge when `align === "right"` so it doesn't clip
  // off the screen when used near a right-edge container.
  useLayoutEffect(() => {
    if (!open || !rootRef.current) {
      setPopoverStyle(null);
      return;
    }
    const compute = () => {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const base: CSSProperties = {
        position: "fixed",
        top: rect.bottom + 4,
        zIndex: 100,
      };
      if (align === "right") {
        base.right = Math.max(8, window.innerWidth - rect.right);
      } else {
        base.left = rect.left;
      }
      setPopoverStyle(base);
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open, align]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Single-mode lookup — only consulted by the single-mode trigger
  // branch. `null` when value is empty or out-of-team.
  const selectedSingle = !isMulti
    ? members.find((m) => m.handle === (props as SingleProps).value) || null
    : null;

  // Multi-mode resolved selection — preserves the input order (which
  // also drives the avatar-stack rendering order). Handles that
  // aren't in the team list still render so a typo can be removed.
  const selectedMulti = useMemo(() => {
    if (!isMulti) return [];
    return (props.values ?? []).map(
      (h) =>
        members.find((m) => m.handle === h) ??
        ({ handle: h, name: h, commits: 0, last_seen: 0 } as TeamMember),
    );
  }, [isMulti, isMulti ? props.values : null, members]);

  /** Single-mode commit: replace value and close. */
  const commitSingle = (handle: string | null) => {
    if (isMulti) return;
    (props as SingleProps).onChange(handle);
    setOpen(false);
  };

  /** Multi-mode toggle: add when missing, remove when present. Keeps
   *  the dropdown open so the user can pick several without
   *  reopening — matches Plane's behaviour. */
  const toggleMulti = (handle: string) => {
    if (!isMulti) return;
    const cur = props.values ?? [];
    const next = cur.includes(handle)
      ? cur.filter((x) => x !== handle)
      : [...cur, handle];
    props.onChangeMulti!(next);
  };

  /** Multi-mode "clear all" affordance (replaces the single-mode
   *  Unassigned row). */
  const clearMulti = () => {
    if (!isMulti) return;
    props.onChangeMulti!([]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(filtered.length, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor === 0) {
        if (isMulti) clearMulti();
        else commitSingle(null);
      } else {
        const m = filtered[cursor - 1];
        if (m) {
          if (isMulti) toggleMulti(m.handle);
          else commitSingle(m.handle);
        }
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  const triggerSize = dense ? "h-5 px-1.5 text-[10.5px]" : "h-7 px-2 text-[12px]";
  const avatarSize = dense ? "w-4 h-4 text-[9px]" : "w-5 h-5 text-[10px]";

  // ── Trigger renderers ───────────────────────────────────────────
  // Two distinct triggers so each mode renders its own affordance —
  // multi shows a stack + "+N" overflow chip, single shows a single
  // pill. The dropdown body is shared.
  const triggerBody = isMulti
    ? renderMultiTrigger(selectedMulti, avatarSize, maxAvatars, placeholder)
    : renderSingleTrigger(selectedSingle, avatarSize, placeholder);
  const triggerTitle = isMulti
    ? selectedMulti.length === 0
      ? "Pick assignees"
      : `${selectedMulti.length} assignee${selectedMulti.length === 1 ? "" : "s"}`
    : selectedSingle
      ? `Assigned to ${selectedSingle.handle}`
      : "Pick assignee";

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded border border-line-soft bg-bg-content hover:border-line transition-colors ${triggerSize} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        style={{ color: "var(--color-text-1)" }}
        title={triggerTitle}
      >
        {triggerBody}
      </button>

      {open && popoverStyle && createPortal(
        <div
          ref={popoverRef}
          className="min-w-[220px] max-w-[280px] rounded-md border border-line-soft bg-bg-1 shadow-lg"
          style={{ ...popoverStyle, boxShadow: "0 8px 32px rgba(0,0,0,0.35)" }}
          onKeyDown={onKey}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            placeholder={isMulti ? "Add teammates…" : "Search teammates…"}
            className="w-full bg-transparent border-b border-line-soft px-2.5 py-1.5 text-[12px] text-text-1 focus:outline-none placeholder:text-text-5"
          />
          <div className="max-h-[260px] overflow-y-auto py-1">
            <button
              type="button"
              onMouseEnter={() => setCursor(0)}
              onClick={() => (isMulti ? clearMulti() : commitSingle(null))}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-left ${cursor === 0 ? "bg-bg-2" : "hover:bg-bg-2"}`}
            >
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center border border-dashed border-line-soft text-text-5 text-[10px]"
                aria-hidden
              >
                ?
              </span>
              <span className="text-text-2">
                {isMulti ? "Clear all" : "Unassigned"}
              </span>
            </button>
            {filtered.length === 0 && (
              <div className="px-2.5 py-2 text-[11px] text-text-5">
                No teammates match “{query}”.
              </div>
            )}
            {filtered.map((m, i) => {
              const active = cursor === i + 1;
              const isSelected = selectedSet.has(m.handle);
              return (
                <button
                  key={m.handle}
                  type="button"
                  onMouseEnter={() => setCursor(i + 1)}
                  onClick={() =>
                    isMulti ? toggleMulti(m.handle) : commitSingle(m.handle)
                  }
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-left ${active ? "bg-bg-2" : "hover:bg-bg-2"}`}
                >
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center font-semibold text-[10px] flex-shrink-0"
                    style={{
                      background: AVATAR_TINT.background,
                      color: AVATAR_TINT.color,
                    }}
                  >
                    {initialOf(m)}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-text-1">{m.handle}</span>
                    {m.name && m.name !== m.handle && (
                      <span className="block truncate text-[10.5px] text-text-4">
                        {m.name}
                      </span>
                    )}
                  </span>
                  {isSelected && (
                    <span className="text-accent text-[11px]" aria-hidden>
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function renderSingleTrigger(
  selected: TeamMember | null,
  avatarSize: string,
  placeholder: string,
) {
  if (selected) {
    return (
      <>
        <span
          className={`${avatarSize} rounded-full flex items-center justify-center font-semibold flex-shrink-0`}
          style={{
            background: AVATAR_TINT.background,
            color: AVATAR_TINT.color,
          }}
        >
          {initialOf(selected)}
        </span>
        <span className="truncate max-w-[120px]">{selected.handle}</span>
      </>
    );
  }
  return (
    <>
      <span
        className={`${avatarSize} rounded-full flex items-center justify-center border border-dashed border-line-soft text-text-5`}
        aria-hidden
      >
        ?
      </span>
      <span className="text-text-4">{placeholder}</span>
    </>
  );
}

function renderMultiTrigger(
  selected: TeamMember[],
  avatarSize: string,
  maxAvatars: number,
  placeholder: string,
) {
  if (selected.length === 0) {
    return (
      <>
        <span
          className={`${avatarSize} rounded-full flex items-center justify-center border border-dashed border-line-soft text-text-5`}
          aria-hidden
        >
          ?
        </span>
        <span className="text-text-4">{placeholder}</span>
      </>
    );
  }
  const visible = selected.slice(0, maxAvatars);
  const overflow = selected.length - visible.length;
  return (
    <>
      <span className="inline-flex items-center -space-x-1.5">
        {visible.map((m) => (
          <span
            key={m.handle}
            className={`${avatarSize} rounded-full flex items-center justify-center font-semibold flex-shrink-0 ring-1 ring-bg-content`}
            style={{
              background: AVATAR_TINT.background,
              color: AVATAR_TINT.color,
            }}
            title={m.handle}
          >
            {initialOf(m)}
          </span>
        ))}
        {overflow > 0 && (
          <span
            className={`${avatarSize} rounded-full flex items-center justify-center font-semibold flex-shrink-0 ring-1 ring-bg-content bg-bg-2 text-text-3`}
            title={`+${overflow} more`}
          >
            +{overflow}
          </span>
        )}
      </span>
      {selected.length === 1 && (
        <span className="truncate max-w-[100px]">{selected[0]!.handle}</span>
      )}
    </>
  );
}

/** Standalone read-only avatar stack — used by the card chrome / list
 *  rows / spreadsheet cells where we want to show the assignees but
 *  not open a picker. Mirrors the trigger rendering inside the multi
 *  variant so the visual is identical. */
export function AssigneeStack({
  handles,
  members,
  maxAvatars = 3,
  dense = false,
}: {
  handles: string[];
  members: TeamMember[];
  maxAvatars?: number;
  dense?: boolean;
}) {
  const avatarSize = dense ? "w-4 h-4 text-[9px]" : "w-5 h-5 text-[10px]";
  const resolved = handles.map(
    (h) =>
      members.find((m) => m.handle === h) ??
      ({ handle: h, name: h, commits: 0, last_seen: 0 } as TeamMember),
  );
  if (resolved.length === 0) return null;
  const visible = resolved.slice(0, maxAvatars);
  const overflow = resolved.length - visible.length;
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {visible.map((m) => (
        <span
          key={m.handle}
          className={`${avatarSize} rounded-full flex items-center justify-center font-semibold flex-shrink-0 ring-1 ring-bg-content`}
          style={{
            background: AVATAR_TINT.background,
            color: AVATAR_TINT.color,
          }}
          title={m.handle}
        >
          {initialOf(m)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className={`${avatarSize} rounded-full flex items-center justify-center font-semibold flex-shrink-0 ring-1 ring-bg-content bg-bg-2 text-text-3`}
          title={`+${overflow} more`}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
