// The right rail — the reference (entire.io) FILTERS panel. Each category is
// a checkbox row with a small glyph and a live count; "Tool calls" is a parent
// that folds out into its kinds (file edits / bash / read / other) and toggles
// them as a group. A VIEW section below holds the non-filter view switches
// (show hidden indicators, expand all tool calls, jump to latest).

import { useState } from "react";
import { Chevron } from "./TranscriptMessage";
import { KIND_COLOR, type Counts, type FilterKey } from "./model";

const TOOL_KEYS: FilterKey[] = ["edit", "bash", "read", "other"];

export function FiltersPanel({
  counts,
  enabled,
  onToggle,
  onToolsAll,
  showHidden,
  onShowHidden,
  expandAll,
  onExpandAll,
  newestFirst,
  onToggleOrder,
  onJumpLatest,
}: {
  counts: Counts;
  enabled: Set<FilterKey>;
  onToggle: (k: FilterKey) => void;
  onToolsAll: (on: boolean) => void;
  showHidden: boolean;
  onShowHidden: () => void;
  expandAll: boolean;
  onExpandAll: () => void;
  newestFirst: boolean;
  onToggleOrder: () => void;
  onJumpLatest: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(true);
  const toolTotal = counts.edit + counts.bash + counts.read + counts.other;
  const allToolsOn = TOOL_KEYS.every((k) => enabled.has(k));

  return (
    <div className="flex flex-col gap-4 px-3 py-3">
      <div>
        <div className="section-label mb-1.5">
          Filters
        </div>
        <div className="flex flex-col">
          <FilterRow
            icon={<PromptGlyph />}
            label="Prompts"
            count={counts.prompt}
            checked={enabled.has("prompt")}
            onClick={() => onToggle("prompt")}
          />
          <FilterRow
            icon={<ResponseGlyph />}
            label="Responses"
            count={counts.response}
            checked={enabled.has("response")}
            onClick={() => onToggle("response")}
          />
          <FilterRow
            icon={<CheckpointGlyph />}
            label="Save points"
            count={counts.checkpoint}
            checked={enabled.has("checkpoint")}
            onClick={() => onToggle("checkpoint")}
          />

          {/* Tool calls — parent toggles the whole group; chevron folds the
              per-kind children. */}
          <div className="flex items-center">
            <FilterRow
              icon={<ToolGlyph />}
              label="Tool calls"
              count={toolTotal}
              checked={allToolsOn}
              onClick={() => onToolsAll(!allToolsOn)}
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => setToolsOpen((v) => !v)}
              aria-label={toolsOpen ? "Collapse tool kinds" : "Expand tool kinds"}
              className="shrink-0 px-1.5 py-1 text-text-4 hover:text-text-2"
            >
              <Chevron open={toolsOpen} />
            </button>
          </div>
          {toolsOpen ? (
            <div className="ml-3 flex flex-col border-l border-line-soft/60 pl-1">
              <ToolChildRow
                kind="edit"
                label="File edits"
                count={counts.edit}
                checked={enabled.has("edit")}
                onClick={() => onToggle("edit")}
              />
              <ToolChildRow
                kind="bash"
                label="Bash"
                count={counts.bash}
                checked={enabled.has("bash")}
                onClick={() => onToggle("bash")}
              />
              <ToolChildRow
                kind="read"
                label="Read"
                count={counts.read}
                checked={enabled.has("read")}
                onClick={() => onToggle("read")}
              />
              <ToolChildRow
                kind="other"
                label="Other"
                count={counts.other}
                checked={enabled.has("other")}
                onClick={() => onToggle("other")}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div>
        <div className="section-label mb-1.5">
          View
        </div>
        <div className="flex flex-col gap-0.5">
          <ToggleRow
            icon={<OrderGlyph />}
            label="Newest first"
            checked={newestFirst}
            onClick={onToggleOrder}
          />
          <ToggleRow
            icon={<EyeGlyph />}
            label="Show background activity"
            count={counts.system}
            checked={showHidden}
            onClick={onShowHidden}
          />
          <ToggleRow
            icon={<ExpandGlyph />}
            label="Expand all tool calls"
            checked={expandAll}
            onClick={onExpandAll}
          />
          <button
            type="button"
            onClick={onJumpLatest}
            className="mt-1 flex items-center gap-2 rounded px-1.5 py-1 text-left text-sm text-text-2 hover:bg-state-hover hover:text-text-1"
          >
            <span className="flex h-3.5 w-3.5 items-center justify-center text-text-4">
              <DownGlyph />
            </span>
            Jump to latest
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterRow({
  icon,
  label,
  count,
  checked,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  checked: boolean;
  onClick: () => void;
  className?: string;
}) {
  const disabled = count === 0;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      className={
        "flex items-center gap-2 rounded px-1.5 py-1 text-left " +
        (disabled ? "cursor-default opacity-40 " : "hover:bg-state-hover ") +
        (className ?? "")
      }
    >
      <Checkbox checked={checked && !disabled} />
      <span className="flex h-3.5 w-3.5 items-center justify-center text-text-4">
        {icon}
      </span>
      <span
        className={
          "min-w-0 flex-1 truncate text-base " +
          (checked && !disabled ? "text-text-1" : "text-text-3")
        }
      >
        {label}
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums text-text-4">
        {count}
      </span>
    </button>
  );
}

function ToolChildRow({
  kind,
  label,
  count,
  checked,
  onClick,
}: {
  kind: FilterKey;
  label: string;
  count: number;
  checked: boolean;
  onClick: () => void;
}) {
  const disabled = count === 0;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      className={
        "flex items-center gap-2 rounded px-1.5 py-1 text-left " +
        (disabled ? "cursor-default opacity-40" : "hover:bg-state-hover")
      }
    >
      <Checkbox checked={checked && !disabled} />
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: KIND_COLOR[kind as keyof typeof KIND_COLOR] }}
        aria-hidden
      />
      <span
        className={
          "min-w-0 flex-1 truncate text-sm " +
          (checked && !disabled ? "text-text-2" : "text-text-3")
        }
      >
        {label}
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums text-text-4">
        {count}
      </span>
    </button>
  );
}

function ToggleRow({
  icon,
  label,
  count,
  checked,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-state-hover"
    >
      <Checkbox checked={checked} />
      <span className="flex h-3.5 w-3.5 items-center justify-center text-text-4">
        {icon}
      </span>
      <span
        className={
          "min-w-0 flex-1 truncate text-base " +
          (checked ? "text-text-1" : "text-text-3")
        }
      >
        {label}
      </span>
      {typeof count === "number" ? (
        <span className="shrink-0 font-mono text-xs tabular-nums text-text-4">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={
        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border " +
        (checked ? "border-transparent bg-accent" : "border-line")
      }
    >
      {checked ? (
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M2.5 6.5l2 2 5-5"
            stroke="var(--color-bg-content)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  );
}

// ── small line glyphs (match the reference's quiet icon set) ──────────

function PromptGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v4A1.5 1.5 0 0 1 11.5 10H7l-3 2.5V10H4.5A1.5 1.5 0 0 1 3 8.5v-4Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ResponseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3.5" y="2.5" width="9" height="11" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.6 5.5h4.8M5.6 8h4.8M5.6 10.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function CheckpointGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="5" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="5" cy="11.5" r="1.7" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 6.7v3.1M6.6 5.6c2 .4 2.9 1.2 3.1 2.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ToolGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.5 3.2a2.6 2.6 0 0 0 3.3 3.3l-2 2 .9.9-3.4 3.4a1.3 1.3 0 0 1-1.8-1.8l3.4-3.4-.9-.9 2-2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OrderGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M5 12V4M5 4L2.7 6.3M5 4l2.3 2.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 5.5h4M9.5 8.5h4M9.5 11.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function EyeGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2 8s2.3-4 6-4 6 4 6 4-2.3 4-6 4-6-4-6-4Z" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ExpandGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 4l-2 0 0 2M10 4l2 0 0 2M6 12l-2 0 0-2M10 12l2 0 0-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function DownGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3v8M4.5 7.5L8 11l3.5-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
