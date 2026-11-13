// What each Trace destination does when it is opened — the bag of handlers
// the app hands to the surfaces that list them.

import type { TraceKey } from "./traceDestinations";

export type TraceActions = {
  onOverview: () => void;
  onSessions: () => void;
  onTeamActivity: () => void;
  onIntentAst: () => void;
  onReview: () => void;
  /** Opens the "Ready to ship" surface (Semantic CI) — secrets, half-finished
   *  code, and a clean build, in plain language. Named apart from "Safety
   *  check" so the two never read as synonyms. Lives here in Trace (its one
   *  home), not on the Build rail. */
  onChecks: () => void;
  onImpacts: () => void;
  onProve: () => void;
  onRewind: () => void;
  onAttest: () => void;
  /** Opens Code Map / Project health. Both are parked behind their own flags,
   *  so the strip has no cell for either and nothing calls these until a flag
   *  comes back on — they stay in the bag so flipping one is a one-line
   *  change rather than a re-wiring. */
  onCodeMap: () => void;
  onDoctor: () => void;
  /** Unresolved cross-branch impact count. Drives the conditional
   *  "Impacts on me" row — when 0 the row is hidden entirely (nothing is
   *  reaching your work, so it's not a dead menu entry); when >0 the row
   *  appears with a count chip. The surface itself still carries an
   *  educating empty state for when it's opened by other means. */
  impactsCount?: number;
  // Which launcher row maps to the center pane on screen. Lets the rail
  // highlight "you are here" instead of reading as a flat tool menu —
  // the same cue the section tab strip gives, one level down. Shared with the
  // surface strip (TraceKey) so the two entrances light for the same reasons.
  activeKey?: TraceKey | null;
  /** Goals and Safety check are the two rows that ASK rather than navigate:
   *  they hand a question to Aura and the answer arrives in the chat, so they
   *  can never be `activeKey` (no pane opens). Set this while the question is
   *  out and the row spins instead of taking a second click. */
  busyKey?: "goals" | "review" | null;
};
