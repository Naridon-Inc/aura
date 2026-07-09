// "Incoming" — teammates' changes flowing into this tree during a live
// session, sourced from the cross-branch impact feed (aura_read_impacts).
// Rendered above the local git sections so what's arriving sits over what
// you're sending. Mirrors the CategorySection + row look of the rest of
// the panel; clicking a row opens the touched file.

import { CategorySection } from "../CategorySection";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { ImpactAlert } from "../../../lib/api";
import { agoShort, baseName, dirName } from "./syncFormat";

type Props = {
  impacts: ImpactAlert[];
  isOpen: boolean;
  onToggle: () => void;
  onOpenFile?: (path: string) => void;
};

function severityClass(severity: string): string {
  switch (severity) {
    case "critical":
    case "high":
      return "text-red";
    case "medium":
      return "text-amber";
    default:
      return "text-text-3";
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
      count={impacts.length}
      isOpen={isOpen}
      onToggle={onToggle}
    >
      {impacts.map((im) => {
        const dir = dirName(im.file);
        return (
          <Tooltip key={im.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onOpenFile?.(im.file)}
                className="group w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left hover:bg-bg-2/60 transition-colors min-w-0"
              >
                <span
                  className={`shrink-0 w-1.5 h-1.5 rounded-full ${severityClass(
                    im.severity,
                  ).replace("text-", "bg-")}`}
                />
                <span className="flex-1 min-w-0 flex items-center gap-1.5">
                  <span className="text-[12px] text-text-1 truncate">
                    {im.function || baseName(im.file)}
                  </span>
                  {dir && (
                    <span className="text-[10.5px] text-text-4 font-mono truncate shrink min-w-0">
                      {baseName(im.file)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[10px] text-text-4 tabular-nums">
                  {agoShort(im.timestamp)}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-[10.5px]">
              <div className="font-medium mb-0.5 truncate max-w-[260px]">
                {im.file}
              </div>
              <div className="text-text-3 leading-snug">
                {im.message || `changed on ${im.branch}`}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </CategorySection>
  );
}
