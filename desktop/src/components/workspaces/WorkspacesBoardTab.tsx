// The "Board" tab — the same parallel copies laid out as status lanes,
// rendered through the app's shared board design system (`components/board`)
// so a copy on this board reads as the same kind of object as a task on the
// Tasks board or a run on Mission Control.
//
// Lanes only appear when they hold something (`groupByStatus` filters empties),
// because unlike a task pipeline there's no meaning in "you have zero copies
// that need you" — the honest read is just the lanes that exist.

import {
  BoardCard,
  BoardCardMetaRow,
  BoardColumn,
  BoardFrame,
  StateGlyph,
} from "../board";
import { branchAddsNothing } from "../../lib/workspaceLabel";
import {
  groupByStatus,
  relTime,
  statusMeta,
  type CopyStatus,
  type WorkspaceCopy,
} from "./workspacesModel";
import {
  AgentChips,
  CloudMark,
  DiffPill,
  PrPill,
  ProjectGlyph,
} from "./WorkspacesBits";

/** Map a copy's status onto the app's one state-glyph vocabulary, so this
 *  board's lane headers draw the same shapes as every other board: dashed =
 *  resting, solid ring = live but idle, half-filled = something is running. */
const STATUS_GLYPH_GROUP: Record<CopyStatus, string> = {
  attn: "started",
  working: "started",
  active: "unstarted",
  dirty: "unstarted",
  idle: "backlog",
};

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
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-text-4">
        No copies yet. Open a project or start a parallel copy.
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1">
      <BoardFrame>
        {columns.map((col) => (
          <BoardColumn
            key={col.status}
            title={col.label}
            titleHint={col.hint}
            count={col.copies.length}
            collapsible
            glyph={
              <StateGlyph
                group={STATUS_GLYPH_GROUP[col.status]}
                color={statusMeta(col.status).tint}
                size={12}
              />
            }
          >
            {col.copies.map((c) => (
              <CopyCard key={c.path} copy={c} nowMs={nowMs} onOpen={onOpen} />
            ))}
          </BoardColumn>
        ))}
      </BoardFrame>
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
    <BoardCard
      onOpen={() => onOpen(c.path)}
      title={`${c.projectName} · ${c.title}\n${c.path}`}
    >
      {/* Header — the project's glyph leads, because on an all-projects board
          "which project is this?" is the first question. The timestamp sits at
          the right edge, the one place every board puts "when". */}
      <div className="flex items-center gap-1.5">
        <ProjectGlyph
          root={c.root}
          emoji={c.projectEmoji}
          letter={c.projectLetter}
          accent={c.projectAccent}
          size={15}
        />
        <span className="min-w-0 flex-1 truncate text-base leading-snug text-text-1">
          {c.title}
        </span>
        {stamp && (
          <span className="flex-none text-2xs tabular-nums text-text-5">
            {stamp}
          </span>
        )}
      </div>

      {/* Footer — the branch, then the live signals, indented to clear the
          project glyph so the two rows read as one block.
          The branch only when it says something the title above doesn't: this
          line printed the card's own name back at it on sixteen of twenty-five
          cards ("bergen" over `bergen`, "workspaces page" over
          `feat/workspaces-page`). When it has nothing to add, the slot goes to
          the question a board spanning every project actually raises — which
          project is this one? */}
      <BoardCardMetaRow>
        <span className="min-w-0 flex-1 truncate pl-[21px] text-xs text-text-4">
          {c.isMain || branchAddsNothing(c.branch, c.title)
            ? c.projectName
            : c.branch}
        </span>
        <CloudMark cloud={c.cloud} />
        <DiffPill added={c.added} removed={c.removed} />
        <PrPill pr={c.pr} />
        <AgentChips agents={c.agents} />
      </BoardCardMetaRow>
    </BoardCard>
  );
}
