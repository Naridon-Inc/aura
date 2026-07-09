// humanizeFinding — turn the engine's raw invariant strings into plain words.
//
// The semantic engine (pr.rs) emits four invariant shapes verbatim:
//   "Forbidden Call: …", "Layer Violation: …",
//   "Protected Node Modified: …", "Protected Node Deleted: …"
// Printed raw, these read like compiler internals to a vibecoder. We swap
// only the recognized *prefix* for a plain lead and keep the detail (the
// symbol / file after it) verbatim, so no information is lost. "Piece of
// code" matches the Time machine's vocabulary, so the same concept reads the
// same everywhere. Cross-branch and unknown findings pass through untouched.
//
// Shared by the Safety check pane (ReviewDialog) and the PR right-rail review
// card (PrRightRail) so both surfaces speak the same plain language.

const RULES: [RegExp, string][] = [
  [/^Protected Node Deleted\s*:?\s*/i, "A protected piece of code was deleted — "],
  [/^Protected Node Modified\s*:?\s*/i, "A protected piece of code was changed — "],
  [/^Forbidden Call\s*:?\s*/i, "A call that isn't allowed here — "],
  [/^Forbidden\s*:?\s*/i, "Not allowed here — "],
  [/^Layer Violation\s*:?\s*/i, "This crosses an architectural boundary — "],
];

export function humanizeFindingText(text: string): string {
  for (const [re, lead] of RULES) {
    if (re.test(text)) return text.replace(re, lead);
  }
  return text;
}
