// Grouping for the ⌘K palette.
//
// The palette mixes seven very different result kinds — actions, slash
// commands, extension commands, files, code definitions (symbols), in-code
// text matches, and agents. The old surface poured all of them into one flat
// list with a cryptic three-letter badge per row. This module turns the flat,
// already-ranked hit list into ordered, plain-language sections so each kind
// reads as its own thing — and returns the matching flattened order so arrow
// keys still walk every row top-to-bottom.

import type { PaletteEntry } from "../CommandPalette";

export type PaletteCategory = PaletteEntry["kind"];

// Stable display order. Things you DO (actions/commands) lead; then the
// code-search lanes. Within those, Definitions (actual code symbols) come
// BEFORE Files: when you type an identifier the function/type you named is the
// highest-intent hit, and a repo can have dozens of matching filenames that
// would otherwise bury it below the fold. Then in-code text matches, history,
// agents. The query ranking already decides which rows survive — this only
// fixes the grouping.
const CATEGORY_ORDER: PaletteCategory[] = [
  "action",
  "slash",
  "extCommand",
  "symbol",
  "file",
  "match",
  "intent",
  "agent",
];

// Plain-language section labels (non-engineer audience). No "symbols",
// "grep", or "AST" on the surface.
const CATEGORY_LABEL: Record<PaletteCategory, string> = {
  action: "Actions",
  slash: "Commands",
  extCommand: "Extension commands",
  file: "Files",
  symbol: "Definitions",
  match: "In your code",
  intent: "Reasons & history",
  agent: "Agents",
};

export type PaletteSection = {
  key: PaletteCategory;
  label: string;
  items: PaletteEntry[];
};

/** Group an already-ranked flat hit list into ordered sections, and return the
 *  flattened row order (sections concatenated) so keyboard navigation and the
 *  Enter handler index into the same sequence the user sees. */
export function groupHits(hits: PaletteEntry[]): {
  sections: PaletteSection[];
  flat: PaletteEntry[];
} {
  const byCat = new Map<PaletteCategory, PaletteEntry[]>();
  for (const h of hits) {
    const bucket = byCat.get(h.kind);
    if (bucket) bucket.push(h);
    else byCat.set(h.kind, [h]);
  }
  const sections: PaletteSection[] = [];
  for (const cat of CATEGORY_ORDER) {
    const items = byCat.get(cat);
    if (items && items.length > 0) {
      sections.push({ key: cat, label: CATEGORY_LABEL[cat], items });
    }
  }
  const flat = sections.flatMap((s) => s.items);
  return { sections, flat };
}
