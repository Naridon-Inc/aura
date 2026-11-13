// How the new work starts, beyond where and from what: its own folder or this
// one, handed to the always-on queue, and whether the dialog stays up for the
// next one. Each choice is only listed where it can take effect.

import { Plus } from "lucide-react";

import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export function CreateOptionsMenu({
  separate,
  onSeparateChange,
  queued,
  onQueuedChange,
  createMore,
  onCreateMoreChange,
}: {
  /** `null` hides the choice: on a machine, or queued, there is no folder of
   *  yours to put the branch in. */
  separate: boolean | null;
  onSeparateChange: (next: boolean) => void;
  /** `null` hides the choice: the queue is only offered once signed in. */
  queued: boolean | null;
  onQueuedChange: (next: boolean) => void;
  createMore: boolean;
  onCreateMoreChange: (next: boolean) => void;
}) {
  const keepOpen = (e: Event) => e.preventDefault();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="iconSm" aria-label="How the new workspace starts">
          <Plus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {separate !== null && (
          <DropdownMenuCheckboxItem
            checked={separate}
            onSelect={keepOpen}
            onCheckedChange={(v) => onSeparateChange(v === true)}
            title="The new branch gets its own folder, so the branch you're on now stays open beside it"
          >
            Separate copy
          </DropdownMenuCheckboxItem>
        )}
        {queued !== null && (
          <DropdownMenuCheckboxItem
            checked={queued}
            onSelect={keepOpen}
            onCheckedChange={(v) => onQueuedChange(v === true)}
            title="Hand this to the always-on machine instead of starting it in front of you"
          >
            Queue it
          </DropdownMenuCheckboxItem>
        )}
        <DropdownMenuCheckboxItem
          checked={createMore}
          onSelect={keepOpen}
          onCheckedChange={(v) => onCreateMoreChange(v === true)}
          title="Keep this open to create another after this one"
        >
          Create more
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
