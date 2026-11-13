// "Incoming" — teammates' changes flowing into this tree during a live
// session, sourced from the cross-branch impact feed (aura_read_impacts).
// Rendered above the local git sections so what's arriving sits over what
// you're sending. Each row is the details panel's two-line row, the one the
// radar's clashes and zones use: what changed and when on the first line,
// what it means under it. Clicking a row opens the touched file.

import { CategorySection } from "../CategorySection";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { ImpactAlert } from "../../../lib/api";
import { agoShort, baseName } from "./syncFormat";
import "../../ui/details-pulls.css";
import "../../ui/radar-rows.css";
import "../../ui/sync-rows.css";

type Props = {
  /** `null` while the impact feed hasn't been read. The group hides itself
   *  on an empty list — correct for "nothing is coming in", a lie for "we
   *  couldn't ask" — so an unread feed says so instead. */
  impacts: ImpactAlert[] | null;
  isOpen: boolean;
  onToggle: () => void;
  onOpenFile?: (path: string) => void;
};

/** The row's dot in the details panel's tones: a high or critical change is
 *  the failing red, a medium one the waiting amber, the rest stay quiet. */
function severityTone(severity: string): "bad" | "waiting" | undefined {
  switch (severity) {
    case "critical":
    case "high":
      return "bad";
    case "medium":
      return "waiting";
    default:
      return undefined;
  }
}

export function IncomingSection({
  impacts,
  isOpen,
  onToggle,
  onOpenFile,
}: Props) {
  return (
    <CategorySection
      title="Incoming"
      count={impacts?.length ?? 0}
      isOpen={isOpen}
      onToggle={onToggle}
      empty={
        impacts === null
          ? "Couldn’t check what your teammates are sending over. This list isn’t up to date."
          : undefined
      }
    >
      {(impacts ?? []).map((im) => (
        <Tooltip key={im.id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onOpenFile?.(im.file)}
              className="ui-details-pull ui-radar-row"
            >
              <div>
                <span
                  className="ui-details-pull-dot"
                  data-tone={severityTone(im.severity)}
                  aria-label={`${im.severity} impact`}
                />
                <span className="ui-details-pull-title">
                  {im.function || baseName(im.file)}
                </span>
                <span className="ui-radar-age">{agoShort(im.timestamp)}</span>
              </div>
              <div className="ui-details-pull-meta ui-sync-meta">
                <span>{im.message || `changed on ${im.branch}`}</span>
                {im.function && (
                  <span className="ui-details-pull-branch">{baseName(im.file)}</span>
                )}
              </div>
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="ui-radar-tip">
            <strong>{im.file}</strong>
            <p className="ui-radar-tip-quiet">
              {im.message || `changed on ${im.branch}`}
            </p>
          </TooltipContent>
        </Tooltip>
      ))}
    </CategorySection>
  );
}
