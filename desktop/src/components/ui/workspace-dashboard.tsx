import { useState, type ReactNode } from "react";
import { Folder, ChevronDown } from "lucide-react";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./context-menu";
import {
  WorkspacePreviewCard,
  WorkspaceStageIcon,
  WORKSPACE_STAGES,
  type WorkspaceOverview,
  type WorkspaceStage,
} from "./workspace-preview-card";
import { type GitWorkflowAction } from "./git-workflow";
import { usePointerDrag } from "./use-pointer-drag";

// Cards move between stages with a pointer drag: the desktop app's web view
// never delivers an HTML5 `drop`, so a native drag picked a card up and never
// put it down (see ./use-pointer-drag).
//
// The repository tabs only show when there is more than one repository to
// pick between; each wears the repository's own picture when the caller can
// draw one (`repositoryIcon`), and the folder when it can't.
export function WorkspaceDashboard({
  workspaces,
  onOpen,
  onMove,
  onAction,
  onCreate,
  onArchive,
  repositoryIcon,
  noun = "workspace",
}: {
  workspaces: WorkspaceOverview[];
  onOpen: (id: string) => void;
  onMove: (id: string, stage: WorkspaceStage) => void;
  onAction: (id: string, action: GitWorkflowAction) => void;
  onCreate: () => void;
  onArchive?: (id: string) => void;
  /** A repository's picture for its tab, drawn by the caller so the
   *  library stays data-free. Left out, the tabs show a folder. */
  repositoryIcon?: (projectId: string, project: string) => ReactNode;
  /** What one card is, for the board's labels and its create and archive
   *  actions ("New workspace", "Backlog workspaces"). */
  noun?: string;
}) {
  const [project, setProject] = useState("all"),
    [expanded, setExpanded] = useState<string[]>([]);
  const drag = usePointerDrag<string>((id, stage) => onMove(id, stage as WorkspaceStage));
  const projects = [
    ...new Map(workspaces.map((w) => [w.projectId, { id: w.projectId, name: w.project }])).values(),
  ];
  // A repository that has gone (or a filter hidden with only one left) reads
  // as all of them rather than as an empty board.
  const current = projects.some((p) => p.id === project) ? project : "all";
  const visible = workspaces.filter(
    (w) => !w.archived && (current === "all" || w.projectId === current),
  );
  return (
    <section
      className="ui-dashboard"
      aria-label={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} dashboard`}
    >
      {projects.length > 1 && (
        <nav className="ui-dashboard-projects" aria-label="Dashboard repositories">
          <div role="tablist" aria-label="Repository filter">
            {[{ id: "all", name: "All repositories" }, ...projects.slice(0, 5)].map((p) => (
              <button
                role="tab"
                key={p.id}
                aria-selected={current === p.id}
                onClick={() => setProject(p.id)}
              >
                {p.id !== "all" && (repositoryIcon?.(p.id, p.name) ?? <Folder size={14} />)}
                {p.name}
              </button>
            ))}
          </div>
          {projects.length > 5 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost">
                  More
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {projects.slice(5).map((p) => (
                  <DropdownMenuItem key={p.id} onSelect={() => setProject(p.id)}>
                    {repositoryIcon?.(p.id, p.name) ?? <Folder size={14} />}
                    {p.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </nav>
      )}
      {!visible.length ? (
        <div className="ui-dashboard-empty">
          <Button onClick={onCreate}>New {noun}</Button>
        </div>
      ) : (
        <div className="ui-dashboard-scroll">
          <div className="ui-dashboard-board">
            {WORKSPACE_STAGES.map((stage) => {
              const items = visible
                .filter((w) => w.stage === stage.id)
                .sort((a, b) => b.updatedAt - a.updatedAt);
              return (
                <section
                  key={stage.id}
                  className="ui-dashboard-column"
                  aria-label={`${stage.label} ${noun}s`}
                  data-drag-over={drag.over === stage.id}
                  {...drag.target(stage.id)}
                >
                  <header>
                    <WorkspaceStageIcon stage={stage.id} />
                    <h2>{stage.label}</h2>
                    <span>{items.length}</span>
                  </header>
                  <div className="ui-dashboard-column-content">
                    {(expanded.includes(stage.id) ? items : items.slice(0, 10)).map((workspace) => (
                      <ContextMenu key={workspace.id}>
                        <ContextMenuTrigger asChild>
                          <div
                            className="ui-dashboard-card"
                            role="button"
                            tabIndex={0}
                            aria-label={workspace.title}
                            {...drag.source(workspace.id)}
                            onClick={() => onOpen(workspace.id)}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter") {
                                event.preventDefault();
                                onOpen(workspace.id);
                              }
                              if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
                                event.preventDefault();
                                const next =
                                  WORKSPACE_STAGES[
                                    WORKSPACE_STAGES.findIndex((s) => s.id === workspace.stage) +
                                      (event.key === "ArrowRight" ? 1 : -1)
                                  ];
                                if (next) onMove(workspace.id, next.id);
                              }
                            }}
                          >
                            <WorkspacePreviewCard
                              workspace={workspace}
                              onAction={(action) => onAction(workspace.id, action)}
                              onOpenPr={() => onAction(workspace.id, "open-pr")}
                            />
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          {WORKSPACE_STAGES.map((s) => (
                            <ContextMenuItem
                              key={s.id}
                              disabled={workspace.stage === s.id}
                              onSelect={() => onMove(workspace.id, s.id)}
                            >
                              Move to {s.label}
                            </ContextMenuItem>
                          ))}
                          {onArchive && (
                            <>
                              <ContextMenuSeparator />
                              <ContextMenuItem onSelect={() => onArchive(workspace.id)}>
                                Archive {noun}
                              </ContextMenuItem>
                            </>
                          )}
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                    {items.length > 10 && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          setExpanded(
                            expanded.includes(stage.id)
                              ? expanded.filter((id) => id !== stage.id)
                              : [...expanded, stage.id],
                          )
                        }
                      >
                        {expanded.includes(stage.id)
                          ? "Show less"
                          : `Show ${items.length - 10} more`}
                      </Button>
                    )}
                  </div>
                  {drag.over === stage.id && (
                    <div className="ui-dashboard-drop">
                      <span>Move to {stage.label}</span>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
