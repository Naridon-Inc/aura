// The Get-started tour script. The audience already knows what an AI coding
// agent is — so this does NOT explain "what is an AI coder." It teaches what's
// different HERE: the workspace (and why it exists at all), that one chat drives
// your agent, that you can switch that chat between Claude Code / Codex / Gemini,
// and that every change carries its "why". Each beat is demonstrated on the
// bundled sample project (lib/sampleProject) so the surface the tour lands on is
// already full of real state — a finished chat, a live one, a trace, tasks and
// teammates. Plain-language, benefit-first, one idea per beat, no git / AST /
// crypto jargon.
//
// Interactivity: a step may carry a `cta` — a single "try it" action that
// dispatches an app event (e.g. focus the composer). The tour renders it as an
// accent button beside Next so the user DOES the thing instead of only reading.

export type TourPlacement = "right" | "left" | "top" | "bottom" | "center";

/** An optional "try it" action on a step. `event` is dispatched on window so
 *  App-level listeners can react (focus composer, open a surface, etc.). */
export type TourCta = { label: string; event: string };

export type TourStep = {
  id: string;
  /** CSS selector for the element to spotlight. Absent → a centered card
   *  (welcome / finish). If present but not found at runtime, the step
   *  gracefully degrades to a centered card so its copy still shows. */
  anchor?: string;
  /** Click the anchor on step-enter so the app switches to that surface
   *  behind the spotlight. Only safe on the AdeSidebar section buttons (plain
   *  nav toggles) — never on controls that open a menu (the brain chip, the
   *  project switcher), which just get pointed at, not clicked. */
  activate?: boolean;
  /** Short uppercase label above the title (usually the surface name). */
  eyebrow?: string;
  title: string;
  /** One or two short sentences. Keep it skimmable. */
  body: string;
  /** Optional "try it" affordance — makes the beat interactive. */
  cta?: TourCta;
  placement?: TourPlacement;
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    eyebrow: "Get started",
    title: "This is a live sample workspace",
    body: "Recipe Box — a real project, already set up — so you can see how Aura works before pointing it at your own code.",
    placement: "center",
  },
  {
    id: "workspace",
    anchor: '[data-tour="workspace"]',
    eyebrow: "Workspace",
    title: "Your project, and every agent on it",
    body: "One place for your code, your agents, and the history of every change. A terminal forgets when you close it — this doesn't. Switch or add projects here.",
    placement: "bottom",
  },
  {
    id: "build",
    anchor: '[data-tour="section-build"]',
    activate: true,
    eyebrow: "Build",
    title: "One chat drives your agent",
    body: "Ask in plain English — “add a search box.” Your agent does the work and shows each step. There's a finished chat and a live one right here.",
    placement: "right",
  },
  {
    id: "switch",
    anchor: '[data-tour="brain"]',
    eyebrow: "Switch agents",
    title: "Same chat, any agent",
    body: "Hand the conversation to Claude Code, Codex or Gemini — or run several at once. It's your Claude Code, just with a memory around it.",
    placement: "top",
  },
  {
    id: "trace",
    anchor: '[data-tour="section-trace"]',
    activate: true,
    eyebrow: "Trace",
    title: "The “why” behind every change",
    body: "Not just what changed — why. Come back next week, or hand off to a teammate, and the project still makes sense.",
    placement: "right",
  },
  {
    id: "finish",
    eyebrow: "You're set",
    title: "Explore, or bring your own code",
    body: "Poke around the sample, then open your own project and put your agents to work. You can replay this anytime from Settings.",
    cta: { label: "Start building", event: "aura:tour-focus-composer" },
    placement: "center",
  },
];
