/** Pane → ADE section mapping.
 *
 *  Every workpane ref belongs to exactly one left-nav section
 *  (Build / Team / Plan / Trace). This is the single source of truth for the
 *  left-nav SECTION HIGHLIGHT only — it does NOT gate tab visibility:
 *    - `App.tsx` section-follow (adeSection useMemo) — derives the active
 *      `adeSection` from the active leaf tab's kind so the left nav lights up
 *      the section the user is looking at.
 *    - `WorkSurface.tsx` `splitFallbackRef` — same purpose, picks a page-ish
 *      leaf ref to drive the highlight when no agent/file/terminal is active.
 *
 *  NOTE: `PerPaneTabStrip` used to FILTER a leaf's tabs down to the active
 *  tab's section (each section showing only its own tabs). That filter was
 *  removed in #221 (commit 51d88a7) — the strip is now one unified bar that
 *  shows EVERY tab in the leaf, so opening a Plan/Trace/Team page never hides
 *  your open code/agent tabs. This helper no longer touches the strip; keep
 *  it for the nav highlight alone.
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
 *  Mirrors the section-follow switch that used to live inline in `App.tsx`:
 *    - Plan  — tasks / task / standup / plan / pages / automations
 *    - Team  — screenshare / channels
 *    - Trace — trace tools (Review / Rewind / Attestations / Doctor / Memory)
 *    - Build — agent / terminal / manager / file / empty */
export function sectionForRef(ref: WorkPaneRef): PaneSection {
  switch (ref.kind) {
    case "tasks":
    case "task":
    case "standup":
    case "plan":
    case "pages":
    // Automations (scheduled / orchestrated runs) is a planning surface — it
    // re-homed from the Build rail into Plan alongside Tasks & Pages.
    case "automations":
      return "plan";
    case "screenshare":
    case "channels":
    // Commons (Lounge + Plugin Exchange) lives as a right-rail tab; when
    // its full-width center surface is open via the rail's expand action,
    // the left nav reads as Team — it's the social/collaboration family.
    case "commons":
    // Full-surface plugin mini-apps (Gemini / Gmail / Reddit clients) are
    // launched from Commons, so they read as Team too.
    case "app":
      return "team";
    case "trace":
    case "sessions":
    case "inspector":
    case "replay":
    case "prove":
    case "graph":
      return "trace";
    default:
      // agent / terminal / manager / file / empty
      return "build";
  }
}
