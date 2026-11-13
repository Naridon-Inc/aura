// "Collisions" — the reasoned alert layer of the Team Radar. Each row is a
// scored overlap between my own in-flight work and another actor's, the kind
// of thing a teammate would lean over and tell me: "I'm also on charge_card",
// "I just committed verify_token, rebase before you push". The CLI does the
// scoring + noise-damping, so this only renders what survived — it's quiet
// (auto-hidden) when there's nothing worth interrupting over.

import { CategorySection } from "../CategorySection";
import { StatusChip, type ChipTone } from "../../ui/statusChip";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { RadarCollision } from "../../../lib/api";
import { agoFromMs, actorShort, severityMeta } from "./radarFormat";
import { baseName } from "../sync/syncFormat";
import { ActorMark } from "./ActorMark";
import "../../ui/details-pulls.css";
import "../../ui/radar-rows.css";

/** Severity in the same tones a zone's claim wears: a direct clash is the
 *  "locked" red, a likely one the "announced" amber, a possible one quiet. */
const SEVERITY_TONE: Record<RadarCollision["severity"], ChipTone> = {
  direct: "red",
  likely: "amber",
  possible: "neutral",
};

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
              {/* The details panel's two-line row: who and how hard on the
                  first line, why under it. */}
              <button
                type="button"
                onClick={() => file && onOpenFile?.(file)}
                className="ui-details-pull ui-radar-row"
              >
                <div>
                  <ActorMark actor={c.peer} isAgent={c.peer_is_agent} size={16} />
                  <span className="ui-details-pull-title">{actorShort(c.peer)}</span>
                  <StatusChip tone={SEVERITY_TONE[c.severity] ?? "neutral"} dense>
                    {sev.disposition}
                  </StatusChip>
                  <span className="ui-radar-age">{agoFromMs(c.age_ms)}</span>
                </div>
                <div className="ui-details-pull-meta ui-radar-meta">
                  <span>{c.reason}</span>
                  {!c.same_branch && (
                    <span className="ui-details-pull-branch">{c.their_branch}</span>
                  )}
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="ui-radar-tip">
              <strong>
                {c.peer}
                {c.peer_is_agent ? " · agent" : ""}
              </strong>
              <p>{c.reason}</p>
              <p className="ui-radar-tip-quiet">
                touches your <code>{c.mine}</code>
                {file ? ` · ${baseName(file)}` : ""}
              </p>
              {c.their_intent && <p className="ui-radar-tip-intent">“{c.their_intent}”</p>}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </CategorySection>
  );
}
