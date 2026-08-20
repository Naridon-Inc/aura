// What Aura's verdict is called — one vocabulary, for the whole app.
//
// This is the answer the whole product exists to give: you asked for
// something, an agent said it was done, and Aura went and checked. There are
// four possible answers, and the app had three different names for each of
// them. Which one you got depended on which panel you happened to be looking
// at:
//
//              the Goals surface   the probe + the thread   the roles tooltip
//   verified   Done                Reached                  left it reached
//   partial    Almost              Partly there             left it partly there
//   not_wired  Not yet             Not reached              left it not reached
//   unknown    Not checked         Not checked              check was inconclusive
//
// All three are live and they sit next to each other. Open a task and the goal
// says "Almost"; open the same goal's probe and the same proof says "Partly
// there"; hover the person who last checked it and it says "left it partly
// there". A reader who is not an engineer has no way to know those are one
// claim rather than three stages of something.
//
// The glyphs disagreed too — one surface marked partial "◐" and another "–" —
// and the legacy pane colored `partial` amber in its table and text-1 in the
// block ten lines down.
//
// The Goals surface's words win, on two grounds: it is the surface behind
// GOALS_V2, and "Done / Almost / Not yet" is what someone who does not write
// code would say. "Reached" and "not wired" are ours, not theirs.
//
// Four slots, because a verdict appears in four grammatical positions and the
// same string can't fill them: a word on a pill, a mark beside it, a sentence
// explaining what the word means, and a fragment completing "Ashiq left it …".

import type { GoalVerdict } from "./goalStore";

export type VerdictTone = {
  /** The word on its own — a pill, a row, a heading. */
  label: string;
  /** The mark beside it, for the glance that reads shape before text. Paired
   *  with `color`, never carrying the meaning alone. */
  glyph: string;
  color: string;
  /** One sentence saying what the word means, for a tooltip or a panel with
   *  room. Written to the person who asked for the feature, not to whoever
   *  built it. */
  hint: string;
  /** The claim as a fragment, to complete "<someone> …" — the roles list, where
   *  the subject is a person rather than the goal. */
  past: string;
};

export const VERDICT: Record<GoalVerdict, VerdictTone> = {
  verified: {
    label: "Done",
    glyph: "✓",
    color: "var(--color-accent-green)",
    hint: "Everything this needs is built.",
    past: "left it done",
  },
  partial: {
    label: "Almost",
    glyph: "◐",
    color: "var(--color-amber)",
    hint: "Some of it is built. The rest is still missing.",
    past: "left it partly done",
  },
  not_wired: {
    label: "Not yet",
    glyph: "○",
    color: "var(--color-red)",
    hint:
      "None of what this needs is working yet. Parts may be built, but nothing's wired up.",
    past: "left it not working yet",
  },
  unknown: {
    label: "Not checked",
    glyph: "·",
    color: "var(--color-text-4)",
    hint: "Press Check to see whether the AI built this.",
    past: "left it unchecked",
  },
};
