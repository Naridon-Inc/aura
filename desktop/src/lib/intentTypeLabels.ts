// Canonical intent types → everyday words.
//
// `intent_type` is a CamelCase enum on the intent row (FeatureAdd, BugFix,
// Refactor, Revert, Performance, Docs, Deps). It is written by agents and the
// CLI, and it must never reach a reader in that form — "FeatureAdd" is not a
// word, and the people this app is for did not write the code.
//
// Two registers, because the same tag appears at two zooms:
//   • `intentTypeChip`     — a couple of words for a dense chip in a feed row.
//   • `intentTypeSentence` — a full noun phrase for a detail surface that
//                            reads "This was …".
// Both fall back to the raw value with its CamelCase/snake_case spaced out, so
// a type we haven't met yet still reads like English rather than like an enum.
//
// This lives here because three surfaces had grown their own copy of the map
// (the attestation detail, the timeline moment, and the year-in-review), which
// is how "BugFix" ended up reading three different ways — and how the team
// feed ended up printing the raw enum for want of a fourth.

import { sentenceCase } from "./textCase";

const CHIP: Record<string, string> = {
  FeatureAdd: "New feature",
  BugFix: "Bug fix",
  Refactor: "Tidy-up",
  Revert: "Undo",
  Performance: "Speed-up",
  Docs: "Docs",
  Deps: "Dependencies",
};

const SENTENCE: Record<string, string> = {
  FeatureAdd: "A new feature",
  BugFix: "A bug fix",
  Refactor: "Code cleanup",
  Revert: "An undo of earlier work",
  Performance: "A speed-up",
  Docs: "Documentation",
  Deps: "Dependency updates",
};

/** CamelCase / snake_case → spaced words, first letter up. */
function spaceOut(type: string): string {
  const spaced = (type ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced ? sentenceCase(spaced) : type;
}

/** Short form for a chip in a list row — "New feature", "Bug fix". */
export function intentTypeChip(type: string): string {
  return CHIP[type] ?? spaceOut(type);
}

/** Long form for a detail surface — "A new feature", "A bug fix". */
export function intentTypeSentence(type: string): string {
  return SENTENCE[type] ?? spaceOut(type);
}
