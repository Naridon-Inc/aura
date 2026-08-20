// "Conflicts" — open semantic conflicts from the M1 ConflictedNode store
// (.aura/conflicts.jsonl): the same node edited two ways during a live
// session. Each row carries quick "keep mine / keep theirs" resolutions
// (the node already holds both bodies) plus click-through to the file for
// a hand-merge. Resolving writes back through aura_conflicts_resolve.

import { CategorySection } from "../CategorySection";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { ConflictedNode } from "../../../lib/api";
import { agoShort, baseName } from "./syncFormat";

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
        return (
          <div
            key={c.id}
            className="group w-full flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-state-hover transition-colors min-w-0"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onOpenFile?.(c.file)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  <span className="shrink-0 w-4 h-4 rounded-sm flex items-center justify-center text-2xs font-mono font-semibold bg-bg-1 text-red">
                    !
                  </span>
                  <span className="flex-1 min-w-0 flex items-center gap-1.5">
                    <span className="text-sm text-text-1 truncate">
                      {c.identifier || baseName(c.file)}
                    </span>
                    <span className="text-xs text-text-4 font-mono truncate shrink min-w-0">
                      {baseName(c.file)}
                    </span>
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                <div className="font-medium mb-0.5 truncate max-w-[260px]">
                  {c.file}
                </div>
                <div className="text-text-3 leading-snug">
                  you &amp; {c.theirs_agent || "teammate"} edited this ·{" "}
                  {agoShort(c.opened_at)}
                </div>
              </TooltipContent>
            </Tooltip>
            <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <ResolveBtn
                label="Keep mine"
                disabled={busy}
                onClick={() => onResolve(c.id, "ours")}
              />
              <ResolveBtn
                label="Keep theirs"
                disabled={busy}
                onClick={() => onResolve(c.id, "theirs")}
              />
            </div>
          </div>
        );
      })}
    </CategorySection>
  );
}

function ResolveBtn({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          disabled={disabled}
          className="px-1.5 h-5 rounded text-2xs text-text-3 hover:text-text-1 hover:bg-state-hover disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
