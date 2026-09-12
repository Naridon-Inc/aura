// What `/prototype` says to the agent.
//
// One word for "show me, don't ship it": build a quick throwaway version in a
// scratch folder, keep the real code untouched, and come back with what was
// learned. The prompt is a function of the topic so `/prototype a dark mode
// toggle` reads as a sentence, and a bare `/prototype` still asks for the
// thing the chat is already about.

export const PROTOTYPE_SCRATCH_DIR = ".aura/scratch/prototypes";

export function buildPrototypePrompt(topic: string): string {
  const what = topic.trim();
  const subject = what ? `Build a quick throwaway prototype of: ${what}.` : "Build a quick throwaway prototype of what we are discussing.";
  return [
    subject,
    "",
    "Rules for this prototype:",
    `- Work only inside \`${PROTOTYPE_SCRATCH_DIR}/<short-name>/\` at the repo root. Do not edit, move or delete any existing project file.`,
    "- Favour speed over polish: hard-code inputs, skip tests and error handling, use whatever is quickest to run.",
    "- Stop as soon as the idea can be seen working (or clearly can't).",
    "",
    "When you are done, report back in plain language:",
    "1. What you built and how to run it (one command).",
    "2. What worked, what didn't, and anything surprising.",
    "3. Whether it is worth building for real, and what the real version would need that this one skipped.",
  ].join("\n");
}
