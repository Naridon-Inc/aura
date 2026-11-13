// The list's own heading: "My workspaces", which folds or unfolds every
// section at once (right-click it for a new section), and its actions behind
// "…" on hover: group by, filter by project, sort by, a new section, and add
// a project. "Add project…" opens a small menu under
// the heading (open a folder, clone from GitHub, quick start), not a folder
// dialog straight away. ⌥⌘A opens the same menu.

import { useEffect, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Ellipsis, FolderPlus, Plus } from "lucide-react";
import { useAfterMenuClose } from "../../ui/after-menu-close";
import { Button } from "../../ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../../ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { ADD_PROJECT_EVENT, type AddProjectDetail } from "../../../lib/workspaceShortcuts";
import { AddProjectMenu } from "./addProject/AddProjectMenu";
import type { RosterSort } from "./rosterLayout";
import { RosterMenuChoice } from "./RosterMenuChoice";
import type { RosterGroupBy } from "./rosterStatusLayout";
import "./roster.css";

export type RosterRepoOption = { id: string; name: string };

/** At this many projects the filter becomes a searchable list. */
const SEARCH_AT = 5;
const ALL = "all";
const GROUP_OPTIONS = [
  { value: "status", label: "Status" },
  { value: "repo", label: "Project" },
] as const satisfies readonly { value: RosterGroupBy; label: string }[];
const SORT_OPTIONS = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
] as const satisfies readonly { value: RosterSort; label: string }[];

export function RosterGroupHeader({
  anyExpanded,
  onToggleAll,
  groupBy,
  onGroupBy,
  sort,
  onSort,
  repos,
  repoFilter,
  onRepoFilter,
  onAddProject,
  onNewSection,
  actions = true,
}: {
  anyExpanded: boolean;
  onToggleAll: () => void;
  groupBy: RosterGroupBy;
  /** Omit where the list can't be grouped another way (a machine's list is
   *  filed by repository only). */
  onGroupBy?: (groupBy: RosterGroupBy) => void;
  sort: RosterSort;
  onSort: (sort: RosterSort) => void;
  /** The projects the filter offers; it shows once there is more than one. */
  repos: RosterRepoOption[];
  repoFilter: string | null;
  onRepoFilter: (id: string | null) => void;
  onAddProject?: () => void;
  /** Open the "New section" dialog. Omit where sections aren't kept. */
  onNewSection?: () => void;
  /** Omit the "…" menu altogether. */
  actions?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  // ⌥⌘A (lib/keymap.ts `add_project`). Next frame, so whatever had focus has
  // let go before the menu takes it.
  const canAdd = actions && !!onAddProject;
  useEffect(() => {
    if (!canAdd) return;
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<AddProjectDetail | undefined>).detail;
      if (detail) {
        if (detail.handled) return;
        detail.handled = true;
      }
      requestAnimationFrame(() => setAdding(true));
    };
    window.addEventListener(ADD_PROJECT_EVENT, onAsk);
    return () => window.removeEventListener(ADD_PROJECT_EVENT, onAsk);
  }, [canAdd]);
  // The section dialog and the add-project menu both take focus, so they
  // open once the menu that asked for them has closed, not under it.
  const afterClose = useAfterMenuClose();
  const newSection = afterClose.later(onNewSection);
  const addProject = afterClose.later(() => setAdding(true));
  const fold = (
    <button
      type="button"
      onClick={onToggleAll}
      aria-expanded={anyExpanded}
      title={anyExpanded ? "Collapse all" : "Expand all"}
    >
      <span>My workspaces</span>
      <span className="ui-roster-header-gap" aria-hidden />
      <ChevronDown size={12} className="ui-section-chevron" data-collapsed={!anyExpanded} />
    </button>
  );
  return (
    <div className="ui-sidebar-group-header ui-roster-group-header">
      {actions && onNewSection ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{fold}</ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={afterClose.onCloseAutoFocus}>
            <ContextMenuItem onSelect={newSection}>
              <Plus />
              New section…
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        fold
      )}
      {actions && (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              size="iconXs"
              variant="ghost"
              className="ui-roster-header-actions"
              aria-label="My workspaces actions"
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={afterClose.onCloseAutoFocus}>
            {onGroupBy && (
              <RosterMenuChoice
                label="Group by"
                value={groupBy}
                options={GROUP_OPTIONS}
                onChange={onGroupBy}
              />
            )}
            {repos.length > 1 && (
              <ProjectFilter
                repos={repos}
                value={repoFilter}
                onChange={(id) => {
                  onRepoFilter(id);
                  setOpen(false);
                }}
              />
            )}
            <RosterMenuChoice
              label="Sort by"
              value={sort}
              options={SORT_OPTIONS}
              onChange={onSort}
            />
            {(onNewSection || onAddProject) && <DropdownMenuSeparator />}
            {onNewSection && (
              <DropdownMenuItem onSelect={newSection}>
                <Plus />
                New section…
              </DropdownMenuItem>
            )}
            {onAddProject && (
              <DropdownMenuItem onSelect={addProject}>
                <FolderPlus />
                Add project…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {actions && onAddProject && (
        <AddProjectMenu open={adding} onOpenChange={setAdding} onOpenProject={onAddProject} />
      )}
    </div>
  );
}

/** "Filter by project": all projects, or one. A long list is searched. */
function ProjectFilter({
  repos,
  value,
  onChange,
}: {
  repos: RosterRepoOption[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const options = [{ id: ALL, name: "All projects" }, ...repos];
  const current = value ?? ALL;
  const pick = (id: string) => onChange(id === ALL ? null : id);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Filter by project</DropdownMenuSubTrigger>
      {repos.length >= SEARCH_AT ? (
        <DropdownMenuSubContent sideOffset={6} className="ui-roster-filter-search">
          <Command
            loop
            filter={(id, search, keywords) =>
              id === ALL
                ? Number(search.trim() === "")
                : Number((keywords ?? []).some((k) => k.toLowerCase().includes(search.trim().toLowerCase())))
            }
            // The menu's own keys (type-to-select, arrows between rows) stay
            // out of the search field; Escape and Tab still close it.
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
            }}
          >
            <CommandInput
              aria-label="Search repositories"
              placeholder="Search..."
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
            />
            <CommandList>
              <CommandEmpty>No repositories found</CommandEmpty>
              {options.map((o) => (
                <CommandItem
                  key={o.id}
                  value={o.id}
                  keywords={[o.name]}
                  data-checked={current === o.id || undefined}
                  onSelect={() => pick(o.id)}
                >
                  <span className="ui-roster-filter-name">{o.name}</span>
                  {current === o.id && <Check size={16} />}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </DropdownMenuSubContent>
      ) : (
        <DropdownMenuSubContent sideOffset={6} className="ui-roster-choice">
          {options.map((o) => (
            <DropdownMenuItem
              key={o.id}
              role="menuitemradio"
              aria-checked={current === o.id}
              onSelect={() => pick(o.id)}
            >
              <span className="ui-roster-filter-name">{o.name}</span>
              {current === o.id && <Check size={16} />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      )}
    </DropdownMenuSub>
  );
}
