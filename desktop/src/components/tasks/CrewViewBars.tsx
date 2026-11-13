// The crew page's two bars: the Dashboard's view strip and the toolbar under
// it, the same elements the List and Board lenses draw, so the strip doesn't
// move, change width or change words at the moment you press it. That makes
// it the way out as well: this page is one cell of a three-cell switch.
//
// The toolbar reads left to right the way the Dashboard's does: find, which
// repository, then the verbs, with the one that sets agents running last.

import type { JSX } from "react";
import { Cloud, MoreHorizontal, Play, Plus, RefreshCw } from "lucide-react";

import type { ReadyViewDto } from "../../lib/api";
import type { WorkLens } from "../../lib/workRoute";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { TaskToolbar, TaskViewStrip } from "../ui/tasks-toolbar";
import { CrewFindTask } from "./CrewFindTask";
import { TasksRepositoryMenu } from "./TasksRepositoryMenu";
import { WorkLensTabs } from "./WorkLensTabs";

export function CrewViewBars({
  lens,
  onLens,
  openRoot,
  countText,
  view,
  onFind,
  loading,
  busy,
  running,
  readyCount,
  cap,
  onCap,
  onRefresh,
  onCloud,
  onCompose,
  onRun,
}: {
  lens: WorkLens;
  onLens: (next: WorkLens) => void;
  /** The checkout the app has open; the repository menu folds it. */
  openRoot: string;
  /** How much of the queue is showing, the strip's one trailing fact. */
  countText: string;
  /** The queue as the page shows it, for Find. */
  view: ReadyViewDto | null;
  onFind: (id: string) => void;
  loading: boolean;
  /** Something is already in flight: hold every verb until it lands. */
  busy: boolean;
  /** Run itself is the thing in flight. */
  running: boolean;
  readyCount: number;
  cap: string;
  onCap: (next: string) => void;
  onRefresh: () => void;
  onCloud: () => void;
  onCompose: () => void;
  onRun: () => void;
}): JSX.Element {
  const capNum = Number.parseInt(cap, 10);
  const cappedRun = Number.isFinite(capNum) && capNum > 0 && capNum < readyCount;
  return (
    <>
      <TaskViewStrip
        label="Dashboard"
        tabs={<WorkLensTabs lens={lens} onLens={onLens} />}
        trailing={<span>{countText}</span>}
      />
      <TaskToolbar search={<CrewFindTask view={view} onOpen={onFind} />}>
        <TasksRepositoryMenu openRoot={openRoot} />
        {/* Look again, and the cloud machine. Both are about the page rather
            than the work on it, so they share one menu. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="iconSm" title="More" aria-label="More">
              {loading ? <AsciiSpinner /> : <MoreHorizontal />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={busy} onSelect={onRefresh}>
              <RefreshCw />
              Look again
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCloud}>
              <Cloud />
              Cloud machine
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCompose}
          disabled={busy}
          title="Hand the crew a job. Plan a goal into connected tasks, or drop in a single task. The crew runs an agent on it for you."
        >
          <Plus />
          Add to queue
        </Button>
        {/* The cap, only when capping is a real choice: one ready task can't
            be trimmed to fewer. It sits against Run because Run is the only
            thing it changes. */}
        {readyCount > 1 ? (
          <label
            className="ui-tasks-run-cap"
            title="Cap how many tasks the crew takes this pass. Leave it blank to work the whole ready queue."
          >
            up to
            <Input
              size="small"
              type="number"
              min={1}
              max={readyCount}
              value={cap}
              onChange={(e) => onCap(e.target.value)}
              placeholder="all"
              aria-label="Most tasks to start"
            />
          </label>
        ) : null}
        <Button
          size="sm"
          onClick={onRun}
          disabled={busy || readyCount === 0}
          title="Set the crew going. It runs an agent on each ready task on its own, in order. Watch them land on the Board."
        >
          {running ? <AsciiSpinner /> : <Play />}
          {readyCount === 0
            ? "Run crew"
            : cappedRun
              ? `Run ${capNum} of ${readyCount}`
              : `Run all ${readyCount}`}
        </Button>
      </TaskToolbar>
    </>
  );
}
