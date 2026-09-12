// ⌘⇧/ steps the composer's effort level without opening the model switcher.
//
// The effort strip lives inside the model chip's modal, which is three
// clicks from a keyboard. One chord walks Default → Low → Medium → High →
// Max → Default. The order is the same one the strip draws, so what the key
// does and what the buttons show never disagree.

import type { ReasoningEffort } from "./api";

/** The ladder, in the order the strip draws it. `null` is the model's own
 *  default and comes first so a fresh press starts at Low. */
export const EFFORT_ORDER: ReadonlyArray<ReasoningEffort | null> = [
  null,
  "low",
  "medium",
  "high",
  "max",
];

/** The level after `current`, wrapping past Max back to Default. An unknown
 *  value is treated as Default so a stale stored string can't strand the key. */
export function nextEffort(
  current: ReasoningEffort | null | undefined,
): ReasoningEffort | null {
  const at = EFFORT_ORDER.indexOf(current ?? null);
  const pos = at < 0 ? 0 : at;
  return EFFORT_ORDER[(pos + 1) % EFFORT_ORDER.length] ?? null;
}

/** Window event the keymap fires; the composer that has the chip listens. */
export const CYCLE_EFFORT_EVENT = "aura:composer:cycle-effort";

/** What to call the level when telling the user it changed. */
export function effortLabel(level: ReasoningEffort | null): string {
  switch (level) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "max":
      return "Max";
    default:
      return "Default";
  }
}
