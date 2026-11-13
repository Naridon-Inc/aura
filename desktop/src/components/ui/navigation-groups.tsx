import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  GripVertical,
  MoreHorizontal,
  Plus,
  Pencil,
} from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { SidebarItem, DiffCount, type SidebarItemProps } from "./sidebar";
import { WorkspaceActionsMenu } from "./workspace-patterns";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "./dropdown-menu";
export interface NavigationWorkspace {
  id: string;
  label: string;
  draft?: boolean;
  unread?: boolean;
  status?: SidebarItemProps["status"];
  added?: number;
  removed?: number;
  icon?: ReactNode;
}
export interface NavigationSection {
  id: string;
  title: string;
  kind: "pinned" | "shared" | "custom" | "repository";
  collapsed?: boolean;
  workspaces: NavigationWorkspace[];
}
export function NavigationGroups({
  sections,
  selected,
  onSelect,
  onChange,
  onCreate,
  onArchive,
  renderPreview,
}: {
  sections: NavigationSection[];
  selected?: string;
  onSelect: (id: string) => void;
  onChange: (sections: NavigationSection[]) => void;
  onCreate?: (section: string) => void;
  onArchive?: (id: string) => void;
  renderPreview?: (workspace: NavigationWorkspace, row: ReactNode) => ReactNode;
}) {
  const [editing, setEditing] = useState<{ id: string; section: boolean; text: string }>();
  const [drag, setDrag] = useState<{ id: string; section: boolean }>();
  const updateSection = (id: string, update: Partial<NavigationSection>) =>
    onChange(sections.map((section) => (section.id === id ? { ...section, ...update } : section)));
  const commitName = () => {
    if (!editing?.text.trim()) {
      setEditing(undefined);
      return;
    }
    if (editing.section) updateSection(editing.id, { title: editing.text.trim() });
    else
      onChange(
        sections.map((section) => ({
          ...section,
          workspaces: section.workspaces.map((workspace) =>
            workspace.id === editing.id ? { ...workspace, label: editing.text.trim() } : workspace,
          ),
        })),
      );
    setEditing(undefined);
  };
  const moveWorkspace = (id: string, sectionId: string, before?: string) => {
    const workspace = sections
      .flatMap((section) => section.workspaces)
      .find((item) => item.id === id);
    if (!workspace || before === id) return;
    onChange(
      sections.map((section) => {
        const workspaces = section.workspaces.filter((item) => item.id !== id);
        if (section.id === sectionId) {
          const index = workspaces.findIndex((item) => item.id === before);
          workspaces.splice(index < 0 ? workspaces.length : index, 0, workspace);
        }
        return { ...section, workspaces };
      }),
    );
  };
  const reorderSection = (id: string, target: number) => {
    const source = sections.findIndex((section) => section.id === id);
    if (source < 0 || target < 0 || target >= sections.length) return;
    const next = [...sections];
    next.splice(target, 0, ...next.splice(source, 1));
    onChange(next);
  };
  const nameField = (
    <Input
      autoFocus
      aria-label="Rename"
      value={editing?.text ?? ""}
      onChange={(event) =>
        setEditing(editing ? { ...editing, text: event.target.value } : undefined)
      }
      onBlur={commitName}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitName();
        }
        if (event.key === "Escape") {
          event.stopPropagation();
          setEditing(undefined);
        }
      }}
    />
  );
  return (
    <nav className="ui-navigation-groups" aria-label="Workspace groups">
      {sections.map((section, sectionIndex) => (
        <section
          key={section.id}
          className="ui-navigation-section"
          data-kind={section.kind}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (drag?.section) reorderSection(drag.id, sectionIndex);
            else if (drag) moveWorkspace(drag.id, section.id);
            setDrag(undefined);
          }}
        >
          <header>
            <button
              className="ui-navigation-drag"
              aria-label={`Move ${section.title} group`}
              draggable
              onDragStart={() => setDrag({ id: section.id, section: true })}
              onKeyDown={(event) => {
                if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                  event.preventDefault();
                  reorderSection(section.id, sectionIndex + (event.key === "ArrowUp" ? -1 : 1));
                }
              }}
            >
              <GripVertical size={12} />
            </button>
            {editing?.section && editing.id === section.id ? (
              nameField
            ) : (
              <button
                className="ui-navigation-title"
                aria-expanded={!section.collapsed}
                onClick={() => updateSection(section.id, { collapsed: !section.collapsed })}
              >
                {section.kind === "repository" && (
                  <span className="ui-repository-icon">
                    <Folder size={16} />
                    <span>
                      {section.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </span>
                  </span>
                )}
                <span>{section.title}</span>
                {section.collapsed && <small>{section.workspaces.length}</small>}
                {section.kind !== "repository" && (
                  <ChevronDown
                    size={12}
                    className="ui-section-chevron"
                    data-collapsed={section.collapsed}
                  />
                )}
              </button>
            )}
            {onCreate && (
              <Button
                size="iconXs"
                variant="ghost"
                aria-label={`New workspace in ${section.title}`}
                onClick={() => onCreate(section.id)}
              >
                <Plus />
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="iconXs" variant="ghost" aria-label={`Actions for ${section.title}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onSelect={() =>
                    setEditing({ id: section.id, section: true, text: section.title })
                  }
                >
                  Rename group
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!sectionIndex}
                  onSelect={() => reorderSection(section.id, sectionIndex - 1)}
                >
                  Move group up
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={sectionIndex === sections.length - 1}
                  onSelect={() => reorderSection(section.id, sectionIndex + 1)}
                >
                  Move group down
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          {!section.collapsed &&
            (section.workspaces.length ? (
              section.workspaces.map((workspace, index) => (
                <div
                  key={workspace.id}
                  draggable={editing?.id !== workspace.id}
                  onDragStart={(event) => {
                    event.stopPropagation();
                    setDrag({ id: workspace.id, section: false });
                  }}
                  onDrop={(event) => {
                    if (drag && !drag.section) {
                      event.preventDefault();
                      event.stopPropagation();
                      moveWorkspace(drag.id, section.id, workspace.id);
                      setDrag(undefined);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                      const target = index + (event.key === "ArrowUp" ? -1 : 1);
                      if (target >= 0 && target < section.workspaces.length) {
                        event.preventDefault();
                        const list = [...section.workspaces];
                        list.splice(target, 0, ...list.splice(index, 1));
                        updateSection(section.id, { workspaces: list });
                      }
                    }
                  }}
                >
                  {editing?.id === workspace.id && !editing.section
                    ? nameField
                    : (renderPreview ?? ((_workspace, row) => row))(
                        workspace,
                        <SidebarItem
                          label={workspace.label}
                          selected={selected === workspace.id}
                          unread={workspace.unread}
                          status={workspace.status ?? "branch"}
                          icon={workspace.icon}
                          trailing={
                            workspace.draft ? (
                              <Pencil size={12} aria-label="Draft" />
                            ) : workspace.added != null && workspace.removed != null ? (
                              <DiffCount added={workspace.added} removed={workspace.removed} />
                            ) : undefined
                          }
                          onClick={() => onSelect(workspace.id)}
                          actions={
                            <WorkspaceActionsMenu
                              name={workspace.label}
                              sections={sections.map((item) => ({
                                id: item.id,
                                label: item.title,
                              }))}
                              onMove={(id) => moveWorkspace(workspace.id, id)}
                              onRename={() =>
                                setEditing({
                                  id: workspace.id,
                                  section: false,
                                  text: workspace.label,
                                })
                              }
                              onArchive={onArchive ? () => onArchive(workspace.id) : undefined}
                            />
                          }
                        />,
                      )}
                </div>
              ))
            ) : (
              <p className="ui-navigation-empty">No workspaces</p>
            ))}
        </section>
      ))}
    </nav>
  );
}
