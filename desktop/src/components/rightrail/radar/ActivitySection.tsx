// "Activity" — the ambient half of the Team Radar: a pull feed of everyone's
// recent awareness events (who started / is editing / intends / just
// committed which symbol). Unlike Collisions, this is NOT scored against my
// work — it's the situational backdrop, collapsed by default so it never
// competes with the alert layer. Self-events are already excluded upstream
// for collisions but DO appear here (it's a feed of the whole team, me
// included), dimmed via the agent/human styling.

import { CategorySection } from "../CategorySection";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { RadarEvent } from "../../../lib/api";
import { agoFromTs, actorShort, kindGlyph, kindLabel } from "./radarFormat";
import { baseName } from "../sync/syncFormat";

type Props = {
  events: RadarEvent[];
  isOpen: boolean;
  onToggle: () => void;
  onOpenFile?: (path: string) => void;
};

export function ActivitySection({ events, isOpen, onToggle, onOpenFile }: Props) {
  return (
    <CategorySection
      title="Activity"
      count={events.length}
      isOpen={isOpen}
      onToggle={onToggle}
    >
      {events.map((e) => {
        const target = e.symbol || (e.file ? baseName(e.file) : "");
        return (
          <Tooltip key={e.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => e.file && onOpenFile?.(e.file)}
                className="group w-full flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-bg-2/60 transition-colors min-w-0 text-left"
              >
                <span
                  className="shrink-0 w-3.5 text-center text-[11px] text-text-3"
                  aria-hidden
                >
                  {kindGlyph(e.kind)}
                </span>
                <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
                  <span className="text-[11.5px] text-text-2 truncate shrink-0 max-w-[40%]">
                    {actorShort(e.actor)}
                  </span>
                  <span className="text-[10px] text-text-4 shrink-0">
                    {kindLabel(e.kind)}
                  </span>
                  {target && (
                    <span className="text-[11px] text-text-1 font-mono truncate min-w-0">
                      {target}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[10px] text-text-4 tabular-nums">
                  {agoFromTs(e.ts)}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-[10.5px]">
              <div className="font-medium mb-0.5 truncate max-w-[260px]">
                {e.actor}
                {e.is_agent ? " · agent" : ""}
              </div>
              <div className="text-text-3 leading-snug">
                {kindLabel(e.kind)}
                {e.symbol ? ` ${e.symbol}` : ""}
                {e.file ? ` · ${e.file}` : ""}
              </div>
              {e.intent && (
                <div className="text-text-4 leading-snug mt-0.5 italic max-w-[260px]">
                  “{e.intent}”
                </div>
              )}
              {e.sig && (
                <div className="text-text-4 leading-snug mt-0.5">
                  🔏 signed · {e.branch}
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </CategorySection>
  );
}
