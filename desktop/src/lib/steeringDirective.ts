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

/** Remove leading internal steering/pipe directives from a user turn for
 *  display. Applied to chat bubbles and to session titles/objectives. Runs
 *  each pattern repeatedly so a stacked pipe + mode prefix both come off. */
export function stripSteeringDirective(text: string): string {
  let out = text;
  let prev: string;
  do {
    prev = out;
    out = out.replace(MODE_DIRECTIVE_RE, "").replace(PIPE_MARKER_RE, "");
  } while (out !== prev);
  return out;
}
