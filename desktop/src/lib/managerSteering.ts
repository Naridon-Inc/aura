// Single source of truth for the composer's MODE steering prefix.
//
// The backend `brain_chat_turn` has no real `mode` param — Plan/Ask/Auto are
// steered by prefixing the user's turn with a standing instruction the brain
// honors. Both the main chat (`ManagerChatView.send`) and the floating HUD's
// quick-send route through this so a "/plan"-mode turn behaves identically on
// either surface. Build is the default and carries no prefix.
//
// It's a STANDING instruction: the brain keeps the whole conversation, so the
// caller sends it only on the first turn of a session or when the mode changes
// (see the per-session `established` bookkeeping at each call site) — never
// glued onto every message.

/** The four composer modes (structurally identical to ManagerComposer's
 *  `ComposerMode`; kept local so this lib module doesn't import a component). */
export type SteeringMode = "auto" | "plan" | "build" | "ask";

/** The standing directive for a mode, or "" for Build (no steer). */
export function buildSteeringText(mode: SteeringMode): string {
  switch (mode) {
    case "plan":
      return "[PLAN MODE — Discuss and propose a plan FIRST. Surface gray areas via `aura ask-user`, then ALWAYS finish by piping a rich JSON envelope into `aura propose-plan --json -` so the PlanCard + plan tab + Build button render. NEVER paste a wave/phase outline into chat as markdown and ask the user to reply 'build' — the only way to accept a plan is the Build button on the PlanCard. Do not edit files or run shell commands until the user clicks Build.]\n\n";
    case "ask":
      return "[ASK MODE — Read-only. Answer in chat; do not edit files, do not spawn agents, do not run shell mutations. Use Aura MCP read tools only.]\n\n";
    case "auto":
      return "[AUTO MODE — Full autopilot. Judge the request and pick the approach yourself: answer trivial things directly; for real work, make the edits and run the commands end-to-end WITHOUT pausing for plan approval. Do not stop to ask unless you hit a decision only the user can make (then use `aura ask-user`). Keep going until the task is genuinely complete.]\n\n";
    case "build":
    default:
      return "";
  }
}
