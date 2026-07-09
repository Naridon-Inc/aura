// FolderColorPopover — a compact swatch grid for picking a folder's color.
// Plain language, no jargon: a small row of muted color dots the user taps to
// label a folder. Default is a calm blue. Kept tiny + self-contained so both
// the create-folder flow and the per-folder menu can reuse it.

import { Check } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  FOLDER_COLORS,
  type FolderColorToken,
} from "../pages2/folderColors";

type Props = {
  /** Currently selected token (highlights its swatch). */
  value: string;
  onPick: (token: FolderColorToken) => void;
  className?: string;
};

export function FolderColorPopover({ value, onPick, className }: Props) {
  return (
    <div
      className={cn(
        "grid grid-cols-7 gap-1.5 p-1.5",
        className,
      )}
      role="group"
      aria-label="Folder color"
    >
      {FOLDER_COLORS.map((c) => {
        const active = c.token === value;
        return (
          <button
            key={c.token}
            type="button"
            title={c.label}
            aria-label={c.label}
            aria-pressed={active}
            onClick={() => onPick(c.token)}
            className={cn(
              "relative w-5 h-5 rounded-full grid place-items-center transition-transform",
              "hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              active && "ring-2 ring-offset-1 ring-offset-bg-2 ring-text-3",
            )}
            style={{ background: c.tint }}
          >
            {active && (
              <Check className="w-3 h-3 text-white" strokeWidth={3} aria-hidden />
            )}
          </button>
        );
      })}
    </div>
  );
}
