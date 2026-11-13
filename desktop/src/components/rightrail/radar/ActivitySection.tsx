// "Activity" — the ambient half of the Team Radar: a pull feed of everyone's
// recent awareness events (who started / is editing / intends / just
// committed which symbol). Unlike Collisions, this is NOT scored against my
// work — it's the situational backdrop, collapsed by default so it never
// competes with the alert layer. Self-events are already excluded upstream
// for collisions but DO appear here (it's a feed of the whole team, me
// included), dimmed via the agent/human styling.

import { ShieldCheck } from "lucide-react";
import { CategorySection } from "../CategorySection";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { RadarEvent } from "../../../lib/api";
import { agoFromTs, actorShort, kindLabel, activityStatus } from "./radarFormat";
import { ActorMark } from "./ActorMark";
import "../../ui/details-pulls.css";
import "../../ui/details-radar.css";
import "../../ui/radar-rows.css";

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
          panel that reads as broken. The band's own quiet line, word for word
          and in its style. */}
      {events.length === 0 && (
        <p className="ui-details-radar-quiet">
          Quiet. Nobody has touched this repository in the last day.
        </p>
      )}
      {events.map((e) => {
        // Two plain-language lines: the actor's name, then a human status
        // ("working on create session"). No function names or git verbs leak
        // into the row — they live in the tooltip for anyone who wants the
        // mechanical detail.
        const status = activityStatus(e);
        return (
          <Tooltip key={e.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => e.file && onOpenFile?.(e.file)}
                className="ui-details-pull ui-radar-row"
              >
                <div>
                  <ActorMark actor={e.actor} isAgent={e.is_agent} size={16} />
                  <span className="ui-details-pull-title">{actorShort(e.actor)}</span>
                  {e.verified && <VerifiedTick />}
                  <span className="ui-radar-age">{agoFromTs(e.ts)}</span>
                </div>
                <div className="ui-details-pull-meta ui-radar-meta">
                  <span>{status}</span>
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="ui-radar-tip">
              <strong>
                {e.actor}
                {e.is_agent ? " · agent" : ""}
              </strong>
              <p>
                {kindLabel(e.kind)}
                {e.symbol ? ` ${e.symbol}` : ""}
                {e.file ? ` · ${e.file}` : ""}
              </p>
              {e.intent && <p className="ui-radar-tip-intent">“{e.intent}”</p>}
              {e.verified ? (
                <p className="ui-radar-tip-verified">
                  <VerifiedTick />
                  verified · signature checks out
                </p>
              ) : e.sig ? (
                <p className="ui-radar-tip-quiet">signed · not verified on this machine</p>
              ) : null}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </CategorySection>
  );
}

// Marks an event whose embedded pubkey re-derives its key_id AND validates the
// signature — cryptographic proof it's genuinely from the actor it claims,
// verified locally on this machine (not just "has a sig"). Success green,
// never the interactive accent.
function VerifiedTick() {
  return (
    <ShieldCheck
      className="ui-radar-verified"
      aria-label="verified"
      role="img"
    >
      <title>verified · signature checks out</title>
    </ShieldCheck>
  );
}
