// Renaming in place: the thing being named is the row, so the field takes the
// row's own spot. Enter or leaving the field keeps the name, Escape drops it,
// and an empty name puts the derived one back.

import { Input } from "../../ui/input";
import type { RosterEnv } from "./rosterTypes";

export function RosterRename({
  env,
  placeholder,
  label,
}: {
  env: RosterEnv;
  placeholder: string;
  label: string;
}) {
  return (
    <Input
      size="small"
      className="ui-roster-rename"
      value={env.renaming?.value ?? ""}
      autoFocus
      spellCheck={false}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => env.setRenameValue(e.currentTarget.value)}
      onBlur={env.commitRename}
      // The row around it is a button; a rename in progress owns the pointer
      // and the keyboard.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") env.commitRename();
        if (e.key === "Escape") env.cancelRename();
      }}
    />
  );
}
