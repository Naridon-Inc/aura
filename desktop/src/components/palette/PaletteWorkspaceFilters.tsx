// The Workspaces tab's filters, in the compact size the palette draws them:
// who opened it (in a cloud with more than one member), which repository
// (when there is more than one), and whether archived ones show.

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Archive, ChevronDown, Folder, Users } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import type { CloudMember } from "../ui/cloud-workspace";
import { RepositoryPicture } from "./PaletteWorkspaceRow";
import {
  ARCHIVE_FILTER_LABEL,
  toggleId,
  type ArchiveFilter,
  type PaletteWorkspace,
  type WorkspaceFilters,
} from "./paletteWorkspaces";

const FilterButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { icon: ReactNode; label: string }
>(({ icon, label, ...props }, ref) => (
  <button ref={ref} type="button" className="ui-command-palette-filter" {...props}>
    {icon}
    <span>{label}</span>
    <ChevronDown className="ui-command-palette-filter-chevron" />
  </button>
));
FilterButton.displayName = "FilterButton";

export function PaletteWorkspaceFilters({
  filters,
  onChange,
  members,
  repositories,
}: {
  filters: WorkspaceFilters;
  onChange: (next: WorkspaceFilters) => void;
  members: CloudMember[];
  repositories: { id: string; name: string; repo: PaletteWorkspace["repo"] }[];
}) {
  const owner =
    filters.owners.length === 0
      ? "Anyone"
      : filters.owners.length === 1
        ? (members.find((m) => m.id === filters.owners[0])?.name ?? "1 person")
        : `${filters.owners.length} people`;
  const picked = repositories.find((r) => r.id === filters.projects[0]);
  const repository =
    filters.projects.length === 0
      ? "All repositories"
      : filters.projects.length === 1
        ? (picked?.name ?? "1 repository")
        : `${filters.projects.length} repositories`;
  return (
    <div className="ui-command-palette-filters">
      {members.length > 1 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <FilterButton icon={<Users />} label={owner} aria-label="Filter by owner" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="ui-command-palette-filter-menu">
            <DropdownMenuCheckboxItem
              checked={filters.owners.length === 0}
              onCheckedChange={() => onChange({ ...filters, owners: [] })}
            >
              Anyone
            </DropdownMenuCheckboxItem>
            {members.map((m) => (
              <DropdownMenuCheckboxItem
                key={m.id}
                checked={filters.owners.includes(m.id)}
                onCheckedChange={() => onChange({ ...filters, owners: toggleId(filters.owners, m.id) })}
              >
                <Avatar className="ui-command-palette-filter-avatar" style={{ background: m.color }}>
                  {m.photo && <AvatarImage src={m.photo} alt="" />}
                  <AvatarFallback>{m.initials}</AvatarFallback>
                </Avatar>
                <span className="ui-command-palette-filter-name">{m.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {repositories.length > 1 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <FilterButton
              icon={
                (filters.projects.length === 1 && picked?.repo && (
                  <RepositoryPicture repo={picked.repo} name={picked.name} />
                )) || <Folder />
              }
              label={repository}
              aria-label="Filter by repository"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="ui-command-palette-filter-menu">
            <DropdownMenuCheckboxItem
              checked={filters.projects.length === 0}
              onCheckedChange={() => onChange({ ...filters, projects: [] })}
            >
              All repositories
            </DropdownMenuCheckboxItem>
            {repositories.map((r) => (
              <DropdownMenuCheckboxItem
                key={r.id}
                checked={filters.projects.includes(r.id)}
                onCheckedChange={() => onChange({ ...filters, projects: toggleId(filters.projects, r.id) })}
              >
                <RepositoryPicture repo={r.repo} name={r.name} />
                <span className="ui-command-palette-filter-name">{r.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <FilterButton
            icon={<Archive />}
            label={ARCHIVE_FILTER_LABEL[filters.archive]}
            aria-label="Archived workspaces"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="ui-command-palette-filter-menu">
          <DropdownMenuRadioGroup
            value={filters.archive}
            onValueChange={(v) => onChange({ ...filters, archive: v as ArchiveFilter })}
          >
            {(Object.keys(ARCHIVE_FILTER_LABEL) as ArchiveFilter[]).map((key) => (
              <DropdownMenuRadioItem key={key} value={key}>
                {ARCHIVE_FILTER_LABEL[key]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
