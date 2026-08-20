// AccessLevelMenu — the control that says what one person in a shared session
// is allowed to do, and changes it on the spot.
//
// It is a ChipButton opening a DropdownMenu, which is the app's one flyout
// recipe (ui/dropdown-menu → ui/menuSurface). Never ui/popover: a popover is a
// panel that happens to float, a menu is a list you pick from, and this is the
// second one.
//
// The two rows carry their whole meaning as text under the label rather than a
// tooltip, because the person changing someone else's access is deciding on
// their behalf and shouldn't have to hover to find out what they just did.

import type { JSX } from "react";
import { Eye, Hand } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { ChipButton } from "../../ui/chip";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { ACCESS_LEVELS, ACCESS_META, type AccessLevel } from "./shareTypes";

/** The glyph for a level, shared by the menu and every row that shows a level
 *  without opening one. An eye watches; a hand is on the wheel. */
export function AccessGlyph({
  level,
  size = 13,
  className,
}: {
  level: AccessLevel;
  size?: number;
  className?: string;
}): JSX.Element {
  const Icon = level === "drive" ? Hand : Eye;
  return <Icon size={size} className={className} aria-hidden />;
}

export type AccessLevelMenuProps = {
  value: AccessLevel;
  onChange: (level: AccessLevel) => void;
  /** True while the change is still travelling to everyone else. The chip
   *  spins rather than snapping, so nobody reads an optimistic label as a
   *  settled fact — this decides whether a colleague can type. */
  saving?: boolean;
  /** The host can't demote themselves, and nobody can change an agent's level
   *  (an agent is instructed, it doesn't instruct). Disabled rows say why. */
  disabled?: boolean;
  /** Why it's locked, in plain words — rendered as the chip's tooltip. */
  disabledReason?: string;
  /** Whose access this is, for the screen reader. */
  personName: string;
};

export function AccessLevelMenu({
  value,
  onChange,
  saving = false,
  disabled = false,
  disabledReason,
  personName,
}: AccessLevelMenuProps): JSX.Element {
  const meta = ACCESS_META[value];

  if (disabled) {
    return (
      <span
        className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-4"
        title={disabledReason}
      >
        <AccessGlyph level={value} size={12} />
        {meta.label}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ChipButton
          variant="outline"
          size="default"
          aria-label={`What ${personName} can do`}
          className="gap-1.5"
        >
          {saving ? (
            <AsciiSpinner size={12} />
          ) : (
            <AccessGlyph
              level={value}
              size={12}
              className={value === "drive" ? "text-accent" : "text-text-3"}
            />
          )}
          {meta.label}
        </ChipButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[268px]">
        <DropdownMenuLabel>What {personName} can do</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as AccessLevel)}
        >
          {ACCESS_LEVELS.map((level) => (
            <DropdownMenuRadioItem
              key={level}
              value={level}
              className="items-start py-2"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-text-1">
                  <AccessGlyph level={level} size={12} className="text-text-3" />
                  {ACCESS_META[level].label}
                </span>
                <span className="text-xs leading-snug text-text-4">
                  {ACCESS_META[level].hostBlurb}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
