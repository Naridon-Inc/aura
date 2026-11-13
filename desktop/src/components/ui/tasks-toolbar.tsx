// The two bars above the Dashboard's work: the view strip (the dashboard's
// 44px tab list, one tab per way of looking at the work) and the 40px
// toolbar under it (search, then the filters and the primary verb).

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Folder, Search } from "lucide-react";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import "./tasks-toolbar.css";

export interface TaskViewOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Native tooltip: a second way to learn the view, never the only one. */
  hint?: string;
}

/** The view tabs on their own, so a surface with its own bar can carry them. */
export function TaskViewTabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: TaskViewOption<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const at = options.findIndex((o) => o.value === value);
    const next = options[at + (event.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    list.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className="ui-tasks-view-tabs"
      onKeyDown={onKeyDown}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          data-value={option.value}
          aria-selected={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          title={option.hint}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface TaskProjectOption {
  value: string;
  name: string;
  /** Native tooltip, usually the full path. */
  hint?: string;
}

/** "In all repositories" / "In <name>": which repositories the work is read
 *  from. One repository or every one, so the rows are a pick, not a set. */
export function TaskProjectMenu({
  value,
  allValue,
  projects,
  onChange,
  disabled,
}: {
  value: string;
  allValue: string;
  projects: TaskProjectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const current = projects.find((p) => p.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="Filter repository" disabled={disabled}>
          <Folder />
          In {value === allValue || !current ? "all repositories" : current.name}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => onChange(allValue)}>
          All repositories
          {value === allValue && <span className="ui-menu-shortcut">✓</span>}
        </DropdownMenuItem>
        {projects.map((p) => (
          <DropdownMenuItem key={p.value} title={p.hint} onSelect={() => onChange(p.value)}>
            {p.name}
            {value === p.value && <span className="ui-menu-shortcut">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TaskViewStrip({
  label,
  tabs,
  trailing,
}: {
  label: string;
  tabs: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <nav className="ui-dashboard-projects ui-tasks-strip" aria-label={label}>
      {tabs}
      {trailing && <div className="ui-tasks-strip-trailing">{trailing}</div>}
    </nav>
  );
}

export function TaskToolbar({ search, children }: { search: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-home-toolbar ui-tasks-toolbar">
      {search}
      {children && <div className="ui-home-filters">{children}</div>}
    </div>
  );
}

export function TaskSearch({
  value,
  onChange,
  label,
  placeholder = "Search",
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
}) {
  return (
    <div className="ui-home-search">
      <Search size={16} />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
        }}
        aria-label={label}
        placeholder={placeholder}
      />
    </div>
  );
}
