// Ranking for the palette's search lanes: files, commands, reasons and code.
// A label match outranks a path-only match, and a shallower file breaks a
// tie between several `index.ts`. Typed prefixes (`>`, `/`, `:`, `?`) narrow
// the list to one lane; with no prefix each lane keeps a few of its best.

import { secondsToMs } from "../../lib/insightNotes";
import { relativeAge } from "../../lib/relativeTime";
import type { PaletteEntry } from "../CommandPalette";
import type { PaletteIntentRow, PaletteLaneScope } from "./usePaletteLanes";

const FILE_RESULT_LIMIT = 40;

// Trim the agent id to a readable label for the reason row hint.
function shortAgent(id: string): string {
  if (!id) return "";
  const s = id.replace(/^cli:/, "");
  return s.length > 18 ? `${s.slice(0, 18)}…` : s;
}

/** Logged reasons whose text mentions the query, newest log order kept. */
export function intentEntries(rows: readonly PaletteIntentRow[], q: string, limit = 6): PaletteEntry[] {
  if (!q) return [];
  return rows
    .filter((r) => r.intent.toLowerCase().includes(q))
    .slice(0, limit)
    .map<PaletteEntry>((r) => ({
      kind: "intent",
      id: r.id,
      label: r.intent,
      hint: [
        shortAgent(r.agent),
        // The reason log stamps seconds; the age ladder reads milliseconds.
        relativeAge(secondsToMs(r.timestamp) ?? 0),
        r.fileCount ? `${r.fileCount} file${r.fileCount > 1 ? "s" : ""}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      timestamp: r.timestamp,
      path: r.path,
      line: r.path ? 1 : undefined,
    }));
}

/** The entries whose label or detail holds the query, best first. */
export function scoreEntries(pool: readonly PaletteEntry[], q: string): PaletteEntry[] {
  const scored: Array<{ e: PaletteEntry; score: number }> = [];
  for (const e of pool) {
    const lbl = e.label.toLowerCase();
    const hint = e.hint?.toLowerCase() ?? "";
    let score = 0;
    if (lbl === q) score = 1000;
    else if (lbl.startsWith(q)) score = 600;
    else if (lbl.includes(q)) score = 400;
    else if (hint.includes(q)) score = 200;
    else continue;
    if (e.kind === "file" && hint) score -= hint.split("/").length;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.e);
}

/** One prefixed lane: `>` Aura's own verbs, `/` commands, `:` files, `?` code. */
export function laneHits({
  lane,
  q,
  pool,
  symbolHits,
  grepHits,
}: {
  lane: Exclude<PaletteLaneScope, "all" | "agent">;
  q: string;
  pool: readonly PaletteEntry[];
  symbolHits: readonly PaletteEntry[];
  grepHits: readonly PaletteEntry[];
}): PaletteEntry[] {
  if (lane === "code") {
    const code = [...symbolHits, ...grepHits];
    if (!q) return code.slice(0, 200);
    return code.filter((e) => e.label.toLowerCase().includes(q) || e.hint?.toLowerCase().includes(q));
  }
  const kept = pool.filter((e) =>
    lane === "aura"
      ? (e.kind === "action" && (e.id.startsWith("aura_") || /^(Engine|Aura):/.test(e.label))) ||
        (e.kind === "slash" && /^aura_/.test(e.id))
      : lane === "slash"
        ? e.kind === "slash"
        : e.kind === "file",
  );
  const limit = lane === "file" ? FILE_RESULT_LIMIT : 200;
  if (!q) return kept.slice(0, lane === "file" ? FILE_RESULT_LIMIT : kept.length);
  return scoreEntries(kept, q).slice(0, limit);
}

export type AllLaneHits = {
  chats: PaletteEntry[];
  symbols: PaletteEntry[];
  files: PaletteEntry[];
  matches: PaletteEntry[];
  intents: PaletteEntry[];
  commands: PaletteEntry[];
};

export const NO_LANE_HITS: AllLaneHits = { chats: [], symbols: [], files: [], matches: [], intents: [], commands: [] };

/** With no prefix, each lane's best few for a query; nothing before one. */
export function allLaneHits({
  q,
  files,
  commands,
  symbolHits,
  grepHits,
  intentRows,
  chatHits,
}: {
  q: string;
  files: readonly PaletteEntry[];
  commands: readonly PaletteEntry[];
  symbolHits: readonly PaletteEntry[];
  grepHits: readonly PaletteEntry[];
  intentRows: readonly PaletteIntentRow[];
  chatHits: readonly PaletteEntry[];
}): AllLaneHits {
  if (!q) return NO_LANE_HITS;
  return {
    chats: [...chatHits],
    symbols: symbolHits.slice(0, 8),
    files: scoreEntries(files, q).slice(0, 12),
    matches: grepHits.slice(0, 30),
    intents: intentEntries(intentRows, q),
    commands: scoreEntries(commands, q).slice(0, 8),
  };
}
