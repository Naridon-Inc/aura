// Feature Map — "Needs a look".
//
// One chip in the toolbar that opens the short list worth a person's
// attention: flows a prover run said stop short, and flows whose files
// changed inside the change window. Picking one opens that flow on the
// map. The chip stays hidden when there is nothing to list — an empty
// menu is a promise the map cannot keep.

import type { KgFlow } from "../../../lib/api";
import { ChipButton } from "../../ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { relativeTime, type NeedsALook } from "./model";

type Props = {
  items: NeedsALook;
  now: number;
  featureName: (featureId: string) => string;
  onPick: (flow: KgFlow) => void;
};

export function NeedsALookMenu({ items, now, featureName, onPick }: Props) {
  const count = items.gaps.length + items.changed.length;
  if (count === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ChipButton variant="outline" size="sm" chevron>
          Needs a look
          <span className="ml-1 text-text-4 tabular-nums">{count}</span>
        </ChipButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {items.gaps.length > 0 && (
          <>
            <DropdownMenuLabel>Stops short</DropdownMenuLabel>
            {items.gaps.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => onPick(f)}>
                <span className="size-1.5 rounded-full bg-red shrink-0" />
                <span className="truncate">{f.name}</span>
                <span className="ml-auto text-text-4 text-2xs truncate max-w-[40%]">
                  {featureName(f.feature)}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {items.gaps.length > 0 && items.changed.length > 0 && <DropdownMenuSeparator />}
        {items.changed.length > 0 && (
          <>
            <DropdownMenuLabel>Changed recently</DropdownMenuLabel>
            {items.changed.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => onPick(f)}>
                <span className="size-1.5 rounded-full bg-amber shrink-0" />
                <span className="truncate">{f.name}</span>
                <span className="ml-auto text-text-4 text-2xs whitespace-nowrap">
                  {f.changed ? relativeTime(f.changed.when, now) : ""}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
