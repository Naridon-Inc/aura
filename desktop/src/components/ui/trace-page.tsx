// Trace's page chrome: the 40px page header, the view strip under it, and the
// 40px toolbar a list sits beneath. Trace has no screen of its own in the
// component library, so it is drawn from the library's page compositions
// rather than a look of its own: the header is the page header every top-level
// page wears, the strip is the dashboard's underline tab list, and the toolbar
// is Home's search-and-filters bar. Same heights, same type, same tokens, so
// moving from Home or the Dashboard into Trace never changes the furniture.

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { cn } from "../../lib/utils";
import "./trace-page.css";

/** The 40px bar at the top of a page: what it is on the left, what you can do
 *  about it on the right. */
export function TraceHeader({
  title,
  leading,
  actions,
  className,
}: {
  title?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("ui-trace-header", className)}>
      {leading}
      {title != null && <span className="ui-trace-header-title">{title}</span>}
      <div className="ui-trace-header-spacer" />
      {actions && <div className="ui-trace-header-actions">{actions}</div>}
    </header>
  );
}

export interface TraceStripOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** An attention count drawn after the label. Omitted when zero. */
  count?: number;
  /** Native tooltip: a second way to learn the view, never the only one. */
  hint?: string;
}

/** The view switch under a page header. Every view is spelled out: a strip of
 *  bare glyphs makes the reader hover to find out where they can go. */
export function TraceStrip<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  trailing,
}: {
  /** `null` lights nothing — the surface below is something the strip does
   *  not name. */
  value: T | null;
  options: TraceStripOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  trailing?: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const at = options.findIndex((o) => o.value === value);
    const next = options[at + (event.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    list.current
      ?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)
      ?.focus();
  };
  return (
    <nav className="ui-dashboard-projects ui-trace-strip" aria-label={ariaLabel}>
      <div ref={list} role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              data-value={option.value}
              aria-selected={selected}
              tabIndex={selected || (value === null && index === 0) ? 0 : -1}
              title={option.hint}
              onClick={() => onChange(option.value)}
            >
              {option.icon}
              {option.label}
              {option.count ? (
                <span
                  className="ui-trace-strip-count"
                  aria-label={`${option.count} waiting`}
                >
                  {option.count > 99 ? "99+" : option.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {trailing && <div className="ui-trace-strip-trailing">{trailing}</div>}
    </nav>
  );
}

/** The 40px bar a list sits under: a search field that takes the free width,
 *  then the filters and the verbs. */
export function TraceToolbar({
  search,
  children,
}: {
  search?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="ui-home-toolbar ui-trace-toolbar">
      {search ?? <div className="ui-trace-toolbar-spacer" />}
      {children && <div className="ui-home-filters">{children}</div>}
    </div>
  );
}

export function TraceSearch({
  value,
  onChange,
  label,
  placeholder = "Search",
  controls,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  controls?: string;
}) {
  return (
    <div className="ui-home-search">
      <Search size={16} />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        aria-controls={controls}
        placeholder={placeholder}
      />
    </div>
  );
}

/** One filter in the toolbar: a quiet button naming the current choice, and a
 *  menu of the others with a check against the one in force. */
export function TraceFilterMenu<T extends string>({
  label,
  icon,
  value,
  options,
  onChange,
  align = "start",
}: {
  label: string;
  icon?: ReactNode;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  align?: "start" | "end";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={label}>
          {icon}
          {options.find((o) => o.value === value)?.label}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}>
            {option.label}
            {value === option.value && <span className="ui-menu-shortcut">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
