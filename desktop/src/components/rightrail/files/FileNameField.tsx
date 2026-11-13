// The name field drawn in a row while it is being renamed, or while a new
// file or folder is being named. Enter or leaving the field with a name keeps
// it; Escape, or leaving it empty, lets it go.

import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Input } from "../../ui/input";

/** The row underneath is a tree item that reacts to keys, clicks and drags;
 *  none of that may reach it from inside the field. */
const keep = (event: SyntheticEvent) => event.stopPropagation();

export function FileNameField({
  initial = "",
  folder,
  onCommit,
  onCancel,
}: {
  initial?: string;
  folder: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Commit and cancel can both arrive (Enter, then the blur it causes).
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    if (name && name.trim()) onCommit(name.trim());
    else onCancel();
  };

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // A rename selects the name without its extension.
    if (initial) {
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
  }, [initial]);

  return (
    <Input
      ref={ref}
      size="small"
      className="ui-details-file-name"
      aria-label={initial ? `New name for ${initial}` : folder ? "Folder name" : "File name"}
      placeholder={folder ? "Folder name" : "File name"}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(value);
        else if (event.key === "Escape") finish(null);
      }}
      onClick={keep}
      onMouseDown={keep}
      onMouseUp={keep}
      onContextMenu={keep}
      onDragStart={(event) => event.preventDefault()}
    />
  );
}
