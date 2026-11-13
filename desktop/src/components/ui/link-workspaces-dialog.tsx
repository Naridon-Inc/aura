import { Command as Primitive } from "cmdk";
import { Check, CornerDownLeft, FolderOpen, FolderSymlink } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandItem, CommandList } from "./command";
import "./link-workspaces-dialog.css";

export interface LinkWorkspaceRow {
  id: string;
  name: string;
  directoryName: string;
  linked: boolean;
  /** Linked, but archived or deleted since: agents aren't handed it. */
  missing?: boolean;
}

export interface LinkWorkspaceGroup {
  id: string;
  heading: string;
  rows: LinkWorkspaceRow[];
}

export interface LinkedDirectoryRow {
  path: string;
  missing?: boolean;
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** "Link" / "Unlink" and the Enter key, on the row the keyboard is on. */
function EnterHint({ label }: { label: string }) {
  return (
    <span className="ui-link-ws-hint">
      {label}
      <CornerDownLeft role="img" aria-label="Enter" />
    </span>
  );
}

function Missing() {
  return <span className="ui-link-ws-missing">Missing</span>;
}

/** Link other workspaces and folders to this one, so its agents can read
 *  them too. Each row toggles its link. */
export function LinkWorkspacesDialog({
  open,
  onOpenChange,
  query,
  onQueryChange,
  directories,
  groups,
  unsupportedNote,
  onBrowse,
  onUnlinkDirectory,
  onToggleWorkspace,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Folders linked from disk. */
  directories: LinkedDirectoryRow[];
  /** Other projects' workspaces, one group per project. */
  groups: LinkWorkspaceGroup[];
  /** Said quietly at the foot when the current agent can't be handed
   *  linked folders. */
  unsupportedNote?: string | null;
  onBrowse: () => void;
  onUnlinkDirectory: (path: string) => void;
  onToggleWorkspace: (id: string) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      className="ui-link-workspaces-dialog"
      title="Search"
      description="Search workspaces and press Enter to link or unlink one."
      commandProps={{ shouldFilter: false, loop: true }}
    >
      <div className="ui-issue-link-search">
        <Primitive.Input
          className="ui-issue-link-input"
          placeholder="Search workspaces..."
          aria-label="Search workspaces"
          autoFocus
          value={query}
          onValueChange={onQueryChange}
        />
      </div>
      <CommandList>
        <CommandGroup heading="Directories">
          <CommandItem value="browse-folder" className="ui-link-ws-row" onSelect={onBrowse}>
            <FolderOpen className="ui-link-ws-icon" data-muted="true" />
            <span className="ui-link-ws-name">Browse...</span>
          </CommandItem>
          {directories.map((dir) => (
            <CommandItem
              key={dir.path}
              value={`dir-${dir.path}`}
              className="ui-link-ws-row"
              onSelect={() => onUnlinkDirectory(dir.path)}
            >
              <Check className="ui-link-ws-icon" />
              <span className="ui-link-ws-name">{baseName(dir.path)}</span>
              <span className="ui-link-ws-path">{dir.path}</span>
              {dir.missing && <Missing />}
              <EnterHint label="Unlink" />
            </CommandItem>
          ))}
        </CommandGroup>
        {shown === 0 && query.trim() && (
          <CommandEmpty className="ui-issue-link-empty">
            <p>No workspaces found</p>
          </CommandEmpty>
        )}
        {groups.map((group) => (
          <CommandGroup key={group.id} heading={group.heading}>
            {group.rows.map((row) => (
              <CommandItem
                key={row.id}
                value={`workspace-${row.id}`}
                className="ui-link-ws-row"
                onSelect={() => onToggleWorkspace(row.id)}
              >
                {row.linked ? (
                  <Check className="ui-link-ws-icon" />
                ) : (
                  <FolderSymlink className="ui-link-ws-icon" data-muted="true" />
                )}
                {row.name && <span className="ui-link-ws-name">{row.name}</span>}
                <span className="ui-link-ws-dir">{row.directoryName}</span>
                {row.missing && <Missing />}
                <EnterHint label={row.linked ? "Unlink" : "Link"} />
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      {unsupportedNote && <p className="ui-link-ws-note">{unsupportedNote}</p>}
    </CommandDialog>
  );
}
