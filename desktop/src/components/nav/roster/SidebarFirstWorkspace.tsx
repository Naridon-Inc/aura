// What the workspace list says when the place you are in has nothing in it:
// a project to add on this computer, or a first workspace to create anywhere
// else.

import { Plus } from "lucide-react";
import { Button } from "../../ui/button";
import "./roster.css";

/** A place with no workspaces yet, and the way to make the first one. */
export function FirstWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="ui-roster-first">
      <p>Create your first workspace to start building with your team.</p>
      <Button variant="ghost" className="ui-roster-first-create" onClick={onCreate}>
        <Plus />
        Create workspace
      </Button>
    </div>
  );
}

/** This computer, with no project on the list. */
export function AddProjectFirst() {
  return (
    <div className="ui-roster-first" data-kind="project">
      <p>Add a project to get started.</p>
    </div>
  );
}
