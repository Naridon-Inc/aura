// Scribble — a common markdown place to write, in the right rail.
//
// Two stacked block boards, TEAM on top and PERSONAL on the bottom (draggable
// split):
//   • TEAM     — a shared "Scribble" Page (scope "team") in the Pages store, so
//                everyone on the repo — AND Aura chat / its agents, via the
//                aura_page_read / aura_page_write MCP tools — reads and writes
//                the same board. Everyone's scribbles come together here, each
//                block tagged with who wrote it.
//   • PERSONAL — a private, machine-local scratchpad (never synced).
//
// Each space is a day-bucketed, forever-scrolling list of blocks: today is live
// (Enter starts a new block; hover to pin / remove; open tasks from earlier
// days carry into it), scroll down for previous days, preserved read-only.
// Blocks hold only inline bold / italic / @mentions / gifs and an optional
// checkbox — no headings, no nested blocks. Members + the caller's handle drive
// per-block attribution / completion and colour known @mentions.

import { useCallback, useEffect, useState } from "react";
import { type TeamMember } from "../../../lib/api";
import { fetchTeam, fetchIdentity } from "../../../lib/teamCache";
import { useVerticalSplit } from "../../../lib/useVerticalSplit";
import { ScribbleSpace } from "./ScribbleSpace";

type Props = {
  repoRoot: string;
};

export function ScribblePanel({ repoRoot }: Props) {
  const { ratio, containerRef, onPointerDown } = useVerticalSplit(
    "aura.scribble.split",
    0.55,
  );

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selfHandle, setSelfHandle] = useState("");

  // The two spaces have identical mechanics, so the strip that teaches them —
  // Enter starts the next line, `[]` turns one into a task — belongs to the
  // panel, once. Each space used to print it in its own footer, which put the
  // same nine words twice on one 630px rail. It goes the moment either space
  // has a line in it.
  const [teamWritten, setTeamWritten] = useState(false);
  const [personalWritten, setPersonalWritten] = useState(false);
  const onTeamWritten = useCallback((w: boolean) => setTeamWritten(w), []);
  const onPersonalWritten = useCallback((w: boolean) => setPersonalWritten(w), []);

  // Roster + self identity — best-effort, degrade to empty. Drives per-block
  // attribution / completion and colours known @mentions.
  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    void fetchTeam(repoRoot)
      .then((m) => alive && setMembers(m.members ?? []))
      .catch(() => {});
    void fetchIdentity(repoRoot)
      .then((id) => {
        if (!alive) return;
        setSelfHandle(id.effective_handle || id.handle || "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className="flex min-h-0 flex-col overflow-hidden"
        style={{ flexGrow: ratio, flexBasis: 0 }}
      >
        <SpaceHeader label="Team" hint="shared · everyone + Aura can edit" />
        <div className="min-h-0 flex-1">
          <ScribbleSpace
            repoRoot={repoRoot}
            scope="team"
            members={members}
            selfHandle={selfHandle}
            onWrittenChange={onTeamWritten}
          />
        </div>
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onPointerDown}
        title="Drag to resize"
        className="group relative h-1.5 flex-shrink-0 cursor-row-resize border-t border-line-soft"
      >
        <div
          className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: "var(--color-accent)" }}
        />
      </div>

      <div
        className="flex min-h-0 flex-col overflow-hidden"
        style={{ flexGrow: 1 - ratio, flexBasis: 0 }}
      >
        <SpaceHeader label="Personal" hint="private to this machine" />
        <div className="min-h-0 flex-1">
          <ScribbleSpace
            repoRoot={repoRoot}
            scope="personal"
            members={members}
            selfHandle={selfHandle}
            onWrittenChange={onPersonalWritten}
          />
        </div>
      </div>

      {!teamWritten && !personalWritten && (
        <div className="flex-shrink-0 border-t border-line-soft/60 px-3 py-1 text-2xs text-text-5">
          Enter starts a new line · type [] to make one a task
        </div>
      )}
    </div>
  );
}

function SpaceHeader({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex flex-shrink-0 items-baseline gap-2 border-b border-line-soft px-2.5 py-1.5">
      <span className="text-xs font-medium text-text-3">{label}</span>
      <span className="text-xs text-text-5">{hint}</span>
    </div>
  );
}
