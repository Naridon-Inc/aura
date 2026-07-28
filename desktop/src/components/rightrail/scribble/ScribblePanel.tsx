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

import { useEffect, useState } from "react";
import { api, type TeamMember } from "../../../lib/api";
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

  // Roster + self identity — best-effort, degrade to empty. Drives per-block
  // attribution / completion and colours known @mentions.
  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    void api
      .teamLoad(repoRoot)
      .then((m) => alive && setMembers(m.members ?? []))
      .catch(() => {});
    void api
      .teamIdentity(repoRoot)
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
          />
        </div>
      </div>
    </div>
  );
}

function SpaceHeader({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex flex-shrink-0 items-baseline gap-2 border-b border-line-soft px-2.5 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-3">
        {label}
      </span>
      <span className="text-[9.5px] text-text-5">{hint}</span>
    </div>
  );
}
