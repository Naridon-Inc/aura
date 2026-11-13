// One "pick one of these" submenu in the list heading's menu (Group by,
// Filter by project, Sort by): the label, then the options, the current one
// marked with a check on the right.

import { Check } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../ui/dropdown-menu";

export type MenuChoiceOption<T extends string> = { value: T; label: string };

export function RosterMenuChoice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly MenuChoiceOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={6} className="ui-roster-choice">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            role="menuitemradio"
            aria-checked={o.value === value}
            onSelect={() => onChange(o.value)}
          >
            <span className="ui-roster-filter-name">{o.label}</span>
            {o.value === value && <Check size={16} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
