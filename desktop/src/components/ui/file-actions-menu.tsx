import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAfterMenuClose } from "./after-menu-close";
import { ArrowUpRight, CodeXml, Copy, Eye, Plus, Undo2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "./context-menu";
import "./file-actions-menu.css";
export interface FileApplication {
  id: string;
  label: string;
  onOpen: () => void;
}
export interface FileActions {
  onView?: () => void;
  onAttach?: () => void;
  onCopyPath?: () => void;
  onCopyRelativePath?: () => void;
  onDiscard?: () => void;
  /** The apps on this computer that can open the file. With none, the
   *  "Open in" submenu is left out. */
  applications?: FileApplication[];
}
/** Number keys 1–9 pick the matching app while the submenu is open. */
const NUMBERED = 9;
function OpenInMenu({ applications }: { applications: FileApplication[] }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
      const item = list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[Number(event.key) - 1];
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      item.click();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  return (
    <ContextMenuSub onOpenChange={setOpen}>
      <ContextMenuSubTrigger>
        <ArrowUpRight />
        Open in
      </ContextMenuSubTrigger>
      <ContextMenuSubContent ref={list}>
        {applications.map((app, index) => (
          <ContextMenuItem key={app.id} onSelect={app.onOpen}>
            <CodeXml className="ui-menu-app-icon" />
            <span className="ui-menu-app-name">{app.label}</span>
            {index < NUMBERED && <ContextMenuShortcut className="ui-menu-number">{index + 1}</ContextMenuShortcut>}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
export function FileMenuItems({
  onView,
  onAttach,
  onCopyPath,
  onCopyRelativePath,
  onDiscard,
  applications,
}: FileActions) {
  return (
    <>
      {onView && (
        <ContextMenuItem onSelect={onView}>
          <Eye />
          View
        </ContextMenuItem>
      )}
      {onAttach && (
        <ContextMenuItem onSelect={onAttach}>
          <Plus />
          Attach in chat
        </ContextMenuItem>
      )}
      {applications && applications.length > 0 && <OpenInMenu applications={applications} />}
      <ContextMenuItem disabled={!onCopyPath} onSelect={onCopyPath}>
        <Copy />
        Copy path
      </ContextMenuItem>
      {onCopyRelativePath && (
        <ContextMenuItem onSelect={onCopyRelativePath}>
          <Copy />
          Copy relative path
        </ContextMenuItem>
      )}
      {onDiscard && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem className="ui-menu-danger" onSelect={onDiscard}>
            <Undo2 />
            Discard changes
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
export function FileActionsMenu({ children, ...actions }: FileActions & { children: ReactNode }) {
  const { later, onCloseAutoFocus } = useAfterMenuClose();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
        <FileMenuItems {...actions} onDiscard={later(actions.onDiscard)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
