// Collapsible group header used by the right-rail Changes panel.
// Renders chevron + title + count + optional trailing action slot
// (e.g. "Stage all"). When count is zero the section auto-hides — an
// empty Untracked group shouldn't take up rail space.

import type { ReactNode } from "react";

type Props = {
  title: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Trailing controls — buttons shown next to the count chip,
   *  visible only when the row is hovered. */
  actions?: ReactNode;
};

export function CategorySection({
  title,
  count,
  isOpen,
  onToggle,
  children,
  actions,
}: Props) {
  if (count === 0) return null;
  return (
    <div className="min-w-0 overflow-hidden border-b border-line-soft last:border-b-0">
      <div className="group flex items-center min-w-0 hover:bg-bg-2/60 transition-colors">
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 flex items-center gap-2 px-3 py-2 text-left min-w-0"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            className={`text-text-3 shrink-0 transition-transform duration-150 ${
              isOpen ? "rotate-90" : ""
            }`}
          >
            <path
              d="M6 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-[11px] font-semibold text-text-2 truncate uppercase tracking-wider">
            {title}
          </span>
          <span className="text-[10.5px] text-text-3 shrink-0 tabular-nums font-medium">
            {count}
          </span>
        </button>
        {actions && (
          <div className="pr-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
            {actions}
          </div>
        )}
      </div>
      {isOpen && (
        <div className="px-1 pb-1.5 min-w-0 overflow-hidden">{children}</div>
      )}
    </div>
  );
}
