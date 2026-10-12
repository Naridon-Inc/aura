/** Pane → ADE section mapping.
 *
 *  Every workpane ref belongs to exactly one left-nav section
 *  (Build / Trace). This is the single source of truth for the left-nav
 *  SECTION HIGHLIGHT only — it does NOT gate tab visibility:
 *    - `App.tsx` section-follow (adeSection useMemo) — derives the active
 *      `adeSection` from the active leaf tab's kind so the left nav lights up
 *      the section the user is looking at.
 *    - `WorkSurface.tsx` `splitFallbackRef` — same purpose, picks a page-ish
 *      leaf ref to drive the highlight when no agent/file/terminal is active.
 *
 *  NOTE: `PerPaneTabStrip` used to FILTER a leaf's tabs down to the active
 *  tab's section (each section showing only its own tabs). That filter was
 *  removed in #221 (commit 51d88a7) — the strip is now one unified bar that
 *  shows EVERY tab in the leaf, so opening a Trace page never hides your open
 *  code/agent tabs. This helper no longer touches the strip; keep it for the
 *  nav highlight alone.
 *
 *  Keep this mapping exhaustive over `WorkPaneRef["kind"]` — a new pane kind
 *  must be classified here or it silently falls through to `build`. */

import type { WorkPaneRef } from "./editorStore";
import type { AdeSection } from "../components/AdeSidebar";

/** The left-nav section a pane ref belongs to. Re-exports `AdeSection` so
 *  call sites can speak in pane terms without reaching into the sidebar. */
export type PaneSection = AdeSection;

/** Classify a workpane ref into its owning left-nav section.
 *
 *    - Trace — the verify/insight surfaces (Review / Rewind / Attestations /
 *      Doctor / Memory / Code Map / Goals / sessions)
 *    - Build — everything else: agent / terminal / manager / file / empty /
 *      tasks / task / standup / plan / automations / screenshare / commons /
 *      app / browser
 *
 *  The rail used to carry Team and Plan sections too, and this switch named a
 *  section per family — a huddle read as Team, a planning surface as Plan.
 *  Both sections are gone, so a pane that is not one of Trace's lights Build,
 *  which is the only other thing the rail can light. Written as an explicit
 *  trace list with a default rather than one arm per kind, because the
 *  alternative is a dozen cases that all say the same word. */
export function sectionForRef(ref: WorkPaneRef): PaneSection {
  switch (ref.kind) {
    case "trace":
    case "sessions":
    case "inspector":
    case "replay":
    case "prove":
    case "graph":
      return "trace";
    default:
      return "build";
  }
}
