// "Collisions" — the reasoned alert layer of the Team Radar. Each row is a
// scored overlap between my own in-flight work and another actor's, the kind
// of thing a teammate would lean over and tell me: "I'm also on charge_card",
// "I just committed verify_token, rebase before you push". The CLI does the
// scoring + noise-damping, so this only renders what survived — it's quiet
// (auto-hidden) when there's nothing worth interrupting over.

import { CategorySection } from "../CategorySection";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { RadarCollision } from "../../../lib/api";
import { agoFromMs, actorShort, severityMeta } from "./radarFormat";
import { baseName } from "../sync/syncFormat";
import { ActorMark } from "./ActorMark";

type Props = {
  conflicts: RadarCollision[];
  isOpen: boolean;
  onToggle: () => void;
  onOpenFile?: (path: string) => void;
};

export function CollisionsSection({
  conflicts,
  isOpen,
  onToggle,
  onOpenFile,
}: Props) {
  return (
    <CategorySection
      title="Clashes"
      count={conflicts.length}
      isOpen={isOpen}
      onToggle={onToggle}
    >
      {conflicts.map((c) => {
        const sev = severityMeta(c.severity);
        const file = c.their_file;
        return (
          <Tooltip key={c.event_id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => file && onOpenFile?.(file)}
                className="group w-full flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-bg-2/60 transition-colors min-w-0 text-left"
              >
                <span
                  className="shrink-0 w-1.5 h-1.5 rounded-full"
                  style={{ background: sev.color }}
                  aria-hidden
                />
                <ActorMark actor={c.peer} isAgent={c.peer_is_agent} size={18} />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[12px] text-text-1 truncate">
                      {actorShort(c.peer)}
                    </span>
                    <span className="text-[10px] text-text-4 shrink-0">
                      {sev.disposition}
                    </span>
                    {!c.same_branch && (
                      <span className="text-[10px] text-text-4 font-mono truncate shrink min-w-0">
                        {c.their_branch}
                      </span>
                    )}
                  </span>
                  <span className="block text-[10.5px] text-text-3 truncate">
                    {c.reason}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-text-4 tabular-nums">
                  {agoFromMs(c.age_ms)}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-[10.5px]">
              <div className="font-medium mb-0.5 truncate max-w-[260px]">
                {c.peer}
                {c.peer_is_agent ? " · agent" : ""}
              </div>
              <div className="text-text-3 leading-snug max-w-[260px]">
                {c.reason}
              </div>
              <div className="text-text-4 leading-snug mt-0.5">
                touches your <span className="font-mono">{c.mine}</span>
                {file ? ` · ${baseName(file)}` : ""}
              </div>
              {c.their_intent && (
                <div className="text-text-4 leading-snug mt-0.5 italic max-w-[260px]">
                  “{c.their_intent}”
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </CategorySection>
  );
}
