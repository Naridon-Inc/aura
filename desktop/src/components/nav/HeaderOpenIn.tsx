// The workspace's folder in the work header: its name when that isn't the
// branch's or the title's, and "Open in..." — the editors on this computer, Finder, and
// Copy path.

import { useState } from "react";
import { ChevronDown, Copy, FolderOpen } from "lucide-react";

import { api, type EditorInfo } from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import { toast } from "../../lib/toast";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip } from "../ui/tooltip";
import { useCurrentBranch } from "./useCurrentBranch";

export function HeaderOpenIn({
  path,
  title,
}: {
  path: string;
  /** The header's title, when it is plain text: a folder named the same is
   *  already on screen. */
  title?: string;
}) {
  const branch = useCurrentBranch(path);
  const dir = path.replace(/\/+$/, "").split("/").pop() || path;
  // Asked for when the menu first opens; null until the answer comes back.
  const [apps, setApps] = useState<EditorInfo[] | null>(null);
  const onOpenChange = (open: boolean) => {
    if (!open || apps) return;
    api.editorsList().then(
      (all) => setApps(all.filter((a) => a.available)),
      () => setApps([]),
    );
  };
  const openIn = (app: EditorInfo) =>
    api.editorOpen(path, app.id).catch((e) => toast.danger(`Couldn't open in ${app.name}`, String(e)));
  const reveal = () =>
    api.fsRevealInFinder(path).catch((e) => toast.danger("Couldn't open in Finder", String(e)));
  const copy = () =>
    void writeClipboardText(path).then((ok) =>
      ok ? toast.success("Path copied") : toast.danger("Couldn't copy the path"),
    );

  return (
    <>
      {dir !== branch && dir !== title && (
        <span className="ui-work-header-dir" title={path} data-tauri-drag-region>
          {dir}
        </span>
      )}
      <DropdownMenu onOpenChange={onOpenChange}>
        <Tooltip content="Open in...">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="iconXs" aria-label="Open in..." className="ui-work-header-open-in">
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end">
          {apps === null ? (
            <div className="ui-work-header-open-note">
              <AsciiSpinner />
            </div>
          ) : apps.length === 0 ? (
            <div className="ui-work-header-open-note">No apps available</div>
          ) : (
            apps.map((app) => (
              <DropdownMenuItem key={app.id} onSelect={() => void openIn(app)}>
                {app.name}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuItem onSelect={() => void reveal()}>
            <FolderOpen />
            Finder
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copy()}>
            <Copy />
            Copy path
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
