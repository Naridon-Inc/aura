// Where Trace is, as one value — and one way to ask to go there.
//
// Trace's destinations used to be opened by six different editor-store calls
// (`openSessions`, `openInspector`, `openReplay`, `openProve`, `openGraph`,
// `openTraceTool`), each of which added a TAB to the work surface. That is why
// Trace ended up with a tab strip above its own tab strip, and why the app grew
// a second door to the same places in the header's overflow menu: a tab is a
// thing you accumulate, so every entrance made another one.
//
// Trace is a place, not a document you keep open — the same as Workspaces,
// Mission Control and Aura, which are pages. So this is the address of a page,
// and `goToTrace` is the only way to ask for it.
//
// It travels as a window event rather than a prop because the callers are deep:
// a symbol row inside an intent story asking for the time machine, a session
// card asking for its attestation. Threading a router through four layers of
// presentation components to reach them would put navigation in the props of
// things that only draw.

import type { TraceToolKind, TraceView } from "../../lib/editorStore";

/** One Trace destination, fully addressed — the view for Sessions, the tool
 *  plus its prefill for the verify tools. */
export type TraceDest =
  | { kind: "sessions"; view: TraceView }
  | { kind: "inspector" }
  | { kind: "replay" }
  | { kind: "prove" }
  | { kind: "graph" }
  | {
      kind: "tool";
      tool: TraceToolKind;
      arg?: { identifier?: string; file?: string };
    };

export const TRACE_GO_EVENT = "aura:trace:go";

/** Ask the app to show a Trace destination. Whoever owns the page listens. */
export function goToTrace(dest: TraceDest): void {
  window.dispatchEvent(new CustomEvent(TRACE_GO_EVENT, { detail: dest }));
}
