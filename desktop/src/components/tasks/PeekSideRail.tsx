// PeekSideRail — Plane mockup `.peek-side` properties panel, rendered
// 1-to-1 from `docs/plane-app-examples.html` (line 5749 + `renderProps`
// at 6920). Replaces the chunky card-headers the side rail used to use
// with a flat list of `.prop` rows grouped by hairline dividers:
//
//   • State       → StatePillPicker
//   • Priority    → 5-stop popover (urgent / high / medium / low / none)
//   • Assignees   → AssigneePicker (multi)
//   ─────────────
//   • Labels      → existing LabelsCard popover, inlined
//   • Cycle       → select popover
//   • Module      → select popover
//   ─────────────
//   • Start       → date popover (native input, opens on click)
//   • Due         → date popover
//   ─────────────
//   • Sub-issues, Dependencies, Relations
//     (richer UIs — kept as existing cards but compacted)
//
// The flat layout matches the mockup `.prop` grid (80px label · 1fr
// value, 12px font); each value is a `.prop-btn` ghost trigger that
// reveals a popover on click. Empty states use `Set date`, `Unassigned`,
// `No cycle` placeholders straight from the mockup.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Calendar,
  Check,
  CircleDot,
  Crown,
  Layers,
  Link2,
  RotateCw,
  Search,
  Sparkles,
  Tag,
  User,
  X,
} from "lucide-react";
import {
  DependenciesCard,
  LabelsCard,
  RelationsCard,
  SubIssuesCard,
} from "./TaskDetailSidePanel";
import { Button } from "../ui/button";
import { StatePillPicker } from "./StatePill";
import { AssigneePicker } from "../AssigneePicker";
import type {
  Cycle,
  Module,
  Task,
  TaskPriority,
  TaskState,
  TeamMember,
  UpdateTaskInput,
} from "../../lib/api";

type Props = {
  task: Task;
  allTasks: Task[];
  members: TeamMember[];
  taskStates?: TaskState[];
  cycles?: Cycle[];
  modules?: Module[];
  repoRoot: string;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  onCreateChild?: (parentId: string, title: string) => Promise<void>;
};

const PRIORITY_OPTIONS: { id: TaskPriority; label: string; tone: string }[] = [
  { id: "urgent", label: "Urgent", tone: "text-red-300" },
  { id: "high", label: "High", tone: "text-red-300" },
  { id: "medium", label: "Medium", tone: "text-amber-300" },
  { id: "low", label: "Low", tone: "text-sky-300" },
  { id: "none", label: "None", tone: "text-text-4" },
];

export function PeekSideRail({
  task,
  allTasks,
  members,
  taskStates = [],
  cycles = [],
  modules = [],
  repoRoot,
  onPatch,
  onCreateChild,
}: Props) {
  return (
    <div className="text-[12px] space-y-1">
      {/* — Group 1: state, priority, assignees — */}
      <PropRow icon={<CircleDot className="w-3.5 h-3.5" />} label="State">
        {taskStates.length > 0 ? (
          <StatePillPicker
            states={taskStates}
            value={task.state_id ?? null}
            onChange={(stateId) =>
              void onPatch({ id: task.id, state_id: stateId })
            }
            align="right"
          />
        ) : (
          <span className="text-text-4 text-[12px] px-1">{task.status}</span>
        )}
      </PropRow>

      <PropRow icon={<AlertCircle className="w-3.5 h-3.5" />} label="Priority">
        <PriorityPropBtn task={task} onPatch={onPatch} />
      </PropRow>

      <PropRow icon={<User className="w-3.5 h-3.5" />} label="Assignees">
        <AssigneePicker
          values={task.assignee_ids}
          onChangeMulti={(handles) =>
            void onPatch({ id: task.id, assignee_ids: handles })
          }
          members={members}
          align="right"
        />
      </PropRow>

      <Divider />

      {/* — Group 2: labels, cycle, module — */}
      <PropRow icon={<Tag className="w-3.5 h-3.5" />} label="Labels">
        <InlineLabelsBtn task={task} onPatch={onPatch} />
      </PropRow>

      {cycles.length > 0 && (
        <PropRow icon={<RotateCw className="w-3.5 h-3.5" />} label="Cycle">
          <SelectPropBtn
            value={task.cycle_id ?? ""}
            options={[
              { id: "", label: "No cycle" },
              ...cycles.map((c) => ({ id: c.id, label: c.name })),
            ]}
            onChange={(v) => void onPatch({ id: task.id, cycle_id: v })}
            placeholder="No cycle"
          />
        </PropRow>
      )}

      {modules.length > 0 && (
        <PropRow icon={<Layers className="w-3.5 h-3.5" />} label="Module">
          <SelectPropBtn
            value={task.module_id ?? ""}
            options={[
              { id: "", label: "No module" },
              ...modules.map((m) => ({ id: m.id, label: m.name })),
            ]}
            onChange={(v) => void onPatch({ id: task.id, module_id: v })}
            placeholder="No module"
          />
        </PropRow>
      )}

      <Divider />

      {/* — Group 3: epic / parent linkage — */}
      <PropRow icon={<Crown className="w-3.5 h-3.5" />} label="Parent">
        <ParentPropBtn task={task} allTasks={allTasks} onPatch={onPatch} />
      </PropRow>

      <PropRow icon={<Sparkles className="w-3.5 h-3.5" />} label="Is epic">
        <EpicTogglePropBtn task={task} onPatch={onPatch} />
      </PropRow>

      <Divider />

      {/* — Group 4: dates — */}
      <PropRow icon={<Calendar className="w-3.5 h-3.5" />} label="Start">
        <DatePropBtn
          value={task.start_date ?? ""}
          onChange={(v) => void onPatch({ id: task.id, start_date: v })}
        />
      </PropRow>

      <PropRow icon={<Calendar className="w-3.5 h-3.5" />} label="Due">
        <DatePropBtn
          value={task.due_date ?? ""}
          onChange={(v) => void onPatch({ id: task.id, due_date: v })}
        />
      </PropRow>

      <Divider />

      {/* — Group 4: relations / hierarchy (richer cards) — */}
      <div className="space-y-3 pt-1">
        <SubIssuesCard
          task={task}
          allTasks={allTasks}
          repoRoot={repoRoot}
          onCreateChild={onCreateChild}
        />
        <DependenciesCard task={task} allTasks={allTasks} />
        <RelationsCard task={task} allTasks={allTasks} repoRoot={repoRoot} />
        <HiddenLabelsCardData task={task} onPatch={onPatch} />
      </div>
    </div>
  );
}

// Mockup `.prop` — grid 80px / 1fr, 12px font, value sits in a ghost
// button (`.prop-btn`). Label slot accepts an icon-and-text combo.
function PropRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      className="grid items-start gap-2.5 py-1.5"
      style={{ gridTemplateColumns: "84px 1fr" }}
    >
      <span className="text-text-4 pt-[5px] inline-flex items-center gap-1.5 leading-none">
        <span className="text-text-5">{icon}</span>
        <span className="text-[12px]">{label}</span>
      </span>
      <div className="text-text-1 min-w-0">{children}</div>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-line-soft/60 my-2" />;
}

// ── Priority popover ─────────────────────────────────────────────────

function PriorityPropBtn({
  task,
  onPatch,
}: {
  task: Task;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), popoverRef);
  const current =
    PRIORITY_OPTIONS.find((o) => o.id === task.priority) ?? PRIORITY_OPTIONS[4]!;
  return (
    <div ref={wrapRef} className="relative">
      <PropBtn onClick={() => setOpen((v) => !v)}>
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            current.id === "none" ? "bg-text-5" : current.tone.replace("text-", "bg-")
          }`}
        />
        <span className={current.id === "none" ? "text-text-5" : ""}>
          {current.id === "none" ? "No priority" : current.label}
        </span>
      </PropBtn>
      <Popover anchorRef={wrapRef} popoverRef={popoverRef} open={open}>
        {PRIORITY_OPTIONS.map((o) => (
          <PopoverItem
            key={o.id}
            selected={o.id === task.priority}
            onClick={() => {
              void onPatch({ id: task.id, priority: o.id });
              setOpen(false);
            }}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                o.id === "none" ? "bg-text-5" : o.tone.replace("text-", "bg-")
              }`}
            />
            <span>{o.label}</span>
          </PopoverItem>
        ))}
      </Popover>
    </div>
  );
}

// ── Parent (epic) popover ────────────────────────────────────────────
//
// Click the prop-btn → typeahead popover listing candidate parents.
// Epics float to the top with a crown badge; non-epic tasks follow.
// "No parent" is always the first row and clears the link. The current
// task is filtered out, as are its own descendants (no cycles).

function ParentPropBtn({
  task,
  allTasks,
  onPatch,
}: {
  task: Task;
  allTasks: Task[];
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Portalled popover lives outside the wrapper, so the standard
  // useClickOutside(wrapper) call would close on every popover click.
  // Pass both refs so the hook treats either as "inside".
  useClickOutside(wrapRef, () => setOpen(false), popoverRef);
  const popoverStyle = usePortalAnchor(wrapRef, open);

  // Descendants of `task` (so we don't let a user create a cycle by
  // pointing parent at a child). Cheap BFS over the in-memory list.
  const descendants = useMemo(() => {
    const out = new Set<string>();
    const queue = [task.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const t of allTasks) {
        if (t.parent_id === cur && !out.has(t.id)) {
          out.add(t.id);
          queue.push(t.id);
        }
      }
    }
    return out;
  }, [allTasks, task.id]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = allTasks.filter((t) => {
      if (t.id === task.id) return false;
      if (descendants.has(t.id)) return false;
      if (!q) return true;
      const hay = `${t.title} ${t.sequence_id}`.toLowerCase();
      return hay.includes(q);
    });
    return filtered
      .sort((a, b) => {
        const ae = a.is_epic ? 0 : 1;
        const be = b.is_epic ? 0 : 1;
        if (ae !== be) return ae - be;
        return a.sequence_id - b.sequence_id;
      })
      .slice(0, 80);
  }, [allTasks, descendants, query, task.id]);

  const current = task.parent_id
    ? allTasks.find((t) => t.id === task.parent_id) ?? null
    : null;

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <PropBtn onClick={() => setOpen((v) => !v)}>
        {current ? (
          <span className="inline-flex items-center gap-1.5 min-w-0">
            {current.is_epic && (
              <Crown
                className="w-3 h-3 text-amber-300 flex-shrink-0"
                strokeWidth={2}
                aria-hidden
              />
            )}
            <span className="font-mono text-text-4 text-[11px]">
              AURA-{current.sequence_id}
            </span>
            <span className="truncate max-w-[140px]">{current.title}</span>
          </span>
        ) : (
          <span className="text-text-5 inline-flex items-center gap-1.5">
            <Link2 className="w-3 h-3" strokeWidth={1.75} aria-hidden />
            Link to epic
          </span>
        )}
      </PropBtn>
      {open && popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            role="listbox"
            style={popoverStyle}
            className="min-w-[300px] max-w-[360px] bg-bg-content border border-line-soft rounded-md shadow-lg overflow-hidden"
          >
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-line-soft">
              <Search className="w-3.5 h-3.5 text-text-5" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tasks or AURA-id…"
                className="flex-1 bg-transparent text-[12.5px] text-text-1 placeholder-text-5 focus:outline-none"
              />
            </div>
            <div className="max-h-[320px] overflow-y-auto py-1">
              <PopoverItem
                selected={!task.parent_id}
                onClick={() => {
                  void onPatch({ id: task.id, parent_id: "" });
                  setOpen(false);
                }}
              >
                <span className="text-text-5">No parent</span>
              </PopoverItem>
              {candidates.length === 0 ? (
                <div className="px-2.5 py-2 text-[11.5px] text-text-5 italic">
                  No matching tasks
                </div>
              ) : (
                candidates.map((t) => (
                  <PopoverItem
                    key={t.id}
                    selected={t.id === task.parent_id}
                    onClick={() => {
                      void onPatch({ id: task.id, parent_id: t.id });
                      setOpen(false);
                    }}
                  >
                    {t.is_epic ? (
                      <Crown
                        className="w-3 h-3 text-amber-300 flex-shrink-0"
                        strokeWidth={2}
                        aria-hidden
                      />
                    ) : (
                      <span className="w-3 h-3 flex-shrink-0" />
                    )}
                    <span className="font-mono text-text-4 text-[11px] flex-shrink-0">
                      AURA-{t.sequence_id}
                    </span>
                    <span className="truncate">{t.title}</span>
                  </PopoverItem>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ── Is-epic toggle ───────────────────────────────────────────────────

function EpicTogglePropBtn({
  task,
  onPatch,
}: {
  task: Task;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  const on = !!task.is_epic;
  return (
    <button
      type="button"
      onClick={() => void onPatch({ id: task.id, is_epic: !on })}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[12px] transition min-h-[26px] ${
        on
          ? "bg-amber-500/15 text-amber-200 hover:bg-amber-500/20"
          : "text-text-5 hover:text-text-1 hover:bg-bg-2"
      }`}
      title={on ? "Click to demote — this task will no longer be an epic" : "Click to promote — this task will become an epic"}
    >
      <Crown className="w-3 h-3" strokeWidth={2} aria-hidden />
      {on ? "Yes — promoted" : "Promote to epic"}
    </button>
  );
}

// ── Date popover ─────────────────────────────────────────────────────
//
// Click the prop-btn → popover with a native `<input type="date">`
// (which the OS skins for us). Picking commits via onChange and closes;
// the small × button next to the date clears the field.

function DatePropBtn({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), popoverRef);
  const popoverStyle = usePortalAnchor(wrapRef, open);
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        // showPicker pops the native calendar on Chromium; harmless
        // elsewhere because we guard the call.
        try {
          (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
        } catch {
          // Some webviews throw if showPicker isn't user-initiated;
          // the input is still focused so the keyboard works.
        }
      });
    }
  }, [open]);
  const formatted = value ? formatDate(value) : null;
  return (
    <div ref={wrapRef} className="relative inline-flex items-center gap-1">
      <PropBtn onClick={() => setOpen((v) => !v)}>
        {formatted ?? <span className="text-text-5">Set date</span>}
      </PropBtn>
      {value && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={(e) => {
            e.stopPropagation();
            onChange("");
          }}
          aria-label="Clear date"
          className="text-text-5 hover:text-text-1"
        >
          <X className="w-3 h-3" strokeWidth={1.75} aria-hidden />
        </Button>
      )}
      {open && popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ ...popoverStyle, minWidth: 200 }}
            className="bg-bg-content border border-line-soft rounded-md shadow-lg p-2"
          >
            <input
              ref={inputRef}
              type="date"
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                setOpen(false);
              }}
              className="bg-bg-1 border border-line-soft rounded px-2 py-1.5 text-[12.5px] text-text-1 focus:outline-none focus:border-line w-full"
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

// ── Generic select popover (cycle / module) ──────────────────────────

function SelectPropBtn({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), popoverRef);
  const current = options.find((o) => o.id === value);
  return (
    <div ref={wrapRef} className="relative">
      <PropBtn onClick={() => setOpen((v) => !v)}>
        {current && current.id !== "" ? (
          <span>{current.label}</span>
        ) : (
          <span className="text-text-5">{placeholder}</span>
        )}
      </PropBtn>
      <Popover anchorRef={wrapRef} popoverRef={popoverRef} open={open}>
        {options.map((o) => (
          <PopoverItem
            key={o.id || "_empty"}
            selected={o.id === value}
            onClick={() => {
              onChange(o.id);
              setOpen(false);
            }}
          >
            <span>{o.label}</span>
          </PopoverItem>
        ))}
      </Popover>
    </div>
  );
}

// ── Inline labels button (single-line chip strip + edit popover) ─────
//
// LabelsCard already owns the chip-edit popover, but its visual chrome
// is a Card with a header. We surface the chips on the prop row and
// route the "edit" click through a hidden mirror of the card so the
// existing logic (which has all the multi-select wiring) keeps working.

function InlineLabelsBtn({
  task,
  onPatch: _onPatch,
}: {
  task: Task;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  const chips = task.labels ?? [];
  return (
    <button
      type="button"
      onClick={() => {
        // Scroll the hidden LabelsCard into view so the user sees its
        // edit affordance; cheap stopgap until we lift the label
        // popover out of LabelsCard.
        document
          .getElementById("peek-side-labels-card")
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }}
      className="text-left inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-2 transition min-h-[26px] w-full"
    >
      {chips.length === 0 ? (
        <span className="text-text-5 text-[12px]">Set labels</span>
      ) : (
        <span className="inline-flex flex-wrap gap-1">
          {chips.map((l) => (
            <span
              key={l}
              className="text-[10.5px] px-1.5 py-0.5 rounded-full border border-line-soft bg-bg-2 text-text-2"
            >
              {l}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

// Mounts the original LabelsCard so its existing edit popover stays
// usable while we transition. The host wraps it in an id container so
// the inline button above can scroll to it.
function HiddenLabelsCardData({
  task,
  onPatch,
}: {
  task: Task;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  return (
    <div id="peek-side-labels-card">
      <LabelsCard task={task} onPatch={onPatch} />
    </div>
  );
}

// ── Tiny primitives ──────────────────────────────────────────────────

function PropBtn({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[12px] text-text-2 hover:text-text-1 hover:bg-bg-2 transition min-h-[26px]"
    >
      {children}
    </button>
  );
}

/// Anchor a portal-rendered popover to the trigger's right edge. The
/// peek's `aside` uses `overflow-y-auto` and the grid wrapper uses
/// `overflow: hidden`, both of which CLIP positioned descendants
/// regardless of z-index. Portalling to `document.body` is the only
/// way to escape both ancestors; positioning is recomputed on scroll
/// and resize so the popover follows its trigger.
function usePortalAnchor(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setStyle(null);
      return;
    }
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setStyle({
        position: "fixed",
        // Right-edge anchored — popover grows leftward, matching the
        // inline `right-0 top-full` behaviour the rail had before
        // overflow-clipping became a problem.
        top: rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
        zIndex: 100,
      });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open, anchorRef]);

  return style;
}

/// Generic popover container — portalled to `document.body` so it
/// escapes the peek's overflow-clipping wrappers. `anchorRef` points
/// to the trigger element it should hug; `popoverRef` is wired so
/// callers can pass it to `useClickOutside(triggerRef, …, popoverRef)`
/// and have clicks on the popover itself count as "inside".
function Popover({
  anchorRef,
  popoverRef,
  open,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  popoverRef?: RefObject<HTMLDivElement | null>;
  open: boolean;
  children: ReactNode;
}) {
  const style = usePortalAnchor(anchorRef, open);
  if (!open || !style) return null;
  return createPortal(
    <div
      ref={popoverRef}
      role="listbox"
      style={style}
      className="min-w-[180px] bg-bg-content border border-line-soft rounded-md shadow-lg py-1"
    >
      {children}
    </div>,
    document.body,
  );
}

function PopoverItem({
  children,
  selected,
  onClick,
}: {
  children: ReactNode;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected || undefined}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[12px] text-text-2 hover:bg-bg-2 hover:text-text-1"
    >
      {children}
      {selected && <Check className="w-3 h-3 ml-auto text-text-3" strokeWidth={2} aria-hidden />}
    </button>
  );
}

function useClickOutside(
  ref: { current: HTMLElement | null },
  onClose: () => void,
  extraInsideRef?: { current: HTMLElement | null },
) {
  const cb = useCallback(onClose, [onClose]);
  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as Node;
      const insideMain = ref.current?.contains(target) ?? false;
      const insideExtra =
        extraInsideRef?.current?.contains(target) ?? false;
      if (!insideMain && !insideExtra) cb();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, extraInsideRef, cb]);
}

function formatDate(yyyymmdd: string): string {
  if (!yyyymmdd) return "";
  const d = new Date(yyyymmdd + "T00:00:00");
  if (Number.isNaN(d.getTime())) return yyyymmdd;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

