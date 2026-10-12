// The collaboration place, and one way to ask for it.
//
// Tasks was a workpane tab — a board you accumulated in the same strip that
// holds your files, your terminal and your agents. It is not a document. It is
// a place with its own navigation inside it: its buckets and its saved views.
// Standing in it, the frame around it was telling you about something else
// entirely — one repo's branch, its review rail, its changed files, a terminal
// toggle — while the surface you came for had to share the window with all of
// it.
//
// So it is a page, the same as Workspaces, Mission Control, Aura and Trace: it
// takes the window, the repo chrome comes off, and you leave by asking for
// somewhere else in the rail.
//
// This mirrors components/trace/traceRoute for the same reason it exists: the
// callers are deep (a palette command, a page mention), and threading a router
// down to them would put navigation in the props of components that only draw.
//
// `CollabPlace` is a union of one. It stays a union because the plural shape is
// what every caller and every `place === …` branch is written against, and
// because this is where a second board-like page would be named — collapsing it
// to the string "tasks" would buy nothing and cost that.

/** A collaboration surface that owns the window. Not a document, not a dialog.
 *
 *  Spelled `CollabPlace` rather than `Place` because `lib/place` owns that word
 *  now, for the other meaning: somewhere work RUNS — this laptop, a box you
 *  brought, an Aura-managed VM. Two types called `Place` in one `lib`, one
 *  naming a tab and one naming a computer, is a collision a reader has to
 *  resolve by opening both files. */
export type CollabPlace = "tasks";

export const PLACE_GO_EVENT = "aura:place:go";

/** Ask the app to show a collaboration surface. Whoever owns the page listens. */
export function goToPlace(place: CollabPlace): void {
  window.dispatchEvent(new CustomEvent(PLACE_GO_EVENT, { detail: place }));
}
