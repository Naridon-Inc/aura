// "Conflicts" — open semantic conflicts from the M1 ConflictedNode store
// (.aura/conflicts.jsonl): the same node edited two ways during a live
// session. Each row is the details panel's two-line row, like a radar zone:
// who else changed it and what on the first line, the file under it, and
// "keep mine / keep theirs" showing on hover (the node already holds both
// bodies). Clicking the row opens the file for a hand-merge. Resolving
// writes back through aura_conflicts_resolve.

import { CategorySection } from "../CategorySection";
import { ActorMark } from "../radar/ActorMark";
import { nameLooksLikeAgent } from "../radar/radarFormat";
import { Button } from "../../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { ConflictedNode } from "../../../lib/api";
import { agoShort, baseName } from "./syncFormat";
import "../../ui/details-pulls.css";
import "../../ui/radar-rows.css";
import "../../ui/sync-rows.css";

type Props = {
  /** `null` while the conflict store hasn't been read. No Conflicts group
   *  on screen reads as "nobody has touched your work" — the one thing
   *  this section exists to tell you — so an unread store says so instead
   *  of quietly disappearing. */
  conflicts: ConflictedNode[] | null;
  isOpen: boolean;
  onToggle: () => void;
  busyId: string | null;
  onResolve: (id: string, strategy: "ours" | "theirs") => void;
  onOpenFile?: (path: string) => void;
};

export function ConflictsSection({
  conflicts,
  isOpen,
  onToggle,
  busyId,
  onResolve,
  onOpenFile,
}: Props) {
  return (
    <CategorySection
      title="Conflicts"
      count={conflicts?.length ?? 0}
      isOpen={isOpen}
      onToggle={onToggle}
      empty={
        conflicts === null
          ? "Couldn’t check whether anyone has changed the same code as you. This list isn’t up to date."
          : undefined
      }
    >
      {(conflicts ?? []).map((c) => {
        const busy = busyId === c.id;
        const them = c.theirs_agent || "teammate";
        return (
          <div key={c.id} className="ui-sync-row">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onOpenFile?.(c.file)}
                  className="ui-details-pull ui-radar-row"
                >
                  <div>
                    <ActorMark
                      actor={them}
                      isAgent={nameLooksLikeAgent(them)}
                      size={16}
                    />
                    <span className="ui-details-pull-title">
                      {c.identifier || baseName(c.file)}
                    </span>
                    <span className="ui-radar-age">{agoShort(c.opened_at)}</span>
                  </div>
                  <div className="ui-details-pull-meta ui-radar-meta">
                    <span>you &amp; {them} edited this</span>
                    <span className="ui-details-pull-branch">{baseName(c.file)}</span>
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="ui-radar-tip">
                <strong>{c.file}</strong>
                <p className="ui-radar-tip-quiet">
                  you &amp; {them} edited this · {agoShort(c.opened_at)}
                </p>
              </TooltipContent>
            </Tooltip>
            <span className="ui-sync-actions">
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => onResolve(c.id, "ours")}
                title="Keep your version and drop theirs"
              >
                Keep mine
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => onResolve(c.id, "theirs")}
                title={`Take ${them}'s version and drop yours`}
              >
                Keep theirs
              </Button>
            </span>
          </div>
        );
      })}
    </CategorySection>
  );
}
