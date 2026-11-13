import { useRef, useState } from "react";
import {
  Search,
  Folder,
  Plus,
  SlidersHorizontal,
  Archive,
  ArrowDownUp,
  ChevronDown,
} from "lucide-react";
import { Button } from "./button";
import { DiffCount } from "./sidebar";
import { WorkspaceStatusIcon } from "./workspace-status";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from "./dropdown-menu";
import {
  WorkspaceHoverPreview,
  type WorkspaceOverview,
} from "./workspace-preview-card";
import { type GitWorkflowAction } from "./git-workflow";
export function WorkspaceHome({
  workspaces,
  onOpen,
  onCreate,
  onAction,
  leading,
  trailing,
  repositoryIcon,
}: {
  leading?: React.ReactNode;
  /** After Create, at the toolbar's far end — the page's own switches. */
  trailing?: React.ReactNode;
  /** The picture for a repository, by its id and name; a folder when absent. */
  repositoryIcon?: (projectId: string, project: string) => React.ReactNode;
  workspaces: WorkspaceOverview[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onAction: (id: string, action: GitWorkflowAction) => void;
}) {
  const [query, setQuery] = useState(""),
    [projects, setProjects] = useState<string[]>([]),
    [archived, setArchived] = useState("active"),
    [sort, setSort] = useState("lastActive"),
    [active, setActive] = useState(0);
  const [display, setDisplay] = useState({
    repository: true,
    repositoryIcon: false,
    lineChanges: true,
    lastActive: true,
  });
  const list = useRef<HTMLDivElement>(null);
  const allProjects = [
    ...new Map(workspaces.map((w) => [w.projectId, w.project])).entries(),
  ];
  const rows = workspaces
    .filter(
      (w) =>
        (!projects.length || projects.includes(w.projectId)) &&
        (archived === "all" ||
          (archived === "archived" ? w.archived : !w.archived)) &&
        `${w.title} ${w.branch} ${w.project}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title)
        : sort === "repository"
          ? a.project.localeCompare(b.project)
          : sort === "created"
            ? (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt)
            : b.updatedAt - a.updatedAt,
    );
  const current = Math.min(active, Math.max(0, rows.length - 1));
  const sorts = [
    ["lastActive", "Last active"],
    ["created", "Newest"],
    ["name", "Name"],
    ["repository", "Repository"],
  ];
  const archives = [
    ["active", "Hiding archived"],
    ["all", "Showing all"],
    ["archived", "Only archived"],
  ];
  const filter = (
    label: string,
    value: string,
    options: string[][],
    change: (value: string) => void,
    icon: React.ReactNode,
  ) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={label}>
          {icon}
          {options.find((o) => o[0] === value)?.[1]}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {options.map(([key, text]) => (
          <DropdownMenuItem
            key={key}
            onSelect={() => {
              change(key);
              setActive(0);
            }}
          >
            {text}
            {value === key && <span className="ui-menu-shortcut">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <section
      className="ui-workspace-home"
      aria-label="All workspaces"
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('[role="menu"]')) return;
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          const next = Math.min(
            Math.max(current + (event.key === "ArrowDown" ? 1 : -1), 0),
            rows.length - 1,
          );
          setActive(next);
          list.current
            ?.querySelector(`[data-index="${next}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
        if (
          event.key === "Enter" &&
          (event.target as HTMLElement).tagName === "INPUT" &&
          rows[current]
        )
          onOpen(rows[current].id);
      }}
    >
      <div className="ui-home-toolbar">
        {leading}
        <div className="ui-home-search">
          <Search size={16} />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            aria-label="Search workspaces"
            aria-controls="home-workspace-list"
            placeholder="Search"
          />
        </div>
        <div className="ui-home-filters">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="Filter repository">
                {/* One repository picked: its picture. All or several: the folder. */}
                {(projects.length === 1 &&
                  repositoryIcon?.(
                    projects[0],
                    allProjects.find((p) => p[0] === projects[0])?.[1] ?? projects[0],
                  )) || <Folder />}
                In{" "}
                {!projects.length
                  ? "all repositories"
                  : projects.length === 1
                    ? allProjects.find((p) => p[0] === projects[0])?.[1]
                    : `${projects.length} repositories`}
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuCheckboxItem
                checked={!projects.length}
                onCheckedChange={() => setProjects([])}
              >
                All repositories
              </DropdownMenuCheckboxItem>
              {allProjects.map(([id, label]) => (
                <DropdownMenuCheckboxItem
                  key={id}
                  checked={projects.includes(id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) =>
                    setProjects(
                      checked
                        ? [...projects, id]
                        : projects.filter((p) => p !== id),
                    )
                  }
                >
                  {repositoryIcon?.(id, label)}
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {filter(
            "Archived workspaces",
            archived,
            archives,
            setArchived,
            <Archive />,
          )}
          {filter("Sort workspaces", sort, sorts, setSort, <ArrowDownUp />)}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost">
                <SlidersHorizontal />
                Display
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(
                [
                  ["repository", "Repository"],
                  ["repositoryIcon", "Repository icon"],
                  ["lineChanges", "Line changes"],
                  ["lastActive", "Last active"],
                ] as const
              ).map(([key, label]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={display[key]}
                  onCheckedChange={(checked) =>
                    setDisplay({ ...display, [key]: checked })
                  }
                  onSelect={(e) => e.preventDefault()}
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" onClick={onCreate}>
            <Plus />
            Create
          </Button>
          {trailing}
        </div>
      </div>
      <div
        ref={list}
        id="home-workspace-list"
        className="ui-home-list"
        role="list"
        aria-label="Workspaces"
      >
        {rows.map((w, index) => (
          <div role="listitem" key={w.id}>
            <WorkspaceHoverPreview
              workspace={w}
              side="bottom"
              onAction={(action) => onAction(w.id, action)}
              onOpenPr={() => onAction(w.id, "open-pr")}
            >
              <button
                data-index={index}
                className="ui-home-row"
                data-active={current === index}
                onFocus={() => setActive(index)}
                onClick={() => onOpen(w.id)}
              >
                <WorkspaceStatusIcon
                  status={
                    w.workflow.state === "merged"
                      ? "merged"
                      : w.workflow.state === "working"
                        ? "working"
                        : "branch"
                  }
                />
                {display.repositoryIcon &&
                  (repositoryIcon?.(w.projectId, w.project) ?? <Folder size={14} />)}
                <span className="ui-home-title">{w.title}</span>
                {display.lineChanges && w.added != null && (
                  <DiffCount added={w.added} removed={w.removed ?? 0} />
                )}
                <span className="ui-home-project">
                  {display.repository && w.project}
                </span>
                {display.lastActive && (
                  <time>{w.timeLabel.replace(/ ago$/, " ").trim()}</time>
                )}
              </button>
            </WorkspaceHoverPreview>
          </div>
        ))}
        {!rows.length && (
          <div className="ui-home-empty">No workspaces found</div>
        )}
      </div>
    </section>
  );
}
