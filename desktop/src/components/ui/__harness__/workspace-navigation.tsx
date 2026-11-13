import {
  WorkspaceHoverPreview,
  type WorkspaceOverview,
} from "../workspace-preview-card";
import { type GitWorkflowAction } from "../git-workflow";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  ChevronDown,
  CircleHelp,
  Cloud,
  Grid2X2,
  Home,
  ListTodo,
  PanelLeft,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { Button } from "../button";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarItem,
  SidebarGroup,
} from "../sidebar";
import { NavigationGroups, type NavigationSection } from "../navigation-groups";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../dropdown-menu";
import { type WorkspaceStatus } from "../workspace-status";
export function WorkspaceNavigation({
  page,
  activity,
  onSelect,
  onCreate,
  onSearch,
  onHide,
  onState,
  workspaces,
  onOpenWorkspace,
  onWorkflowAction,
}: {
  workspaces: WorkspaceOverview[];
  onOpenWorkspace: (id: string) => void;
  onWorkflowAction: (id: string, action: GitWorkflowAction) => void;
  page: string;
  activity: string;
  onSelect: (page: string) => void;
  onCreate: () => void;
  onSearch: () => void;
  onHide: () => void;
  onState: (state: string) => void;
}) {
  const [sections, setSections] = useState<NavigationSection[]>([
    {
      id: "interface",
      title: "interface-system",
      kind: "repository",
      workspaces: [
        {
          id: "command",
          label: "Workspace command menu",
          status: "branch",
          added: 128,
          removed: 24,
        },
        {
          id: "onboarding",
          label: "Polish onboarding flow",
          status: "branch",
          draft: true,
        },
        { id: "scrolling", label: "Fix sidebar scrolling", status: "merged" },
      ],
    },
  ]);
  const [selected, setSelected] = useState("command");
  const [history, setHistory] = useState<string[]>(["workspace"]);
  const [position, setPosition] = useState(0);
  const navigate = (destination: string) => {
    setHistory([...history.slice(0, position + 1), destination]);
    setPosition(position + 1);
    onSelect(destination);
  };
  const status: WorkspaceStatus =
    activity === "Working"
      ? "working"
      : activity === "Permission"
        ? "permission"
        : activity === "Plan"
          ? "review-plan"
          : activity === "Error"
            ? "error"
            : "branch";
  return (
    <Sidebar defaultWidth={282} resizable aria-label="Workspace sidebar">
      <SidebarHeader>
        <Button
          variant="ghost"
          size="iconSm"
          aria-label="Hide sidebar"
          onClick={onHide}
        >
          <PanelLeft />
        </Button>
        <span style={{ flex: 1 }} />
        <Button
          variant="ghost"
          size="iconXs"
          aria-label="Go back"
          disabled={position === 0}
          onClick={() => {
            setPosition(position - 1);
            onSelect(history[position - 1]);
          }}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="iconXs"
          aria-label="Go forward"
          disabled={position === history.length - 1}
          onClick={() => {
            setPosition(position + 1);
            onSelect(history[position + 1]);
          }}
        >
          <ArrowRight />
        </Button>
      </SidebarHeader>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="lab-account" aria-label="Account menu">
            <span className="lab-avatar">M</span>
            <strong>My workspace</strong>
            <ChevronDown size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => navigate("cloud")}>
            <Cloud />
            Studio <span>Cloud example</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate("settings")}>
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate("components")}>
            <Blocks />
            Components
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("patterns")}>
            <ListTodo />
            Interaction patterns
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <nav className="lab-primary-navigation" aria-label="Main navigation">
        <SidebarItem
          label="Dashboard"
          icon={<Grid2X2 size={14} />}
          selected={page === "dashboard"}
          onClick={() => navigate("dashboard")}
        />
        <SidebarItem
          label="Home"
          icon={<Home size={14} />}
          selected={page === "home"}
          onClick={() => navigate("home")}
        />
        <SidebarItem
          label="Create"
          icon={<Plus size={14} />}
          onClick={onCreate}
          trailing={<span className="lab-nav-shortcut">⌘ N</span>}
        />
        <SidebarItem
          label="Search"
          icon={<Search size={14} />}
          onClick={onSearch}
          trailing={<span className="lab-nav-shortcut">⌘ K</span>}
        />
      </nav>
      <SidebarContent>
        <SidebarGroup title="My workspaces">
          <NavigationGroups
            sections={sections.map((section) => ({
              ...section,
              workspaces: section.workspaces
                .filter(
                  (workspace) =>
                    !workspaces.find((w) => w.id === workspace.id)?.archived,
                )
                .map((workspace) =>
                  workspace.id === selected &&
                  !["merged", "unstarted"].includes(workspace.status ?? "")
                    ? { ...workspace, status }
                    : workspace,
                ),
            }))}
            selected={page === "workspace" ? selected : undefined}
            onChange={setSections}
            renderPreview={(item, row) => {
              const workspace = workspaces.find((w) => w.id === item.id);
              return workspace ? (
                <WorkspaceHoverPreview
                  workspace={{ ...workspace, title: item.label }}
                  onAction={(action) => onWorkflowAction(item.id, action)}
                  onOpenPr={() => onWorkflowAction(item.id, "open-pr")}
                >
                  <div className="ui-workspace-hover-trigger">{row}</div>
                </WorkspaceHoverPreview>
              ) : (
                row
              );
            }}
            onSelect={(id) => {
              setSelected(id);
              onState(id === "onboarding" ? "Empty" : "Ready");
              navigate("workspace");
              onOpenWorkspace(id);
            }}
            onCreate={() => {
              const id = crypto.randomUUID();
              setSections((items) =>
                items.map((item) => ({
                  ...item,
                  collapsed: false,
                  workspaces: [
                    ...item.workspaces,
                    { id, label: "New workspace", status: "unstarted" },
                  ],
                })),
              );
              setSelected(id);
              onCreate();
            }}
            onArchive={(id) =>
              setSections((items) =>
                items.map((item) => ({
                  ...item,
                  workspaces: item.workspaces.filter(
                    (workspace) => workspace.id !== id,
                  ),
                })),
              )
            }
          />
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="lab-navigation-footer">
        <span className="lab-plan-badge">Free</span>
        <span style={{ flex: 1 }} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="iconSm" aria-label="Help and library">
              <CircleHelp />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            <DropdownMenuItem onSelect={() => navigate("components")}>
              Component library
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate("patterns")}>
              Interaction patterns
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="iconSm"
          aria-label="Settings"
          onClick={() => navigate("settings")}
        >
          <Settings />
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
