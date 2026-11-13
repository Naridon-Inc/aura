// The repository in the work header: its picture and name, opening a menu with
// the repository's settings and, when it lives on GitHub, the way to its page.

import { useState } from "react";
import { Settings } from "lucide-react";

import { gitRemoteOrigin } from "../../lib/place/workApi";
import { openExternal } from "../../lib/openExternal";
import { originToHttpBase } from "../../lib/worktreeActions";
import { GitHubMark } from "../onboarding/icons";
import { ProjectAvatar } from "../ProjectAvatar";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** The repository's page on GitHub, from its `origin`, or "" when it has none
 *  there. */
export function githubPageOf(origin: string): string {
  const base = originToHttpBase(origin);
  return /^https:\/\/github\.com\//.test(base) ? base : "";
}

export function HeaderRepoMenu({ repo, repoRoot }: { repo: string; repoRoot: string | null }) {
  // Read when the menu opens: the remote can change under a running app, and
  // the header has no other reason to ask.
  const [page, setPage] = useState("");
  const onOpenChange = (open: boolean) => {
    if (!open || !repoRoot) return;
    gitRemoteOrigin(repoRoot).then(
      (origin) => setPage(githubPageOf(origin)),
      () => setPage(""),
    );
  };

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="ui-work-header-repo" title={repo}>
          <ProjectAvatar root={repoRoot} name={repo} />
          <span>{repo}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          onSelect={() =>
            window.dispatchEvent(
              new CustomEvent("aura:open-settings", { detail: { pane: "copies" } }),
            )
          }
        >
          <Settings />
          Repository settings
        </DropdownMenuItem>
        {page && (
          <DropdownMenuItem onSelect={() => void openExternal(page)}>
            <GitHubMark size={14} />
            Open on GitHub
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
