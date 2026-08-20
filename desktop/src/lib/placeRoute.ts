// The three collaboration places, and one way to ask for them.
//
// Pages, Tasks and Team were workpane tabs — documents you accumulated in the
// same strip that holds your files, your terminal and your agents. None of the
// three is a document. Each is a place with its own navigation inside it: Team
// carries its conversation list, Pages its index of documents, Tasks its
// buckets and saved views. Standing in one of them, the frame around it was
// telling you about something else entirely — one repo's branch, its review
// rail, its changed files, a terminal toggle — while the surface you came for
// had to share the window with all of it.
//
// So they are pages, the same as Workspaces, Mission Control, Aura and Trace:
// they take the window, the repo chrome comes off, and you leave by asking for
// somewhere else in the rail.
//
// This mirrors components/trace/traceRoute for the same reason it exists: the
// callers are deep (an empty pane offering "open chat", a page mention, a
// palette command), and threading a router down to them would put navigation
// in the props of components that only draw.

/** A collaboration surface that owns the window. Not a document, not a dialog.
 *
 *  Spelled `CollabPlace` rather than `Place` because `lib/place` owns that word
 *  now, for the other meaning: somewhere work RUNS — this laptop, a box you
 *  brought, an Aura-managed VM. Two types called `Place` in one `lib`, one
 *  naming a tab and one naming a computer, is a collision a reader has to
 *  resolve by opening both files. */
export type CollabPlace = "pages" | "tasks" | "team";

export const PLACE_GO_EVENT = "aura:place:go";

/** Ask the app to show a collaboration surface. Whoever owns the page listens. */
export function goToPlace(place: CollabPlace): void {
  window.dispatchEvent(new CustomEvent(PLACE_GO_EVENT, { detail: place }));
}
