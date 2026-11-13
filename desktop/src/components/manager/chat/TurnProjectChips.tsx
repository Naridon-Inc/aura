// Under an Aura turn: the projects it actually acted on, one chip each.
//
// Aura's tools take an explicit project on every call, and each result says
// which one it ran against (lib/turnProjects). A turn that created a
// workspace in one repo and read the board of another shows both, and a
// click goes there — the workspace when the turn made one, else the project.
// Turns that touched nothing project-scoped show nothing.

import { FolderGit2, GitBranch } from "lucide-react";
import type { ChatTurn } from "../../../lib/api";
import { goToTurnProject, projectsTouchedByTurn } from "../../../lib/turnProjects";
import { Button } from "../../ui/button";

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export function TurnProjectChips({ turn }: { turn: Pick<ChatTurn, "tool_calls"> }) {
  const projects = projectsTouchedByTurn(turn);
  if (projects.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1" aria-label="Projects this turn acted on">
      {projects.map((p) => (
        <Button
          key={p.root}
          variant="secondary"
          size="xs"
          onClick={() => goToTurnProject(p)}
          title={p.workspace ? `Open ${p.workspace}` : `Open ${p.root}`}
        >
          {p.workspace ? <GitBranch /> : <FolderGit2 />}
          {p.label}
          {p.workspace && <span style={{ color: "var(--ui-muted-fg)" }}>· {basename(p.workspace)}</span>}
        </Button>
      ))}
    </div>
  );
}
