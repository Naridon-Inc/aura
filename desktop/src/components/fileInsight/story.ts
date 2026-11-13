// story — what the "What changed" block over the editor's diff says, composed
// from the facts the insight hook gathers. Pure, so the wording is tested
// without a window.
//
// The order of trust is the same everywhere: a reason the author stated beats
// a model's reading, a model's reading beats a line mined from the diff, and a
// mined line that only restates variable names is never the headline — the
// reader of this block is not assumed to read code.

import type { ChangedSymbol } from "../../lib/api";
import type { ChangeExplanation, SymbolMeanings } from "../../lib/changeExplain";
import { whyIsRecorded } from "../../lib/changeExplain";
import type { ChangeMark, DataChangeRow } from "../../lib/dataDiff";
import { secondsToMs, type InsightNote } from "../../lib/insightNotes";
import { changeMark, plainKind, titleize } from "../workpanes/changeNote/changeWords";

/** One row of the block: the mark, the human line first, and the name or key
 *  it came from (drawn dim, beside it). */
export type StoryRow = {
  id: string;
  mark: ChangeMark;
  text: string;
  /** For a reworked piece: what it used to do, when that is known. */
  was?: string;
  key: string;
  /** The words for this row are still being written. */
  pending: boolean;
  /** Set for a code piece, so the row carries the symbol actions. */
  symbol?: { identifier: string; kind: string; line: number | null };
};

/** Code pieces, worded by what each does now (or did, for one that is gone).
 *  Until the model's line lands, a plain placeholder names the piece in words. */
export function codeRows(pieces: ChangedSymbol[], meanings: SymbolMeanings): StoryRow[] {
  return pieces.map((p, i) => {
    const kind = p.kind === "section" ? "section" : plainKind(p.kind).one;
    const name = titleize(p.identifier);
    const now = usable(meanings.now.get(p.identifier));
    const before = usable(meanings.before.get(p.identifier));
    const mark = changeMark(p.change) as ChangeMark;
    const base = {
      id: `${p.change}:${p.identifier}:${i}`,
      mark,
      key: p.identifier,
      symbol: { identifier: p.identifier, kind: p.kind, line: p.start_line ?? null },
    };
    if (p.change === "added") {
      return { ...base, text: now ?? `New ${kind}: ${name}`, pending: !now };
    }
    if (p.change === "deleted") {
      return { ...base, text: before ? `Removed: ${before}` : `Removed ${kind}: ${name}`, pending: !before };
    }
    return {
      ...base,
      text: now ?? `Reworked ${kind}: ${name}`,
      was: before,
      pending: !now || !before,
    };
  });
}

export function dataStoryRows(rows: DataChangeRow[]): StoryRow[] {
  return rows.map((r, i) => ({ id: `${r.key}:${i}`, mark: r.mark, text: r.text, key: r.key, pending: false }));
}

/** "2 added · 1 removed · 3 changed", in that order, leaving out empty counts. */
export function storyTally(rows: StoryRow[]): string {
  const n = (m: ChangeMark) => rows.filter((r) => r.mark === m).length;
  return [
    n("+") ? `${n("+")} added` : "",
    n("−") ? `${n("−")} removed` : "",
    n("~") ? `${n("~")} changed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The one generic line the backend falls back to when it can name nothing. */
const GENERIC_WHAT = "Updates how this part of the project works.";

/** A line mined from the diff rather than written as a reading: the generic
 *  fallback, or the miner's "Now … / Previously …" sentence that quotes the
 *  code's own names in single quotes ("Now sets 'from' from 'senderFor'.").
 *  The backend marks a whole account `fallback` when every angle was mined,
 *  but a `mixed` one does not say which angle was, so the shape decides. */
export function isMinedLine(s: string): boolean {
  const t = s.trim();
  return !t || t === GENERIC_WHAT || /^(Now|Previously)\b.*'[^']+'/.test(t) || isToolError(t);
}

/** Is this the agent CLI or a hook in its settings reporting a failure, rather
 *  than an answer? An older backend cached "UserPromptSubmit operation blocked
 *  by hook:" as a file's explanation; it must never reach the reader. Mirrors
 *  the backend's own check, so a stale cache line is caught here too. */
export function isToolError(s: string): boolean {
  const t = s.trim().replace(/^[-*•]\s*/, "").toLowerCase();
  if (!t) return false;
  if (/blocked by (a )?hook|operation blocked by|hook blocked/.test(t)) return true;
  return /^(error:|error -|fatal:|warning:|usage:|api error|execution error|invalid api key|not logged in|credit balance is too low|prompt is too long|blocked:)/.test(
    t,
  ) || /please run \/login|panicked at|overloaded_error|authentication_error/.test(t);
}

function usable(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t && !isToolError(t) ? t : undefined;
}

/** Used to → Now, from the model's reading only. `null` when there is no real
 *  "now" line to lead with — the rows then speak for themselves. */
export function headline(e: ChangeExplanation | null): { before: string; now: string } | null {
  if (!e || e.source === "fallback" || e.source === "none" || e.source === "error") return null;
  const now = isMinedLine(e.what) ? "" : e.what.trim();
  if (!now) return null;
  const before = isMinedLine(e.before) ? "" : e.before.trim();
  return { before, now };
}

/** One reason in the "Why" line. */
export type WhyNote = {
  id: string;
  who: string;
  text: string;
  whenMs: number | null;
  /** How the reason came to be here, said plainly. */
  provenance: "stated" | "noted" | "session" | "reading";
};

/** The reasons to show, best first: the author's own recorded reason for this
 *  file, then the notes bound to it, then the session's latest stated reason,
 *  then — only when nothing was written down — Aura's reading of the change. */
export function whyNotes(
  e: ChangeExplanation | null,
  notes: InsightNote[],
  session: InsightNote | null,
): WhyNote[] {
  const out: WhyNote[] = [];
  if (e && whyIsRecorded(e)) {
    out.push({
      id: "recorded",
      who: e.why_author?.trim() || "The author",
      text: e.why.trim(),
      whenMs: secondsToMs(e.why_stated_at),
      provenance: "stated",
    });
  }
  const seen = new Set(out.map((n) => n.text));
  for (const n of notes) {
    if (seen.has(n.text)) continue;
    seen.add(n.text);
    out.push({ id: n.id, who: n.who, text: n.text, whenMs: n.whenMs, provenance: "noted" });
  }
  if (!out.length && session && !session.auto) {
    out.push({ ...session, provenance: "session" });
  }
  if (!out.length && e && (e.why_source === "model" || e.why_source === "cache") && usable(e.why)) {
    out.push({ id: "reading", who: "Aura's reading", text: e.why.trim(), whenMs: null, provenance: "reading" });
  }
  return out;
}
