// @-mention primitives. Lightweight parser + lookup the rest of the UI
// uses to render mention chips and drive autocomplete popovers.
//
// Mention syntax: `@handle` where handle is `[a-zA-Z0-9._-]+`. The
// resolver maps a handle to a TeamMember if one matches; renderers
// show the chip in a "known" or "unknown" style accordingly.

import type { TeamMember } from "./api";

export type MentionToken =
  | { kind: "text"; text: string }
  | { kind: "mention"; handle: string; raw: string };

// Conservative — avoids matching email addresses (no `@` after a word
// character), bare punctuation, or URLs. The lookbehind keeps trailing
// punctuation outside the mention so "Ping @alice." still tags @alice.
const MENTION_RE = /(^|[\s(\[{>])@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;

export function parseMentions(text: string): MentionToken[] {
  if (!text) return [];
  const out: MentionToken[] = [];
  let lastEnd = 0;
  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const [full, prefix, handle] = match;
    const start = match.index + prefix.length;
    if (start > lastEnd) {
      out.push({ kind: "text", text: text.slice(lastEnd, start) });
    }
    out.push({ kind: "mention", handle, raw: full.slice(prefix.length) });
    lastEnd = match.index + full.length;
  }
  if (lastEnd < text.length) {
    out.push({ kind: "text", text: text.slice(lastEnd) });
  }
  return out;
}

/** Extract just the set of handles mentioned in a body of text. */
export function extractHandles(text: string): string[] {
  const set = new Set<string>();
  for (const tok of parseMentions(text)) {
    if (tok.kind === "mention") set.add(tok.handle);
  }
  return Array.from(set);
}

/** Returns the in-progress mention (`@partial`) at the caret, or null.
 *  Used by inputs to drive the autocomplete popover — when null, the
 *  popover should hide. */
export function activeMention(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  if (caret <= 0) return null;
  // Walk backwards from the caret to find the most recent `@`. Abort
  // if we hit whitespace before an `@` (i.e. the user isn't currently
  // typing a mention).
  let i = caret - 1;
  while (i >= 0) {
    const c = text[i];
    if (c === "@") {
      const before = i === 0 ? " " : text[i - 1];
      // Mention must follow whitespace or a delimiter so `foo@bar`
      // (email) doesn't trigger.
      if (!/\s|[([{>]/.test(before) && i !== 0) return null;
      const query = text.slice(i + 1, caret);
      if (!/^[a-zA-Z0-9._-]*$/.test(query)) return null;
      return { query, start: i };
    }
    if (/\s/.test(c)) return null;
    if (c === "@") break;
    i -= 1;
  }
  return null;
}

/** Fuzzy filter team members by handle / name / email. Case-insensitive.
 *  Empty query returns the full list (capped at `limit`). */
export function filterMembers(
  members: TeamMember[],
  query: string,
  limit = 8,
): TeamMember[] {
  const q = query.trim().toLowerCase();
  if (!q) return members.slice(0, limit);
  const scored = members
    .map((m) => ({ m, score: scoreMember(m, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
  return scored;
}

function scoreMember(m: TeamMember, q: string): number {
  const h = (m.handle || "").toLowerCase();
  const n = (m.name || "").toLowerCase();
  const e = (m.email || "").toLowerCase();
  if (h === q) return 1000;
  if (h.startsWith(q)) return 600;
  if (n.startsWith(q)) return 500;
  if (h.includes(q)) return 300;
  if (n.includes(q)) return 200;
  if (e.includes(q)) return 100;
  return 0;
}

/** Build a `Map<handle, TeamMember>` for O(1) lookup by renderers. */
export function membersByHandle(members: TeamMember[]): Map<string, TeamMember> {
  const m = new Map<string, TeamMember>();
  for (const x of members) {
    if (x.handle) m.set(x.handle, x);
  }
  return m;
}
