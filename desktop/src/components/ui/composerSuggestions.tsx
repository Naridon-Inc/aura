// The rows of the composer's `/` and `@` lists, and which rows a typed token
// keeps. A row is one line: commands read "/ name  description", mentions
// read "icon name  where". Once something is typed, the letters of the name
// that matched stay full strength and the rest dim, so the eye lands on why
// the row is there. Snippets (after ";") read "bookmark name ;keyword body".
import type { ReactNode } from "react";
import { Bookmark } from "lucide-react";

export interface ComposerSuggestion {
  id: string;
  label: string;
  detail?: string;
  insertText: string;
  kind: "mention" | "command" | "snippet";
  /** A snippet's keyword, typed after ";" to find it or insert it outright. */
  keyword?: string | null;
  /** The words drawn in the row and marked against what was typed. Defaults
   *  to the label, without its leading "/" for a command. */
  name?: string;
  /** A 12px mark before a mention's name: the file's icon, the terminal. */
  icon?: ReactNode;
}

/** How many rows the list draws; it scrolls past what fits (308px). */
const LIMIT = 100;

export function suggestionName(item: ComposerSuggestion): string {
  if (item.name) return item.name;
  return item.kind === "command" ? item.label.replace(/^\//, "") : item.label;
}

export type SuggestionSigil = "@" | "/" | ";";

/** The snippets a ";" token keeps: those whose keyword starts with what was
 *  typed, then those whose name holds its letters in order (a run of them
 *  before scattered ones, a name typed exactly first). Nothing once the
 *  token starts with a space. */
export function matchSnippets(
  suggestions: ComposerSuggestion[],
  query: string,
): ComposerSuggestion[] {
  if (/^\s/.test(query)) return [];
  const snippets = suggestions.filter((item) => item.kind === "snippet");
  const q = query.toLowerCase();
  const byKeyword = q
    ? snippets.filter((item) => item.keyword?.toLowerCase().startsWith(q))
    : [];
  const rest = snippets.filter((item) => !byKeyword.includes(item));
  if (!q.trim()) return [...byKeyword, ...rest].slice(0, LIMIT);
  const scored = rest
    .map((item) => {
      const name = suggestionName(item).toLowerCase();
      const hits = matchedLetters(name, q);
      if (!hits.length) return null;
      const score = name === q ? 0 : name.includes(q) ? 1 : 2;
      return { item, score };
    })
    .filter((entry): entry is { item: ComposerSuggestion; score: number } => entry !== null)
    .sort((a, b) => a.score - b.score);
  return [...byKeyword, ...scored.map((entry) => entry.item)].slice(0, LIMIT);
}

/** The snippet a keyword names outright: exactly one has it, and no longer
 *  keyword starts with it (so ";rev" waits while ";review" exists). */
export function snippetForKeyword(
  suggestions: ComposerSuggestion[],
  keyword: string,
): ComposerSuggestion | undefined {
  const k = keyword.toLowerCase();
  const snippets = suggestions.filter((item) => item.kind === "snippet" && item.keyword);
  const exact = snippets.filter((item) => item.keyword!.toLowerCase() === k);
  const longer = snippets.some(
    (item) => item.keyword!.length > k.length && item.keyword!.toLowerCase().startsWith(k),
  );
  return exact.length === 1 && !longer ? exact[0] : undefined;
}

/** The rows a token keeps: everything whose label or detail holds the typed
 *  text, with a row named exactly what was typed first. */
export function matchSuggestions(
  suggestions: ComposerSuggestion[],
  sigil: SuggestionSigil,
  query: string,
): ComposerSuggestion[] {
  if (sigil === ";") return matchSnippets(suggestions, query);
  const kind = sigil === "@" ? "mention" : "command";
  const q = query.toLowerCase();
  const kept = suggestions.filter(
    (item) => item.kind === kind && `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(q),
  );
  if (q) {
    const exact = kept.filter((item) => suggestionName(item).toLowerCase() === q);
    if (exact.length) return [...exact, ...kept.filter((item) => !exact.includes(item))].slice(0, LIMIT);
  }
  return kept.slice(0, LIMIT);
}

/** Which letters of `text` the query matched: the first run that holds it
 *  whole, else each letter in order. Empty when the query isn't in `text`. */
export function matchedLetters(text: string, query: string): number[] {
  if (!query) return [];
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i);
  const out: number[] = [];
  let from = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return [];
    out.push(i);
    from = i + 1;
  }
  return out;
}

/** The text with the unmatched letters dimmed; plain when nothing matched. */
export function Marked({ text, query }: { text: string; query: string }) {
  const hits = new Set(matchedLetters(text, query));
  if (!hits.size) return <>{text}</>;
  const runs: ReactNode[] = [];
  let run = "";
  let on = hits.has(0);
  for (let i = 0; i <= text.length; i++) {
    const hit = hits.has(i);
    if (i === text.length || hit !== on) {
      if (run)
        runs.push(
          on ? <span key={i}>{run}</span> : <span key={i} className="ui-suggestion-dim">{run}</span>,
        );
      run = "";
      on = hit;
    }
    if (i < text.length) run += text[i];
  }
  return <span>{runs}</span>;
}

/** One row's contents. The row element itself (its selection, its pick) is
 *  the composer's. */
export function SuggestionRow({ item, query }: { item: ComposerSuggestion; query: string }) {
  const name = suggestionName(item);
  if (item.kind === "snippet")
    return (
      <>
        <Bookmark className="ui-suggestion-snippet-mark" aria-hidden="true" />
        <span className="ui-suggestion-name">
          <Marked text={name} query={query} />
        </span>
        {item.keyword && <span className="ui-suggestion-keyword">;{item.keyword}</span>}
        {item.detail && <span className="ui-suggestion-detail">{item.detail}</span>}
      </>
    );
  // A path's name is its last part, so only what was typed after the last
  // "/" is marked in it.
  const typed = item.kind === "mention" ? query.slice(query.lastIndexOf("/") + 1) : query;
  if (item.kind === "command")
    return (
      <>
        <span className="ui-suggestion-sigil">/</span>
        <span className="ui-suggestion-name">
          <Marked text={name} query={typed} />
        </span>
        {item.detail && <span className="ui-suggestion-detail">{item.detail}</span>}
      </>
    );
  return (
    <>
      {item.icon && <span className="ui-suggestion-icon">{item.icon}</span>}
      <span className="ui-suggestion-name">
        <Marked text={name} query={typed} />
      </span>
      {item.detail && <span className="ui-suggestion-detail">{item.detail}</span>}
    </>
  );
}
