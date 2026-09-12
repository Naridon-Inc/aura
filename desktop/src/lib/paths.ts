// Two ways of naming a path in the interface, in one place.
//
// "Take the last segment" had been written eleven times under four names
// (basename, basenameOf, shortName, shortRepoName), and six of those copies
// were the one-liner lastIndexOf("/") — which returns an empty string for a
// path that ends in a slash, so a repo root arriving with its trailing
// separator rendered as a blank label. Two authors had independently patched
// their own copy for exactly that. The other six never found out.
//
// The version here is the careful one: both separators, trailing separators
// trimmed, and the original returned rather than "" when there is nothing
// left to take.

// basename moved to aura-shared/paths so the shared IntentProse can resolve
// file tokens with the same care; this stays its local address.
export { basename } from "@shared/paths";

/** A path cut down to its last few segments and marked as cut —
 *  "/Users/mo/code/aura" → "…/code/aura". Returned untouched when it is
 *  already that short, so the leader never lies about what was removed. */
export function shortPath(p: string, segments = 2): string {
  const parts = (p ?? "").split(/[/\\]+/).filter(Boolean);
  if (parts.length <= segments) return p;
  return `…/${parts.slice(-segments).join("/")}`;
}
