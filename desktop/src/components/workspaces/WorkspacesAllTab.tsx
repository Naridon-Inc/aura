// The "All" tab — every parallel copy across every open project, grouped by
// how recently its branch was touched (Conductor's Home list, honest to Aura's
// data). One clean line per copy; click to jump into it.
//
// The row is deliberately spare. What identifies a copy is its name and the
// project it belongs to, so those get the ink: a branch mark, the project's
// avatar, the humanised title. Everything that used to sit alongside them —
// a status dot, a "main" pill, a boxed PR chip — was chrome around data that
// is either already legible (the title says "main copy") or better read from
// the agent marks and the diff at the right edge. Ornament on 100+ rows is not
// neutral: it costs the scan.

import { GitBranch } from "../Icons";
import { branchAddsNothing } from "../../lib/workspaceLabel";
import type { CloudJobWithRoot } from "../../lib/useCloudJobs";
import { WorkspacesCloudSection } from "./WorkspacesCloudSection";
import { WorkspacesMachinesSection } from "./WorkspacesMachinesSection";
import {
  bucketByTime,
  prTint,
  relTimeShort,
  type WorkspaceCopy,
} from "./workspacesModel";
import {
  AgentChips,
  CloudMark,
  DiffPill,
  FLEET_COLUMN,
  ProjectGlyph,
} from "./WorkspacesBits";

export function WorkspacesAllTab({
  copies,
  cloudJobs = [],
  nowMs,
  activePath,
  onOpen,
}: {
  copies: WorkspaceCopy[];
  /** Work handed to a machine that isn't this one. It has no copy on this disk
   *  to sit beside, so it gets its own section above the list rather than being
   *  left off the page entirely. */
  cloudJobs?: CloudJobWithRoot[];
  nowMs: number;
  activePath: string;
  onOpen: (path: string) => void;
}) {
  const buckets = bucketByTime(copies, nowMs);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
      <div className={`flex flex-col gap-4 ${FLEET_COLUMN}`}>
        {/* Machines first, then the work sent to them, then the copies on this
            disk — nearest-to-furthest is the wrong order here. You reach for a
            machine before there is anything to see on it, so it cannot be a
            section that only appears once you've used it. */}
        <WorkspacesMachinesSection repoRoot={activePath} nowMs={nowMs} />
        <WorkspacesCloudSection jobs={cloudJobs} nowMs={nowMs} />
        {/* No copies is an ordinary state, not an error, and it is no longer
            the whole tab: the machines above it are real places whether or not
            anything is checked out here. So it says its piece where the list
            would have been, rather than blanking the sections around it. */}
        {!copies.length && (
          <p className="px-2 py-6 text-center text-sm text-text-4">
            No copies yet. Open a project or start a parallel copy.
          </p>
        )}
        {buckets.map((b) => (
          <section key={b.key}>
            {/* Sentence case with a dim count — a time marker the eye can skip
                past, not a shouted section label. The letterspaced capitals it
                used to wear competed with the rows they introduced. */}
            <div className="flex items-center gap-1.5 px-2 pb-1">
              <h3 className="text-xs font-medium text-text-4">{b.label}</h3>
              <span className="text-xs text-text-5 tabular-nums">
                {b.copies.length}
              </span>
            </div>
            <div className="flex flex-col">
              {b.copies.map((c) => (
                <CopyRow
                  key={c.path}
                  copy={c}
                  nowMs={nowMs}
                  isActive={c.path === activePath}
                  onOpen={onOpen}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function CopyRow({
  copy: c,
  nowMs,
  isActive,
  onOpen,
}: {
  copy: WorkspaceCopy;
  nowMs: number;
  isActive: boolean;
  onOpen: (path: string) => void;
}) {
  const stamp = relTimeShort(c.committedAt, nowMs);
  return (
    <button
      type="button"
      onClick={() => onOpen(c.path)}
      // The project name left the row when the avatar took over naming it, so
      // it has to be here — this tooltip is now the only place the full
      // "which project, which checkout" answer is spelled out.
      title={`${c.projectName} · ${c.title}\n${c.path}`}
      className={`group flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors ${
        isActive ? "bg-state-selected" : "hover:bg-state-hover"
      }`}
    >
      {/* The leading mark on every row: a branch, because that is what a copy
          is. Straight from the shared icon set — this row has no reason to
          draw its own. */}
      <GitBranch size={13} className="flex-none text-text-5" />
      <ProjectGlyph
        root={c.root}
        emoji={c.projectEmoji}
        letter={c.projectLetter}
        accent={c.projectAccent}
        size={16}
      />
      <span className="min-w-0 truncate text-base text-text-1">{c.title}</span>
      {/* Only when it adds something. The literal `branch !== title` this
          used to ask never fired, because a slug is never equal to the
          sentence made out of it — so "workspaces page" printed
          `feat/workspaces-page` beside itself, and so did most of the list. */}
      {!c.isMain && !branchAddsNothing(c.branch, c.title) && (
        <span className="flex-none max-w-[200px] truncate font-mono text-xs text-text-5">
          {c.branch}
        </span>
      )}
      <span className="flex-1" />
      <CloudMark cloud={c.cloud} />
      <DiffPill added={c.added} removed={c.removed} />
      {c.pr && (
        <span
          className="flex-none text-xs tabular-nums"
          style={{ color: prTint(c.pr.state) }}
          title={`PR #${c.pr.number} · ${c.pr.state}`}
        >
          #{c.pr.number}
        </span>
      )}
      <AgentChips agents={c.agents} />
      <span className="w-10 flex-none text-right text-xs tabular-nums text-text-4 group-hover:hidden">
        {stamp}
      </span>
      <span className="hidden w-10 flex-none text-right text-xs font-medium text-accent group-hover:inline">
        Open
      </span>
    </button>
  );
}
