// "Add project…" — a small menu under the list's heading rather than a folder
// dialog straight away: open a folder already on this computer, clone one from
// GitHub, or start a new one. The last two are dialogs of their own.
//
// It hangs off an anchor at the heading's right edge, so it opens in the same
// place whether it came from the heading's "…" menu or from anywhere else that
// flips `open`.

import { useRef, useState, type KeyboardEvent } from "react";
import { Folder, FolderPlus, Globe } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "../../../ui/popover";
import { CloneProjectDialog } from "./CloneProjectDialog";
import { CreateProjectDialog } from "./CreateProjectDialog";
import "./addProject.css";

type Opened = "clone" | "create" | null;

/** ↑/↓ walk the rows and wrap, the way a menu does. */
function cycleFocus(e: KeyboardEvent<HTMLDivElement>, root: HTMLDivElement | null) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = Array.from(
    root?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
  );
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r === document.activeElement);
  const next =
    at === -1
      ? 0
      : e.key === "ArrowDown"
        ? (at + 1) % rows.length
        : (at - 1 + rows.length) % rows.length;
  e.preventDefault();
  e.stopPropagation();
  rows[next]?.focus();
}

export function AddProjectMenu({
  open,
  onOpenChange,
  onOpenProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pick a folder on this computer and open it. */
  onOpenProject: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<Opened>(null);
  const then = (run: () => void) => () => {
    onOpenChange(false);
    run();
  };
  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverAnchor asChild>
          <span className="ui-add-project-anchor" aria-hidden />
        </PopoverAnchor>
        <PopoverContent
          ref={panel}
          role="menu"
          aria-label="Add project"
          side="bottom"
          align="end"
          sideOffset={4}
          className="ui-add-project-menu"
          onKeyDown={(e) => cycleFocus(e, panel.current)}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
          }}
        >
          <button type="button" role="menuitem" className="ui-add-project-row" onClick={then(onOpenProject)}>
            <Folder />
            <span>Open project</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ui-add-project-row"
            data-tone="secondary"
            onClick={then(() => setDialog("clone"))}
          >
            <Globe />
            <span>Open GitHub project</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ui-add-project-row"
            data-tone="secondary"
            onClick={then(() => setDialog("create"))}
          >
            <FolderPlus />
            <span>Quick start</span>
          </button>
        </PopoverContent>
      </Popover>
      <CloneProjectDialog open={dialog === "clone"} onOpenChange={(o) => setDialog(o ? "clone" : null)} />
      <CreateProjectDialog open={dialog === "create"} onOpenChange={(o) => setDialog(o ? "create" : null)} />
    </>
  );
}
