// The sentences a session's story is told in, kept apart from the page so the
// wording can be checked without a window. Each one says only what the record
// holds: the person's own first message is "what was asked", the words logged
// with the change are "what the agent said", and where the record has neither
// the chapter says so rather than borrowing one for the other.

import type { ChangedSymbol, IntentChangesetFile } from "../../../lib/api";
import { provenanceNote, type IntentProvenance } from "../../../lib/sessionMeta";
import { plainSummary } from "../../workpanes/changeNote/changeWords";
import { splitIntent } from "../../workpanes/IntentProse";
import { formatCount } from "./storyFormat";

/** Long text cut where a word ends, so a chapter stays a few lines; the whole
 *  of it is one link away. */
export function clipText(text: string, max = 600): { text: string; clipped: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, clipped: false };
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  const kept = at > max * 0.6 ? cut.slice(0, at) : cut;
  return { text: `${kept.trimEnd()}…`, clipped: true };
}

/** What the person asked for: their own first message when the session is
 *  known, or the record's words when those were taken from it. */
export function whatWasAsked(
  firstPrompt: string | null | undefined,
  provenance: IntentProvenance,
  statement: string,
): string | null {
  const prompt = (firstPrompt ?? "").trim();
  if (prompt) return prompt;
  if (provenance === "asked") return statement.trim() || null;
  return null;
}

/** What the record says was done, in its own words, and where those words came
 *  from. Nothing when they are the ask again or a bare list of commands; and
 *  the first line is left out when it is already the page's title. */
export function whatItSaid(
  provenance: IntentProvenance,
  statement: string,
  asked: string | null,
  title?: string,
): { text: string; source: string } | null {
  let said = statement.trim();
  if (!said || provenance === "asked" || provenance === "uncaptured") return null;
  if (asked && said === asked.trim()) return null;
  const split = splitIntent(said);
  if (title && split.headline === title.trim()) said = split.body;
  if (!said) return null;
  return {
    text: said,
    source: provenanceNote(provenance) || "The reason given when the change was logged.",
  };
}

/** How much work it was: the agent's steps, the person's messages when they
 *  steered more than once, and any workers it handed parts to. */
export function workSentence(steps: number, messages: number, workers: number): string | null {
  let s: string | null = null;
  const stepWord = steps === 1 ? "1 step" : `${formatCount(steps)} steps`;
  if (steps > 0 && messages > 1) s = `The agent took ${stepWord} over ${formatCount(messages)} of your messages.`;
  else if (steps > 0) s = `The agent took ${stepWord}.`;
  else if (messages > 1) s = `You sent ${formatCount(messages)} messages.`;
  if (workers > 0) {
    const handed = `It handed parts of the work to ${workers === 1 ? "1 worker" : `${formatCount(workers)} workers`}.`;
    s = s ? `${s} ${handed}` : handed;
  }
  return s;
}

/** One file's change as a sentence, from the pieces of code it changed, and
 *  where the file lives. */
export function fileStory(
  file: IntentChangesetFile,
  symbols: ChangedSymbol[],
): { title: string; where: string } {
  const slash = file.path.lastIndexOf("/");
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const folder = slash >= 0 ? file.path.slice(0, slash) : "";
  if (symbols.length > 0) return { title: plainSummary(symbols, ""), where: file.path };
  return { title: `Edited ${name}`, where: folder || "the repository's top folder" };
}

/** How many files a story lists before the rest are one link away. */
export const FILES_SHOWN = 8;
