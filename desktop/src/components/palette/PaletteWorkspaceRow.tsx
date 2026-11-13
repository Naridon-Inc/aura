// One workspace in the ⌘K palette: its state, its repository's picture, the
// cloud's short id where there is one, its name, and how long ago it was
// active (or a spinner while an agent works in it). An unread one is bold; an
// archived one is dimmed.

import { CommandItem } from "../ui/command";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Tooltip } from "../ui/tooltip";
import { WorkspaceStageIcon } from "../ui/workspace-preview-card";
import { cloudRepoPicture } from "../cloudplace/CloudRepoAvatar";
import { ProjectAvatar } from "../ProjectAvatar";
import { Highlighted } from "./PaletteRows";
import type { PaletteWorkspace } from "./paletteWorkspaces";

export function RepositoryPicture({ repo, name }: { repo: PaletteWorkspace["repo"]; name: string }) {
  if (!repo) return null;
  if (repo.kind === "local") return <ProjectAvatar root={repo.root} name={name} size={16} />;
  return cloudRepoPicture(repo.fullName, 16, name);
}

export function PaletteWorkspaceRow({
  row,
  query,
  showNumber,
  onPick,
}: {
  row: PaletteWorkspace;
  query: string;
  /** The cloud prints each row's short id in its own column. */
  showNumber: boolean;
  onPick: () => void;
}) {
  const picture = <RepositoryPicture repo={row.repo} name={row.project} />;
  return (
    <CommandItem value={`workspace:${row.id}`} onSelect={onPick} className="ui-command-palette-ws">
      <WorkspaceStageIcon stage={row.stage} />
      {row.repo && (
        <Tooltip content={row.project}>
          <span className="ui-command-palette-ws-repo">{picture}</span>
        </Tooltip>
      )}
      <span className="ui-command-palette-ws-name">
        {showNumber && (
          <span className="ui-command-palette-ws-number" data-archived={row.archived || undefined}>
            {row.number}
          </span>
        )}
        <span
          className="ui-command-palette-ws-title"
          data-unread={row.unread || undefined}
          data-archived={row.archived || undefined}
        >
          <Highlighted text={row.title} query={query} />
        </span>
      </span>
      <span className="ui-command-palette-ws-time" data-archived={row.archived || undefined}>
        {!row.archived && row.live ? <AsciiSpinner /> : row.timeLabel}
      </span>
    </CommandItem>
  );
}
