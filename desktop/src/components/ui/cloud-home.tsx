import { useRef, useState, type ReactNode } from "react";
import {
  Search,
  Users,
  Folder,
  Archive,
  ChevronDown,
  Plus,
  Play,
  ArrowDownUp,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "./button";
import { DiffCount } from "./sidebar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from "./dropdown-menu";
import {
  CloudWorkspaceGlyph,
  CollaboratorPresence,
  type CloudMember,
} from "./cloud-workspace";
import {
  WorkspaceHoverPreview,
  type WorkspaceOverview,
} from "./workspace-preview-card";
type DisplayField =
  | "repository"
  | "repositoryIcon"
  | "lineChanges"
  | "cost"
  | "owner"
  | "lastActive";
const displayLabels: Record<DisplayField, string> = {
  repository: "Repository",
  repositoryIcon: "Repository icon",
  lineChanges: "Line changes",
  cost: "Cost",
  owner: "Owner",
  lastActive: "Last active",
};
export function CloudHome({
  workspaces,
  members,
  ownerByWorkspace,
  pinnedIds,
  routineIds = [],
  selectedOwners,
  onOwnersChange,
  onOpen,
  onCreate,
  onProfile,
  leading,
  trailing,
  numberOf,
  costOf,
  strictOwners = false,
  repositoryIcon,
}: {
  workspaces: WorkspaceOverview[];
  members: CloudMember[];
  ownerByWorkspace: Record<string, string>;
  pinnedIds: string[];
  routineIds?: string[];
  selectedOwners: string[];
  onOwnersChange: (ids: string[]) => void;
  onOpen: (id: string) => void;
  /** Starts a workspace. Without it Home has no Create button: a page that
   *  only oversees the organization's work starts none of its own. */
  onCreate?: () => void;
  onProfile: (member: CloudMember) => void;
  leading?: ReactNode;
  /** Drawn at the toolbar's far end, after Create — where the page that
   *  hosts Home puts its own switches (Aura's panel). */
  trailing?: ReactNode;
  /** The row's number as the server knows it; the preview counts from W-104. */
  numberOf?: (workspace: WorkspaceOverview) => string;
  /** What the row cost, or null when nothing measured it — the cell stays empty. */
  costOf?: (workspace: WorkspaceOverview) => string | null;
  /** A row whose owner isn't in `ownerByWorkspace` has no owner, rather than the first member. */
  strictOwners?: boolean;
  /** The repository's picture, drawn wherever a repository is named; null
   *  (or left out) draws the folder. Called with the row's `projectId` when
   *  it has one, else its repository name. */
  repositoryIcon?: (id: string, name: string) => ReactNode;
}) {
  const [query, setQuery] = useState(""),
    [projects, setProjects] = useState<string[]>([]),
    [archived, setArchived] = useState("active"),
    [routine, setRoutine] = useState("hide"),
    [sort, setSort] = useState("lastActive"),
    [display, setDisplay] = useState<DisplayField[]>([
      "repository",
      "lineChanges",
      "cost",
      "owner",
      "lastActive",
    ]);
  const list = useRef<HTMLDivElement>(null);
  // Only the filters Home starts with: nothing the member chose hides rows,
  // so an empty list means there is nothing open, not "clear your filters".
  const untouched =
    !query &&
    !projects.length &&
    !selectedOwners.length &&
    archived === "active" &&
    routine === "hide";
  const ownerOf = (w: WorkspaceOverview): CloudMember | undefined =>
    members.find((m) => m.id === ownerByWorkspace[w.id]) ??
    (strictOwners ? undefined : members[0]);
  const owner = (w: WorkspaceOverview) => ownerOf(w) ?? members[0];
  const toggle = (ids: string[], id: string) =>
    ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  // The filter is keyed by repository name; its picture is looked up by the
  // id of the first row in it.
  const iconOf = (project: string, size?: number) =>
    repositoryIcon?.(
      workspaces.find((w) => w.project === project)?.projectId || project,
      project,
    ) ?? <Folder size={size} />;
  const rows = workspaces
    .filter(
      (w) =>
        (archived === "all" ||
          (archived === "archived" ? w.archived : !w.archived)) &&
        (!selectedOwners.length ||
          selectedOwners.includes(ownerOf(w)?.id ?? "")) &&
        (!projects.length || projects.includes(w.project)) &&
        (routine === "all" ||
          (routine === "only"
            ? routineIds.includes(w.id)
            : !routineIds.includes(w.id))) &&
        `${w.title} ${w.project} ${w.branch}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(pinnedIds.includes(b.id)) - Number(pinnedIds.includes(a.id)) ||
        (sort === "name"
          ? a.title.localeCompare(b.title)
          : sort === "repository"
            ? a.project.localeCompare(b.project)
            : sort === "created"
              ? (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt)
              : b.updatedAt - a.updatedAt),
    );
  const filter = (
    label: string,
    value: string,
    options: string[][],
    change: (value: string) => void,
    icon: ReactNode,
  ) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={label}>
          {icon}
          <span>{options.find(([id]) => id === value)?.[1]}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map(([id, text]) => (
          <DropdownMenuItem key={id} onSelect={() => change(id)}>
            {text}
            {value === id && <span className="ui-menu-shortcut">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <section className="ui-cloud-home" aria-label="Cloud Home">
      <div className="ui-cloud-home-toolbar">
        {leading}
        <label>
          <Search size={15} />
          <input
            aria-label="Search cloud workspaces"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="ui-cloud-home-toolbar-space" />
        <CollaboratorPresence members={members} onProfile={onProfile} />
        <div className="ui-cloud-home-filters">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Filter by teammate">
                <Users />
                <span>
                  By{" "}
                  {selectedOwners.length === 0
                    ? "anyone"
                    : selectedOwners.length === 1
                      ? members.find((m) => m.id === selectedOwners[0])?.name
                      : `${selectedOwners.length} people`}
                </span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" style={{ width: 224 }}>
              <DropdownMenuCheckboxItem
                checked={!selectedOwners.length}
                onCheckedChange={() => onOwnersChange([])}
              >
                Anyone
              </DropdownMenuCheckboxItem>
              {members.map((m) => (
                <DropdownMenuCheckboxItem
                  key={m.id}
                  checked={selectedOwners.includes(m.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() =>
                    onOwnersChange(toggle(selectedOwners, m.id))
                  }
                >
                  <span
                    className="ui-cloud-avatar ui-cloud-avatar-static"
                    style={{ background: m.color }}
                  >
                    {m.photo ? <img src={m.photo} alt="" draggable={false} /> : m.initials}
                  </span>
                  {m.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Filter repository">
                {/* One repository picked: its picture. All or several: the folder. */}
                {(projects.length === 1 && iconOf(projects[0])) || <Folder />}
                <span>
                  In{" "}
                  {!projects.length
                    ? "all repositories"
                    : projects.length === 1
                      ? projects[0]
                      : `${projects.length} repositories`}
                </span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" style={{ width: 224 }}>
              <DropdownMenuCheckboxItem
                checked={!projects.length}
                onCheckedChange={() => setProjects([])}
              >
                All repositories
              </DropdownMenuCheckboxItem>
              {[...new Set(workspaces.map((w) => w.project))].map((project) => (
                <DropdownMenuCheckboxItem
                  key={project}
                  checked={projects.includes(project)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => setProjects(toggle(projects, project))}
                >
                  {iconOf(project, 14)}
                  {project}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {filter(
            "Routine workspaces",
            routine,
            [
              ["hide", "Hiding routines"],
              ["all", "Showing all"],
              ["only", "Only routines"],
            ],
            setRoutine,
            <Play />,
          )}
          {filter(
            "Archived workspaces",
            archived,
            [
              ["active", "Hiding archived"],
              ["all", "Showing all"],
              ["archived", "Only archived"],
            ],
            setArchived,
            <Archive />,
          )}
          {filter(
            "Sort workspaces",
            sort,
            [
              ["lastActive", "Last active"],
              ["created", "Newest"],
              ["name", "Name"],
              ["repository", "Repository"],
            ],
            setSort,
            <ArrowDownUp />,
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Display columns">
                <SlidersHorizontal />
                <span>Display</span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(Object.keys(displayLabels) as DisplayField[]).map((field) => (
                <DropdownMenuCheckboxItem
                  key={field}
                  checked={display.includes(field)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() =>
                    setDisplay((fields) =>
                      fields.includes(field)
                        ? fields.filter((f) => f !== field)
                        : [...fields, field],
                    )
                  }
                >
                  {displayLabels[field]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {onCreate && (
          <Button size="xs" onClick={onCreate} aria-label="Create workspace">
            <Plus />
            Create
          </Button>
        )}
        {trailing}
      </div>
      <div className="ui-cloud-home-scroll">
        <div
          className="ui-cloud-home-list"
          ref={list}
          onKeyDown={(e) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key))
              return;
            const items = Array.from(
                list.current?.querySelectorAll<HTMLButtonElement>(
                  ".ui-cloud-home-row",
                ) ?? [],
              ),
              index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
            if (index < 0) return;
            e.preventDefault();
            items[
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : Math.min(
                      items.length - 1,
                      Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)),
                    )
            ]?.focus();
          }}
        >
          {rows.map((w) => (
            <WorkspaceHoverPreview key={w.id} workspace={w} side="bottom">
              <button
                className="ui-cloud-home-row"
                onClick={() => onOpen(w.id)}
              >
                <CloudWorkspaceGlyph
                  state={w.workflow.state === "merged" ? "done" : "idle"}
                />
                <span className="ui-cloud-home-number">
                  {numberOf
                    ? numberOf(w)
                    : `W-${104 + workspaces.findIndex((row) => row.id === w.id)}`}
                </span>
                <span className="ui-cloud-home-row-title">{w.title}</span>
                {display.includes("lineChanges") && (
                  <span className="ui-cloud-home-diff">
                    {w.added !== undefined && (
                      <DiffCount added={w.added} removed={w.removed ?? 0} />
                    )}
                  </span>
                )}
                {display.includes("cost") && (
                  <span className="ui-cloud-home-cost">
                    {costOf ? costOf(w) : w.added ? "$0.31" : "< $1"}
                  </span>
                )}
                {(display.includes("repository") ||
                  display.includes("repositoryIcon")) && (
                  <span className="ui-cloud-home-project">
                    {display.includes("repositoryIcon") &&
                      (repositoryIcon?.(w.projectId || w.project, w.project) ?? (
                        <Folder size={14} />
                      ))}{" "}
                    {display.includes("repository") && w.project}
                  </span>
                )}
                {display.includes("owner") &&
                  (ownerOf(w) ? (
                    <span
                      className="ui-cloud-avatar ui-cloud-avatar-static"
                      style={{ background: owner(w).color }}
                      role="img"
                      aria-label={owner(w).name}
                    >
                      {owner(w).photo ? (
                        <img src={owner(w).photo} alt="" draggable={false} />
                      ) : (
                        owner(w).initials
                      )}
                    </span>
                  ) : (
                    <span
                      className="ui-cloud-avatar ui-cloud-avatar-static"
                      data-unknown="true"
                      aria-hidden
                    />
                  ))}
                {display.includes("lastActive") && (
                  <time>{w.timeLabel.replace(" ago", "")}</time>
                )}
              </button>
            </WorkspaceHoverPreview>
          ))}
          {!rows.length && untouched && (
            <div className="ui-cloud-home-empty">
              <p>{workspaces.length ? "No open workspaces" : "No workspaces yet"}</p>
              {onCreate && (
                <Button size="sm" onClick={onCreate}>
                  New workspace
                </Button>
              )}
              {workspaces.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setArchived("all")}>
                  Show archived
                </Button>
              )}
            </div>
          )}
          {!rows.length && !untouched && (
            <div className="ui-cloud-home-empty">
              <p>No matching workspaces</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setProjects([]);
                  onOwnersChange([]);
                  setArchived("all");
                  setRoutine("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
