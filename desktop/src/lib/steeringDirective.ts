// Internal steering/pipe directives the composer prepends to a user turn so
// the brain honours a mode (build / plan / ask / auto) or knows the user also
// drove an agent PTY directly. These are model-facing wiring — they must reach
// the brain, but they are NEVER human-facing: not in the chat bubble, not in
// the session title. Strip them at every display site.
//
// The mode block is a single bracketed line: `[AUTO MODE — …]` (em/en/hyphen
// dash), followed by a blank line. The pipe marker is `[↪ PIPED …]`. Neither
// nests a `]`, so a lazy match to the first `]` is exact. We only strip blocks
// we recognise, so a user message that legitimately opens with `[` survives.
const MODE_DIRECTIVE_RE = /^\s*\[(?:AUTO|PLAN|BUILD|ASK)\s+MODE\s+[—\-–][\s\S]*?\]\s*/i;
const PIPE_MARKER_RE = /^\s*\[↪\s+PIPED[\s\S]*?\]\s*/i;
// The goal marker tags a user turn the user chose to "send as a goal" (the
// composer's Goal toggle). Like the mode directive it's model-facing steering —
// the brain reads it to treat the turn as a standing outcome to plan through the
// crew work-loop and prove — and NEVER human-facing. The chat bubble strips it
// and shows a "Sent as goal" badge instead; `hasGoalDirective` drives that badge.
const GOAL_DIRECTIVE_RE = /^\s*\[GOAL\b[\s\S]*?\]\s*/i;

/** The exact steering block a "send as goal" turn is prefixed with. Kept as a
 *  builder (not a bare const) to mirror `buildSteeringText`; the brain honours
 *  it as a standing instruction, and `GOAL_DIRECTIVE_RE` strips the same block
 *  for display. Contains no nested `]` so the lazy strip is exact. */
export function buildGoalDirective(): string {
  return (
    "[GOAL — Treat the message below as a standing goal to deliver, not a " +
    "one-off reply. Break it into connected tasks on the crew work-loop, drive " +
    "it to completion, and prove the outcome; surface your planning and each " +
    "step as tool calls the user can watch. Keep the goal in view until it is " +
    "reached.]\n\n"
  );
}

/** True when a (raw, unstripped) user turn was sent as a goal — i.e. it opens
 *  with the goal steering block. Lets the bubble render the "Sent as goal"
 *  badge from the persisted turn alone, so it survives reload. */
export function hasGoalDirective(text: string): boolean {
  return GOAL_DIRECTIVE_RE.test(text);
}

/** Remove leading internal steering/pipe/goal directives from a user turn for
 *  display. Applied to chat bubbles and to session titles/objectives. Runs
 *  each pattern repeatedly so a stacked pipe + mode + goal prefix all come off. */
export function stripSteeringDirective(text: string): string {
  let out = text;
  let prev: string;
  do {
    prev = out;
    out = out
      .replace(MODE_DIRECTIVE_RE, "")
      .replace(PIPE_MARKER_RE, "")
      .replace(GOAL_DIRECTIVE_RE, "");
  } while (out !== prev);
  return out;
}
