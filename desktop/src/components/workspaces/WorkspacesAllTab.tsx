// The "All" tab — every parallel copy across every open project, grouped by
// how recently its branch was touched (Conductor's time-grouped Workspaces
// list, honest to Aura's data). One clean line per copy; click to jump into it.

import {
  bucketByTime,
  relTime,
  type WorkspaceCopy,
} from "./workspacesModel";
import { AgentChips, DiffPill, PrPill, ProjectGlyph, StatusDot } from "./WorkspacesBits";

export function WorkspacesAllTab({
  copies,
  nowMs,
  activePath,
  onOpen,
}: {
  copies: WorkspaceCopy[];
  nowMs: number;
  activePath: string;
  onOpen: (path: string) => void;
}) {
  const buckets = bucketByTime(copies, nowMs);
  if (!copies.length) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-text-4 text-sm">
        No copies yet — open a project or start a parallel copy.
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
      <div className="mx-auto w-full max-w-3xl flex flex-col gap-5">
        {buckets.map((b) => (
          <section key={b.key}>
            <div className="flex items-center gap-2 px-1 pb-1.5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-4">
                {b.label}
              </h3>
              <span className="text-[11px] text-text-5 tabular-nums">
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
  const stamp = relTime(c.committedAt, nowMs);
  return (
    <button
      type="button"
      onClick={() => onOpen(c.path)}
      title={`${c.path} — open`}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2.5 h-9 text-left transition-colors ${
        isActive ? "bg-bg-2" : "hover:bg-bg-2"
      }`}
    >
      <StatusDot status={c.status} />
      <ProjectGlyph
        root={c.root}
        emoji={c.projectEmoji}
        letter={c.projectLetter}
        accent={c.projectAccent}
        size={16}
      />
      <span className="flex-none max-w-[130px] truncate text-[12px] text-text-3">
        {c.projectName}
      </span>
      <span aria-hidden className="flex-none text-text-5">
        ›
      </span>
      <span className="min-w-0 truncate text-[13px] text-text-1">{c.title}</span>
      {c.isMain && (
        <span className="flex-none rounded bg-bg-3 px-1 text-[9px] font-medium uppercase tracking-wide text-text-4">
          main
        </span>
      )}
      {c.branch && !c.isMain && (
        <span className="flex-none max-w-[180px] truncate font-mono text-[11px] text-text-4">
          {c.branch}
        </span>
      )}
      <span className="flex-1" />
      <DiffPill added={c.added} removed={c.removed} />
      <PrPill pr={c.pr} />
      <AgentChips agents={c.agents} />
      <span className="w-16 flex-none text-right text-[11px] tabular-nums text-text-4 group-hover:hidden">
        {stamp}
      </span>
      <span className="hidden w-16 flex-none text-right text-[11px] font-medium text-accent group-hover:inline">
        Open →
      </span>
    </button>
  );
}
