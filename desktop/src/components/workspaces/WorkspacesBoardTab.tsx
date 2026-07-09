// The "Board" tab — the same copies laid out as status columns (Conductor's
// Dashboard, honest to Aura's live signals). Columns only appear when they
// hold something, so the board never shows an empty lane of placeholders.

import {
  groupByStatus,
  relTime,
  statusMeta,
  type WorkspaceCopy,
} from "./workspacesModel";
import { AgentChips, DiffPill, PrPill, ProjectGlyph } from "./WorkspacesBits";

export function WorkspacesBoardTab({
  copies,
  nowMs,
  onOpen,
}: {
  copies: WorkspaceCopy[];
  nowMs: number;
  onOpen: (path: string) => void;
}) {
  const columns = groupByStatus(copies);
  if (!copies.length) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-text-4 text-sm">
        No copies yet — open a project or start a parallel copy.
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-4 py-3">
      <div className="flex h-full items-start gap-3">
        {columns.map((col) => {
          const tint = statusMeta(col.status).tint;
          return (
            <section
              key={col.status}
              className="flex h-full w-[248px] flex-none flex-col rounded-lg border border-line-soft bg-bg-1"
            >
              <header className="flex items-center gap-2 px-3 py-2.5 border-b border-line-soft">
                <span
                  className="inline-block h-2 w-2 flex-none rounded-full"
                  style={{ background: tint }}
                />
                <h3 className="text-[12px] font-semibold text-text-1">
                  {col.label}
                </h3>
                <span className="text-[11px] tabular-nums text-text-4">
                  {col.copies.length}
                </span>
                <span className="ml-auto text-[10px] text-text-5" title={col.hint}>
                  ?
                </span>
              </header>
              <div className="flex flex-1 min-h-0 flex-col gap-1.5 overflow-y-auto p-2">
                {col.copies.map((c) => (
                  <CopyCard key={c.path} copy={c} nowMs={nowMs} onOpen={onOpen} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CopyCard({
  copy: c,
  nowMs,
  onOpen,
}: {
  copy: WorkspaceCopy;
  nowMs: number;
  onOpen: (path: string) => void;
}) {
  const stamp = relTime(c.committedAt, nowMs);
  return (
    <button
      type="button"
      onClick={() => onOpen(c.path)}
      title={`${c.path} — open`}
      className="group flex w-full flex-col gap-1.5 rounded-md border border-line-soft bg-bg-content px-2.5 py-2 text-left transition-colors hover:border-line hover:bg-bg-2"
    >
      <div className="flex items-center gap-1.5">
        <ProjectGlyph
          root={c.root}
          emoji={c.projectEmoji}
          letter={c.projectLetter}
          accent={c.projectAccent}
          size={15}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-1">
          {c.title}
        </span>
        {stamp && (
          <span className="flex-none text-[10px] tabular-nums text-text-5">
            {stamp}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 pl-[21px]">
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-text-4">
          {c.isMain ? c.projectName : c.branch || c.projectName}
        </span>
        <DiffPill added={c.added} removed={c.removed} />
        <PrPill pr={c.pr} />
        <AgentChips agents={c.agents} />
      </div>
    </button>
  );
}
