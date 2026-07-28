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
import { agoFromTs, actorShort, kindLabel, activityStatus } from "./radarFormat";
import { ActorMark } from "./ActorMark";

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
      {/* An empty feed is a real answer, not a loading state. The engine only
          hands us events from the last day, so nothing here means nobody has
          been in this project recently — say that, rather than leaving a blank
          panel that reads as broken. */}
      {events.length === 0 && (
        <div className="px-2 py-1.5 text-[11px] text-text-4">
          Quiet — nobody has touched this project in the last day.
        </div>
      )}
      {events.map((e) => {
        // One plain-language line: "Ashiq — working on create session". The
        // actor's name leads (bold), then a human status; no function names or
        // git verbs leak into the row (they live in the tooltip for anyone who
        // wants the mechanical detail).
        const status = activityStatus(e);
        return (
          <Tooltip key={e.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => e.file && onOpenFile?.(e.file)}
                className="group w-full flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-bg-2/60 transition-colors min-w-0 text-left"
              >
                <ActorMark actor={e.actor} isAgent={e.is_agent} size={18} />
                <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
                  <span className="text-[11.5px] text-text-2 font-medium shrink-0">
                    {actorShort(e.actor)}
                  </span>
                  <span className="text-[11px] text-text-3 truncate min-w-0">
                    {status}
                  </span>
                </span>
                {e.verified && <VerifiedTick />}
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
              {e.verified ? (
                <div className="text-accent-green leading-snug mt-0.5 flex items-center gap-1">
                  <VerifiedTick />
                  verified · signature checks out
                </div>
              ) : e.sig ? (
                <div className="text-text-4 leading-snug mt-0.5">
                  signed · not verified on this machine
                </div>
              ) : null}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </CategorySection>
  );
}

// A tiny shield-check that marks an event whose embedded pubkey re-derives its
// key_id AND validates the signature — cryptographic proof it's genuinely from
// the actor it claims, verified locally on this machine (not just "has a sig").
// Semantic accent-green (success/verified), never the interactive brand accent.
function VerifiedTick() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-accent-green"
      aria-label="verified"
    >
      <title>verified · signature checks out</title>
      <path d="M12 2 4 5v6c0 4.5 3.2 7.9 8 9 4.8-1.1 8-4.5 8-9V5l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
