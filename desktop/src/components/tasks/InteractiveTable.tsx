// InteractiveTable — RR.2. Plane-style chrome wrapping any <table>.
//
// Three opt-in primitives:
//   1. `.doc-table-wrap` shell: reserves 38px on the left so per-row
//      handles have a visible slot, and 18px on the right + 12px on
//      the bottom so the add-col / add-row pills don't collide with
//      table content.
//   2. add-row pill (bottom edge): a thin always-visible line that
//      reveals a `+` on hover. Click fires `onAddRow`.
//   3. add-col pill (right edge): same pattern, vertical. Fires
//      `onAddColumn`.
//
// Per-row handles render via the sibling `InteractiveTableRowHandle`
// subcomponent — consumers prepend it inside a leading `<td>` so the
// glyph cluster lives inline with the row rather than absolute-
// positioned (which is unreliable on `<tr>`s). Pair it with
// `className="group"` on the row so `group-hover` reveals the icons.

import { GripVertical, Plus, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

type Props = {
  children: ReactNode;
  /** Called when the bottom pill is clicked. When omitted, the pill
   *  is not rendered (some surfaces don't support inline create). */
  onAddRow?: () => void;
  /** Called when the right-edge pill is clicked. When omitted, the
   *  pill is not rendered. */
  onAddColumn?: () => void;
  className?: string;
};

export function InteractiveTable({
  children,
  onAddRow,
  onAddColumn,
  className,
}: Props) {
  return (
    <div
      className={cn(
        "relative h-full w-full pl-[38px] pr-[18px] pb-[12px]",
        className,
      )}
    >
      {children}
      {onAddColumn && (
        <button
          type="button"
          onClick={onAddColumn}
          aria-label="Add column"
          className={cn(
            "group absolute top-0 bottom-[12px] right-[6px] w-[6px]",
            "flex items-center justify-center",
            "border-l border-dashed border-line-soft/40",
            "hover:border-line-soft/80 transition-colors",
          )}
        >
          <span
            className={cn(
              "opacity-0 group-hover:opacity-100 transition-opacity",
              "rounded-[2px] bg-bg-2 border border-line-soft p-px",
            )}
          >
            <Plus className="w-3 h-3 text-text-4" strokeWidth={1.5} aria-hidden />
          </span>
        </button>
      )}
      {onAddRow && (
        <button
          type="button"
          onClick={onAddRow}
          aria-label="Add row"
          className={cn(
            "group absolute left-[38px] right-[18px] bottom-[2px] h-[6px]",
            "flex items-center justify-center",
            "border-t border-dashed border-line-soft/40",
            "hover:border-line-soft/80 transition-colors",
          )}
        >
          <span
            className={cn(
              "opacity-0 group-hover:opacity-100 transition-opacity",
              "rounded-[2px] bg-bg-2 border border-line-soft p-px",
            )}
          >
            <Plus className="w-3 h-3 text-text-4" strokeWidth={1.5} aria-hidden />
          </span>
        </button>
      )}
    </div>
  );
}

type RowHandleProps = {
  /** Called when the sparkle is clicked. The handle still renders
   *  when omitted — the AI button just hides — so the grip alignment
   *  stays stable across rows. */
  onAi?: () => void;
};

export function InteractiveTableRowHandle({ onAi }: RowHandleProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[1px]",
        "opacity-0 group-hover:opacity-100 transition-opacity",
      )}
    >
      {onAi && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAi();
          }}
          aria-label="AI"
          className="p-[1px] rounded-sm text-text-5 hover:text-[var(--color-ai-pink)] hover:bg-bg-2"
        >
          <Sparkles className="w-3 h-3" strokeWidth={1.5} aria-hidden />
        </button>
      )}
      <span
        aria-hidden
        className="text-text-5 cursor-grab hover:text-text-3 select-none"
      >
        <GripVertical className="w-3 h-3" strokeWidth={1.5} aria-hidden />
      </span>
    </span>
  );
}
