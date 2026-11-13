// The Get-started tour script. The audience already knows what an AI coding
// agent is — so this does NOT explain "what is an AI coder." It teaches what's
// different HERE: the workspace (and why it exists at all), that one chat drives
// your agent, that you can switch that chat between Claude Code / Codex / Gemini,
// that every task sits on one board, and that every change carries its "why".
// Each beat is demonstrated on the bundled sample project (lib/sampleProject) so
// the surface the tour lands on is already full of real state — a finished
// chat, a live one, a trace, tasks. Plain-language, benefit-first, one idea per
// beat, no git / AST / crypto jargon.
//
// Interactivity: a step may carry a `cta` — a single "try it" action that
// dispatches an app event (e.g. focus the composer). The tour renders it in
// place of Next so the user DOES the thing instead of only reading.

export type TourPlacement = "right" | "left" | "top" | "bottom" | "center";

/** An optional "try it" action on a step. `event` is dispatched on window so
 *  App-level listeners can react (focus composer, open a surface, etc.). */
export type TourCta = { label: string; event: string };

export type TourStep = {
  id: string;
  /** CSS selector for the element to ring. Absent (and no `nav`) → the
   *  step is a dialog (welcome / finish). If present but not found at
   *  runtime, the step falls back to the dialog so its copy still shows. */
  anchor?: string;
  /** A row of the sidebar's main navigation, by the label it shows
   *  ("Dashboard", "Trace"). Takes the place of `anchor`. */
  nav?: string;
  /** Click the place on step-enter so the app switches to that surface
   *  behind the ring. Only safe on main navigation rows (plain page
   *  switches) — never on controls that open a menu (the agent picker),
   *  which just get pointed at, not clicked. */
  activate?: boolean;
  title: string;
  /** One or two short sentences. Keep it skimmable. */
  body: string;
  /** Optional "try it" affordance — makes the beat interactive. */
  cta?: TourCta;
  placement?: TourPlacement;
};

/** Where a step points, if that place is on screen right now. */
export function findTourAnchor(step: TourStep): HTMLElement | null {
  if (step.nav) {
    const rows = document.querySelectorAll<HTMLElement>(
      'nav[aria-label="Main navigation"] .ui-sidebar-item-target',
    );
    for (const row of rows) {
      if (row.querySelector(".ui-sidebar-item-label")?.textContent === step.nav) return row;
    }
    return null;
  }
  return step.anchor ? document.querySelector<HTMLElement>(step.anchor) : null;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "This is a live sample workspace",
    body: "Recipe Box (a real repository, already set up) so you can see how Aura works before pointing it at your own code.",
    placement: "center",
  },
  {
    id: "workspaces",
    anchor: ".ui-roster",
    title: "Your workspaces, and every agent in them",
    body: "Each workspace is your code, the agents working on it, and the history of every change. A terminal forgets when you close it, this doesn't. Create starts a new one.",
    placement: "right",
  },
  {
    id: "chat",
    anchor: '[data-tour="brain"]',
    title: "One chat drives your agent",
    body: "Ask in plain English, “add a search box,” and watch each step. Hand the same chat to Claude Code, Codex or Gemini, or run several at once.",
    placement: "top",
  },
  {
    id: "dashboard",
    nav: "Dashboard",
    activate: true,
    title: "Every task on one board",
    body: "What's queued, in progress, in review and done, across all your workspaces, so nothing an agent started gets lost.",
    placement: "right",
  },
  {
    id: "trace",
    nav: "Trace",
    activate: true,
    title: "The “why” behind every change",
    body: "Not just what changed. Why. Come back next week, or hand off to a teammate, and the repository still makes sense.",
    placement: "right",
  },
  {
    id: "finish",
    title: "Explore, or bring your own code",
    body: "Poke around the sample, then open your own repository and put your agents to work. You can replay this anytime from Settings.",
    cta: { label: "Start building", event: "aura:tour-focus-composer" },
    placement: "center",
  },
];
