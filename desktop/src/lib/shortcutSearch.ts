// Finding a key in the shortcuts sheet by typing part of what it does.
//
// Each word typed has to turn up in the row's name, either whole ("tab"
// in "Close tab") or as letters in order ("nc" → "New chat"). A row matches
// on its name or on its group's name, whichever fits better; only a match on
// the name is highlighted, letter by letter. Loose matches — letters strewn
// across a long name — are dropped, and the rest come best-first.

import { SHORTCUT_GROUPS, type ShortcutGroup } from "./shortcuts";

export type TextMatch = { score: number; indices: number[] };

/** Matches scoring below this are too loose to show. */
export const SHORTCUT_MATCH_THRESHOLD = 0.5;

function isWordStart(text: string, i: number) {
  return i === 0 || !/[a-z0-9]/i.test(text[i - 1]);
}

function matchWord(word: string, text: string): TextMatch | null {
  const at = text.indexOf(word);
  if (at >= 0) {
    let best = at;
    for (let i = at; i >= 0; i = text.indexOf(word, i + 1)) {
      if (isWordStart(text, i)) {
        best = i;
        break;
      }
    }
    return {
      score: isWordStart(text, best) ? 1 : 0.9,
      indices: Array.from({ length: word.length }, (_, k) => best + k),
    };
  }
  const indices: number[] = [];
  let from = 0;
  for (const ch of word) {
    const i = text.indexOf(ch, from);
    if (i < 0) return null;
    indices.push(i);
    from = i + 1;
  }
  const span = indices[indices.length - 1] - indices[0] + 1;
  const allWordStarts = indices.every((i) => isWordStart(text, i));
  return { score: Math.max(word.length / span, allWordStarts ? 0.8 : 0), indices };
}

/** How well `query` fits `text`, and which letters of `text` it used. */
export function fuzzyMatch(query: string, text: string): TextMatch | null {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const lower = text.toLowerCase();
  const used = new Set<number>();
  let score = 1;
  for (const word of words) {
    const m = matchWord(word, lower);
    if (!m) return null;
    m.indices.forEach((i) => used.add(i));
    score = Math.min(score, m.score);
  }
  return { score, indices: [...used].sort((a, b) => a - b) };
}

export type ShortcutRow = {
  id: string;
  title: string;
  category: string;
  keys: string;
};

/** Every shortcut as one row, in the order the groups list them. */
export function shortcutRows(groups: ShortcutGroup[] = SHORTCUT_GROUPS): ShortcutRow[] {
  return groups.flatMap((g) =>
    g.items.map((item) => ({ id: `${g.title}\u0000${item.label}`, title: item.label, category: g.title, keys: item.keys })),
  );
}

export type ShortcutHit = {
  row: ShortcutRow;
  /** Letters of the title that matched; absent when the group's name did. */
  titleMatch?: number[];
};

/** The rows that fit `query`, best first (ties: own-name matches first,
 *  then the sheet's order). */
export function searchShortcuts(rows: ShortcutRow[], query: string): ShortcutHit[] {
  const hits: { hit: ShortcutHit; score: number; index: number }[] = [];
  rows.forEach((row, index) => {
    const title = fuzzyMatch(query, row.title);
    const category = fuzzyMatch(query, row.category);
    const t = title && title.score >= SHORTCUT_MATCH_THRESHOLD ? title : null;
    const c = category && category.score >= SHORTCUT_MATCH_THRESHOLD ? category : null;
    if (!t && !c) return;
    if (t && (!c || t.score >= c.score)) hits.push({ hit: { row, titleMatch: t.indices }, score: t.score, index });
    else hits.push({ hit: { row }, score: c!.score, index });
  });
  // At an equal fit, a row whose own name matched comes before one found
  // through its group's name.
  const named = (h: ShortcutHit) => (h.titleMatch ? 0 : 1);
  return hits
    .sort((a, b) => b.score - a.score || named(a.hit) - named(b.hit) || a.index - b.index)
    .map((h) => h.hit);
}
