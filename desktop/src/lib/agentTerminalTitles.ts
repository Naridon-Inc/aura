// Live titles for agent workpane tabs, read off the terminal itself.
//
// A coding agent tells its terminal what it is doing. Claude Code emits
// `OSC 0 ; ✳ Claude Code` on startup and rewrites it as the session acquires a
// subject, and every other CLI worth running does the same — it is the one
// piece of "what is this session about" that the agent volunteers, continuously
// and for free, without us parsing a transcript to guess.
//
// Until now that stream went nowhere: xterm swallowed the sequence and the tab
// pill showed `agentLabel`, a constant chosen when the tab was created. So four
// Claude tabs read "Claude Code · Claude Code · Claude Code · Claude Code" and
// the only way to find the one you wanted was to click all four.
//
// Same shape as browserTabTitles.ts, and for the same reason: the value lives
// outside editorStore, changes on its own schedule, and the tab strip needs it
// without owning it. A useSyncExternalStore feed with an identity-stable
// snapshot so an unchanged title re-renders nothing.

import { useSyncExternalStore } from "react";

/** Longest title a pill can show before it ellipsises anyway. Cutting here
 *  keeps a runaway sequence out of the store rather than out of the layout. */
const TITLE_MAX = 72;

/** C0 controls and DEL. Written as escapes rather than literals so the byte a
 *  reviewer sees is the byte the regex means. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Status glyphs a CLI puts in front of its title. `✳` is Claude's. */
const LEADING_MARKER = /^[✳✻✽●○◆◇*·•]\s*/u;

/**
 * A terminal title in the words a tab can wear, or null if it isn't worth
 * wearing one.
 *
 * Null rather than "" throughout, because the three reasons to decline are
 * genuinely different from an empty string and the caller's fallback (the
 * agent's own label) is right for all of them.
 *
 * What gets dropped, and why:
 *
 *  - **Control bytes.** This is untrusted output from a process that renders
 *    arbitrary text — a title is one `\r` away from redrawing part of the tab
 *    strip if it were ever placed somewhere less forgiving than a text node.
 *    Stripping at the door is cheaper than trusting every consumer.
 *  - **A leading glyph.** Claude prefixes `✳`, others use `●` or `*`. It is
 *    branding on a surface that already carries the agent's brand mark, so it
 *    is two characters of noise in a space measured in characters.
 *  - **A bare path.** Plain shells set the title to the cwd. The pill's `sub`
 *    line already says which checkout this is, so a path here would replace the
 *    subject with a duplicate of the line underneath it.
 */
export function cleanTerminalTitle(raw: string): string | null {
  const collapsed = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  // Leading marker plus its space. Anchored and single-shot: a title that
  // genuinely opens with punctuation keeps it after the first is taken.
  const unmarked = collapsed.replace(LEADING_MARKER, "").trim();
  if (!unmarked) return null;
  if (unmarked.startsWith("/") || unmarked.startsWith("~/")) return null;
  return unmarked.length > TITLE_MAX
    ? `${unmarked.slice(0, TITLE_MAX - 1).trimEnd()}…`
    : unmarked;
}

const titles = new Map<string, string>();
let snapshot: Record<string, string> = {};
const subs = new Set<() => void>();

function rebuild(): void {
  const next: Record<string, string> = {};
  for (const [id, t] of titles) next[id] = t;
  snapshot = next;
}

function emit(): void {
  for (const fn of subs) fn();
}

/**
 * Record what the agent in this PTY says it is doing.
 *
 * Takes the raw title and cleans it here rather than at the call site, so the
 * one place that reads the wire cannot forget. A title that cleans to nothing
 * is ignored rather than stored as empty: the previous title is still the best
 * thing known about the session, and blanking the pill mid-run would make the
 * tab flicker to its label every time the agent set a marker-only title.
 */
export function noteAgentTerminalTitle(sessionId: string, raw: string): void {
  if (!sessionId) return;
  const title = cleanTerminalTitle(raw);
  if (!title || titles.get(sessionId) === title) return;
  titles.set(sessionId, title);
  rebuild();
  emit();
}

/** Forget a session's title when its tab closes or its PTY is replaced. */
export function clearAgentTerminalTitle(sessionId: string): void {
  if (!titles.delete(sessionId)) return;
  rebuild();
  emit();
}

/** Non-reactive read, for imperative callers. */
export function getAgentTerminalTitle(sessionId: string): string | undefined {
  return titles.get(sessionId);
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

function getSnapshot(): Record<string, string> {
  return snapshot;
}

/** Live map of PTY session id → what that agent last called itself.
 *  Identity-stable between changes. */
export function useAgentTerminalTitles(): Record<string, string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
