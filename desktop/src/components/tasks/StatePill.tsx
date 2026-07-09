// OO.3 — state pill. Renders a `TaskState` as a compact chip:
// colored dot + label, optional border. Two flavors:
//
//   <StatePill state={...} />            — read-only chip on a card
//   <StatePillPicker states={...}        — clickable picker that opens
//                    value={...}            a popover listing every
//                    onChange={...} />      catalog entry, grouped by
//                                           canonical group (Plane UX)
//
// The picker filters by query, supports keyboard nav (↑/↓/Enter/Esc),
// and surfaces the `group` label as a section header so users can
// see which canonical bucket a custom state lives in.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { TaskState, TaskStateGroup } from "../../lib/api";

const GROUP_ORDER: TaskStateGroup[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
];

const GROUP_LABEL: Record<TaskStateGroup, string> = {
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

// Plane parity: the dot inside the pill renders differently per group —
// backlog uses a dashed ring, unstarted a solid ring, started a half
// conic-gradient fill, completed/cancelled a full fill. Maps state.color
// onto the ring/fill so custom palette entries keep their colour while
// still picking up the group affordance.
function StateGlyph({
  group,
  color,
  size = 11,
}: {
  group: string;
  color: string;
  size?: number;
}) {
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    boxSizing: "border-box",
    flexShrink: 0,
  };
  if (group === "backlog") {
    return (
      <span
        aria-hidden
        style={{ ...base, border: `1.5px dashed ${color}` }}
      />
    );
  }
  if (group === "unstarted") {
    return (
      <span aria-hidden style={{ ...base, border: `1.5px solid ${color}` }} />
    );
  }
  if (group === "started") {
    return (
      <span
        aria-hidden
        style={{
          ...base,
          border: `1.5px solid ${color}`,
          background: `conic-gradient(${color} 50%, transparent 50%)`,
        }}
      />
    );
  }
  // completed / cancelled and any unknown group fall through to filled
  return (
    <span
      aria-hidden
      style={{ ...base, background: color, border: `1.5px solid ${color}` }}
    />
  );
}

export function StatePill({
  state,
  dense = false,
}: {
  state: TaskState | null | undefined;
  dense?: boolean;
}) {
  if (!state) {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] text-text-5 italic">
        — no state —
      </span>
    );
  }
  const glyphSize = dense ? 9 : 11;
  const textSize = dense ? "text-[10.5px]" : "text-[11px]";
  const pad = dense ? "pl-[5px] pr-[7px] py-px" : "pl-[7px] pr-[9px] py-[2px]";
  return (
    <span
      className={`inline-flex items-center gap-[5px] ${pad} ${textSize} rounded-full border-[0.5px] border-line-soft bg-bg-2 text-text-2 whitespace-nowrap font-medium`}
      title={`${state.name} (${GROUP_LABEL[state.group as TaskStateGroup] ?? state.group})`}
    >
      <StateGlyph
        group={state.group as string}
        color={state.color}
        size={glyphSize}
      />
      <span className="truncate max-w-[120px]">{state.name}</span>
    </span>
  );
}

export function StatePillPicker({
  states,
  value,
  onChange,
  dense = false,
  disabled = false,
  align = "left",
}: {
  states: TaskState[];
  /** Selected state id. Pass `null` to show the unselected affordance. */
  value: string | null;
  onChange: (stateId: string) => void;
  dense?: boolean;
  disabled?: boolean;
  /** Which edge of the trigger the popover hugs. Use `right` when the
   *  trigger lives near a right-edge container (peek side rail) so the
   *  popover grows leftward instead of clipping off-screen. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);

  // Group states by canonical bucket so the popover renders a section
  // per group (Plane behaviour). Within a group, states sort by
  // `position` so custom states slot in where the user placed them.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? states.filter((s) => s.name.toLowerCase().includes(q))
      : states;
    const out: Record<string, TaskState[]> = {};
    for (const s of filtered) {
      const g = s.group as string;
      (out[g] ??= []).push(s);
    }
    for (const k of Object.keys(out)) {
      out[k]!.sort((a, b) => a.position - b.position);
    }
    return out;
  }, [states, query]);

  // Flattened render order — drives keyboard navigation and matches
  // the visual order of the popover.
  const flat = useMemo(() => {
    const out: TaskState[] = [];
    for (const g of GROUP_ORDER) {
      const list = grouped[g];
      if (list) out.push(...list);
    }
    // Append any custom groups outside the canonical 5 at the bottom
    // (defensive — backend enforces the group enum, but a hand-edited
    // file might smuggle one through).
    for (const g of Object.keys(grouped)) {
      if (!GROUP_ORDER.includes(g as TaskStateGroup)) {
        out.push(...grouped[g]!);
      }
    }
    return out;
  }, [grouped]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      const insideTrigger = rootRef.current?.contains(t) ?? false;
      // Popover is portalled to document.body, so a click inside it
      // would otherwise look "outside" the trigger and dismiss
      // immediately. Treat the portal node as inside, too.
      const insidePopover = popoverRef.current?.contains(t) ?? false;
      if (!insideTrigger && !insidePopover) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Position the portalled dropdown against the trigger. `fixed`
  // coordinates escape every scrollable / overflow-hidden ancestor —
  // critical inside the peek's clipped grid, but also a strict win
  // anywhere a parent might scroll the trigger out from under the
  // dropdown.
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

  const selected = states.find((s) => s.id === value) ?? null;

  function commit(s: TaskState) {
    onChange(s.id);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(flat.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = flat[cursor];
      if (s) commit(s);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  const triggerSize = dense
    ? "h-5 pl-[6px] pr-[6px] text-[10.5px]"
    : "h-6 pl-[7px] pr-[7px] text-[11.5px]";

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 ${triggerSize} rounded-full border-[0.5px] border-line-soft bg-bg-content hover:border-line transition-colors ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        {selected ? (
          <>
            <StateGlyph
              group={selected.group as string}
              color={selected.color}
              size={dense ? 9 : 11}
            />
            <span className="truncate max-w-[120px] text-text-2">
              {selected.name}
            </span>
          </>
        ) : (
          <span className="text-text-4">Pick state</span>
        )}
        {!disabled && (
          <ChevronDown
            className="w-2.5 h-2.5 text-text-5"
            strokeWidth={1.5}
            aria-hidden
          />
        )}
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
            placeholder="Search states…"
            className="w-full bg-transparent border-b border-line-soft px-2.5 py-1.5 text-[12px] text-text-1 focus:outline-none placeholder:text-text-5"
          />
          <div className="max-h-[280px] overflow-y-auto py-1">
            {flat.length === 0 && (
              <div className="px-2.5 py-2 text-[11px] text-text-5">
                No states match “{query}”.
              </div>
            )}
            {GROUP_ORDER.filter((g) => (grouped[g]?.length ?? 0) > 0).map((g) => (
              <div key={g}>
                <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-text-5">
                  {GROUP_LABEL[g]}
                </div>
                {grouped[g]!.map((s) => {
                  const idx = flat.indexOf(s);
                  const active = idx === cursor;
                  const isSelected = s.id === value;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => commit(s)}
                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-left ${active ? "bg-bg-2" : "hover:bg-bg-2"}`}
                    >
                      <StateGlyph
                        group={s.group as string}
                        color={s.color}
                        size={11}
                      />
                      <span className="flex-1 min-w-0 truncate text-text-1">
                        {s.name}
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
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
