// The Stack row of the Checks tab's facts: "On #98" when this pull request is
// built on another one, "#100 builds on this" when it is the one underneath.
// Pressing it shows the whole chain, base first. Nothing at all while the
// stack is read, when it can't be, or when the pull request stands alone.

import { Layers } from "lucide-react";

import { PrStackView, usePrStack } from "../pr/PrStackView";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { stackLine } from "./checksPrModel";

export function ChecksStackFact({ repoRoot, prNumber }: { repoRoot: string; prNumber: number }) {
  const { nodes, loading, error } = usePrStack(repoRoot, prNumber);
  const line = loading || error ? null : stackLine(nodes, prNumber);
  if (!line) return null;
  return (
    <>
      <dt>
        <Layers />
        Stack
      </dt>
      <dd>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="ui-pr-details-link" title="Show the whole stack">
              {line}
              <span className="ui-pr-details-aside">{nodes.length} in stack</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="ui-pr-stack-popover">
            <PrStackView repoRoot={repoRoot} prNumber={prNumber} currentLabel="This workspace" />
          </PopoverContent>
        </Popover>
      </dd>
    </>
  );
}
