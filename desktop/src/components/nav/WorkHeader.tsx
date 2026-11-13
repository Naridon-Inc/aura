import type { MouseEvent, ReactNode } from "react";
import {
  ChevronRight,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plug,
} from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { startWindowDrag } from "../TopBar";
import { windowControlsInset } from "../topbar/windowControls";
import { PortsPopover } from "../place/PortsPopover";
import { HeaderOpenIn } from "./HeaderOpenIn";
import { HeaderRepoMenu } from "./HeaderRepoMenu";
import { machineIdForRoot, useActiveMachine } from "../../lib/activeMachine";
import "./work-header.css";

export type WorkHeaderProps = {
  /** Repository the open workspace belongs to. Omit on pages that span every
   *  repository — the header then names the page alone. */
  repo?: string | null;
  /** That repository's root, which keys its picture. */
  repoRoot?: string | null;
  /** The workspace, or the page, the work column is showing. */
  title: ReactNode;
  sidebarOpen: boolean;
  fullscreen: boolean;
  onShowSidebar: () => void;
  /** Workspace state after the drag gap, before the panel controls: things
   *  waiting on you, then the branch. */
  actions?: ReactNode;
  /** Panel controls; omitted on pages, which have no side panels. */
  panels?: {
    repoRoot: string | null;
    reviewOpen: boolean;
    terminalOpen: boolean;
    onToggleReview: () => void;
    onToggleTerminal: () => void;
  };
};

/** The work column's header: where you are, then the panel controls.
 *
 *  It is the row a person grabs to move the window, so every empty part of
 *  it is a drag region. With the sidebar closed it starts at the window's
 *  top-left corner, where it makes room for the window buttons and carries
 *  the control that brings the sidebar back. */
export function WorkHeader({
  repo,
  repoRoot,
  title,
  sidebarOpen,
  fullscreen,
  onShowSidebar,
  actions,
  panels,
}: WorkHeaderProps) {
  const drag = fullscreen ? undefined : (e: MouseEvent) => startWindowDrag(e);
  return (
    <header
      className="ui-work-header"
      data-tauri-drag-region
      onMouseDown={drag}
      style={
        sidebarOpen
          ? undefined
          : { paddingLeft: windowControlsInset(true, fullscreen) }
      }
    >
      {!sidebarOpen && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Show sidebar"
          title="Show sidebar (⌘B)"
          onClick={onShowSidebar}
        >
          <PanelLeft />
        </Button>
      )}
      {repo && (
        <>
          <HeaderRepoMenu repo={repo} repoRoot={repoRoot ?? null} />
          <ChevronRight className="ui-work-header-sep" />
        </>
      )}
      <span className="ui-work-header-title">{title}</span>
      <div className="ui-work-header-fill" data-tauri-drag-region />
      {actions}
      {panels && (
        <PanelControls {...panels} title={typeof title === "string" ? title : undefined} />
      )}
    </header>
  );
}

function PanelControls({
  title,
  repoRoot,
  reviewOpen,
  terminalOpen,
  onToggleReview,
  onToggleTerminal,
}: NonNullable<WorkHeaderProps["panels"]> & { title?: string }) {
  const active = useActiveMachine();
  const portsMachine = machineIdForRoot(repoRoot) ?? active.machineId;
  // Opening the folder in an app is this computer's; a checkout on a machine
  // has no folder here to open.
  const local = repoRoot && !machineIdForRoot(repoRoot) ? repoRoot : null;
  return (
    <>
      {local && <HeaderOpenIn path={local} title={title} />}
      {portsMachine && (
        <PortsPopover
          machineId={portsMachine}
          repoRoot={repoRoot}
          trigger={({ active: open, onClick, badge, title }) => (
            <Button
              variant="ghost"
              size="sm"
              title={title}
              data-active={open}
              onClick={onClick}
            >
              <Plug />
              Ports
              {badge > 0 && <Badge variant="secondary">{badge}</Badge>}
            </Button>
          )}
        />
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Toggle terminal"
        title="Toggle terminal (⌘J)"
        aria-pressed={terminalOpen}
        data-active={terminalOpen}
        onClick={onToggleTerminal}
      >
        <PanelBottom />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Toggle right sidebar"
        title={reviewOpen ? "Hide right sidebar (⌘⌥B)" : "Show right sidebar (⌘⌥B)"}
        aria-pressed={reviewOpen}
        data-active={reviewOpen}
        onClick={onToggleReview}
      >
        <PanelRight />
      </Button>
    </>
  );
}
