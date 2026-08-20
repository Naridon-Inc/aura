// Aura's gate, as a pi extension.
//
// pi executes its own tools — there is no `fs/write_text_file` for a host
// to serve — so the only place Aura can stand between the agent and the
// disk is `tool_call`, which fires after `tool_execution_start` and before
// the tool runs, and which can block.
//
// This file is deliberately thin. It decides nothing: it forwards the tool
// and its arguments to Aura and does what Aura says. Every rule — what
// counts as a write, whether the path is inside the session root, whether
// the snapshot succeeded, whether the human already said "always" — lives
// in Rust where it is testable. Keeping the policy out of here also means
// a user reading this file can see exactly what it can and cannot do.
//
// The channel is pi's extension-UI protocol. `ctx.ui.input()` emits an
// `extension_ui_request` on stdout and blocks until the client answers on
// stdin, which is precisely the shape a permission prompt needs. It is
// `input` rather than `confirm` because a refusal has to carry a reason:
// "Aura could not snapshot this file, so the edit cannot be rewound" is
// something the model can act on, and `true`/`false` is not.
//
// Written to disk by `manager::brain::pi::brain` at spawn and passed with
// `-e`, so it always matches the Rust half that answers it.

const GATE_TITLE = "aura.gate";
const ALLOW = "allow";

const NO_ANSWER =
  "Aura's gate did not answer, so this tool was not run. Nothing was changed.";

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    let verdict: string | undefined;
    try {
      verdict = await ctx.ui.input(
        GATE_TITLE,
        JSON.stringify({ tool: event.toolName, input: event.input ?? {} }),
      );
    } catch (err) {
      // The gate is unreachable. Blocking is the safe direction: an
      // ungated write is the exact thing this extension exists to stop.
      return {
        block: true,
        reason: `${NO_ANSWER} (${err instanceof Error ? err.message : String(err)})`,
      };
    }

    if (verdict === ALLOW) return;
    // A cancelled dialog resolves to undefined. Treat it as a refusal
    // rather than an approval, and say so in the agent's own transcript.
    return { block: true, reason: verdict ?? NO_ANSWER };
  });
}
