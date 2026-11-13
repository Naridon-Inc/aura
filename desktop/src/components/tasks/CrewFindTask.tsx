// The search slot of the crew's toolbar. The Dashboard's list narrows as you
// type; the crew's map can't, because Run takes the rail's goal and crew and
// nothing else, so a third narrowing would draw one set of work above a button
// that starts another. Here the slot finds instead: pick a task and its
// detail opens, with its chain lit on the map behind it.

import { useMemo, useState, type JSX } from "react";
import { Search } from "lucide-react";

import type { LoopTask, ReadyViewDto } from "../../lib/api";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";

type Group = { heading: string; tasks: LoopTask[] };

/** The view's six buckets in the order you'd look for a task: what's moving,
 *  what's next, what's stuck, then what's parked or finished. */
function groupsOf(view: ReadyViewDto | null): Group[] {
  if (!view) return [];
  return [
    { heading: "Working", tasks: view.working },
    { heading: "Ready", tasks: view.ready },
    { heading: "Blocked", tasks: view.blocked.map((b) => b.task) },
    { heading: "Paused", tasks: view.paused },
    { heading: "Done", tasks: view.done },
    { heading: "Other", tasks: view.other },
  ].filter((g) => g.tasks.length > 0);
}

export function CrewFindTask({
  view,
  onOpen,
}: {
  /** The queue as the page shows it: narrowed to the rail's goal and crew. */
  view: ReadyViewDto | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupsOf(view), [view]);
  const empty = groups.length === 0;
  return (
    <>
      <button
        type="button"
        className="ui-home-search ui-tasks-find"
        onClick={() => setOpen(true)}
        disabled={empty}
        aria-haspopup="dialog"
      >
        <Search size={16} aria-hidden />
        <span>{empty ? "No tasks to find" : "Find a task"}</span>
      </button>
      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        title="Find a task"
        description="Search the crew's tasks and press Enter to open one."
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Find a task…"
          aria-label="Find a task"
        />
        <CommandList>
          <CommandEmpty>No task matches.</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.tasks.map((task) => (
                <CommandItem
                  key={task.id}
                  value={`${task.title} ${task.id}`}
                  onSelect={() => {
                    onOpen(task.id);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span>
                    {task.title || task.id}
                    <small>{task.id}</small>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  );
}
