// Which repository the new workspace is made in, plus the one way to bring
// another repository in without leaving the dialog.

import { useState } from "react";
import { Check, ChevronDown, Folder, Plus } from "lucide-react";

import { ProjectAvatar } from "../ProjectAvatar";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { projectNameFromRoot } from "../../lib/projectRoots";
import { humanizeWorkspaceName } from "../../lib/workspaceLabel";

export type KnownRepository = { root: string; label?: string };

export function repositoryName(repo: KnownRepository | undefined, root: string): string {
  // The sidebar's name for it, so a parallel copy reads "repo · copy" here
  // too rather than as its folder's generated name.
  return humanizeWorkspaceName(root, repo?.label?.trim() || projectNameFromRoot(root));
}

export function CreateRepositoryMenu({
  repositories,
  value,
  onPick,
  onAdd,
}: {
  repositories: KnownRepository[];
  value: string | null;
  onPick: (root: string) => void;
  onAdd: () => void;
}) {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const shown = repositories.filter(
    (r) =>
      !q ||
      repositoryName(r, r.root).toLowerCase().includes(q) ||
      r.root.toLowerCase().includes(q),
  );
  const current = value ? repositories.find((r) => r.root === value) : undefined;
  return (
    <DropdownMenu onOpenChange={(open) => !open && setSearch("")}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" title={value ?? undefined}>
          <Folder />
          {value ? repositoryName(current, value) : "Choose a repository"}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="ui-workspaces-create-repositories">
        <input
          className="ui-workspaces-create-search"
          aria-label="Search repositories"
          placeholder="Search repositories…"
          value={search}
          autoFocus
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
          }}
        />
        {shown.length === 0 ? (
          <DropdownMenuItem disabled>
            {repositories.length === 0 ? "No repositories yet" : "No repositories match"}
          </DropdownMenuItem>
        ) : (
          shown.map((r) => (
            <DropdownMenuItem key={r.root} title={r.root} onSelect={() => onPick(r.root)}>
              <ProjectAvatar root={r.root} name={repositoryName(r, r.root)} />
              <span>{repositoryName(r, r.root)}</span>
              {value === r.root && <Check />}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onAdd}>
          <Plus />
          Add repository…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
