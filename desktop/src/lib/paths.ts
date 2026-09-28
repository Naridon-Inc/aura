// The ways of naming a path in the interface, in one place.
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

/** A path with its `.` and `..` segments walked and repeated slashes folded:
 *  "/code/app/../../.claude/x.ts" → "/.claude/x.ts".
 *
 *  An agent CLI prints the files it touches relative to where it runs, so a
 *  file outside the repo arrives as "../../../.claude/jobs/…/closure.ts", and
 *  joining that to the repo root leaves the dots in. The editor keys each
 *  file's Monaco model on its path, and the TypeScript worker resolves the
 *  dots away before it looks the file up — so it asked for a file no model was
 *  registered under, and every hover in that tab threw "Could not find source
 *  file". One spelling per file also keeps the same file from opening twice.
 *
 *  A path with nothing to walk comes back as the very same string, and URIs
 *  and backslash paths are left alone. */
export function normalizePath(p: string): string {
  if (!p || p.includes("://")) return p;
  if (!/(?:^|\/)\.{1,2}(?:\/|$)|\/\//.test(p)) return p;
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") out.push(seg);
    else if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
    // Above the root there is nowhere to go; a relative path keeps the climb.
    else if (!absolute) out.push("..");
  }
  const body = out.join("/");
  if (absolute) return `/${body}`;
  return body || ".";
}
