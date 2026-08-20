/** Team (chat) bounded context — the Taskbar list model.
 *
 *  A dead-simple shared to-do the team keeps in a markdown checklist:
 *  each line is a GFM task item whose visible body carries an `@handle`
 *  mention, with the author + timestamps tucked into a trailing HTML
 *  comment so the raw file stays a clean, hand-editable markdown list:
 *
 *    # Taskbar
 *
 *    - [ ] Ship the public API @mhask <!--aura:taskbar a=mhask t=1721808000000-->
 *    - [x] Fix the DMG installer @unaiz <!--aura:taskbar a=unaiz t=1721635200000 d=1721815200000-->
 *
 *  Open items simply persist day after day — that IS the "rolls over to
 *  the next day" behaviour; `createdAt` is never mutated so the age chip
 *  keeps counting up and a stale item is visible at a glance. Pure data +
 *  transforms — no React, no I/O. */

export type TaskItem = {
  /** Stable id for React keys + in-place updates (not persisted). */
  id: string;
  /** Item body, including any `@handle` mention(s). */
  text: string;
  /** Handle that added the item ("" when hand-added without metadata). */
  author: string;
  /** Epoch ms the item was added — drives the age chip + rollover. */
  createdAt: number;
  done: boolean;
  /** Epoch ms the item was checked off, or null while open. */
  doneAt: number | null;
};

// `- [ ] body <!--aura:taskbar a=.. t=.. d=..-->` — the trailing comment is
// optional so a hand-typed `- [ ] foo` still parses.
const LINE_RE =
  /^\s*[-*]\s*\[([ xX])\]\s+(.*?)\s*(?:<!--\s*aura:taskbar\s+(.*?)\s*-->)?\s*$/;

function parseMeta(meta: string): { a: string; t: number | null; d: number | null } {
  const out = { a: "", t: null as number | null, d: null as number | null };
  for (const m of meta.matchAll(/(\w+)=(\S+)/g)) {
    const k = m[1];
    const v = m[2];
    if (k === "a") out.a = v === "-" ? "" : v;
    else if (k === "t") {
      const n = Number(v);
      if (Number.isFinite(n)) out.t = n;
    } else if (k === "d") {
      const n = Number(v);
      if (Number.isFinite(n)) out.d = n;
    }
  }
  return out;
}

/** Parse the markdown doc into items. Lines that aren't task items (the
 *  `# Taskbar` heading, blanks, prose) are ignored. Items missing a stored
 *  timestamp inherit `fallbackTs` (capture it once per load so ages don't
 *  jitter between renders). */
export function parseTaskbar(md: string, fallbackTs: number): TaskItem[] {
  const items: TaskItem[] = [];
  let seq = 0;
  for (const raw of md.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const done = m[1].toLowerCase() === "x";
    const text = m[2].trim();
    if (!text) continue;
    const meta = m[3] ? parseMeta(m[3]) : { a: "", t: null, d: null };
    const createdAt = meta.t ?? fallbackTs;
    items.push({
      id: `it-${seq++}-${createdAt}`,
      text,
      author: meta.a,
      createdAt,
      done,
      doneAt: done ? meta.d ?? fallbackTs : null,
    });
  }
  return items;
}

/** Serialize items back to the markdown checklist. */
export function serializeTaskbar(items: TaskItem[]): string {
  const lines = items.map((it) => {
    const box = it.done ? "x" : " ";
    const parts: string[] = [];
    if (it.author) parts.push(`a=${it.author}`);
    parts.push(`t=${it.createdAt}`);
    if (it.done && it.doneAt) parts.push(`d=${it.doneAt}`);
    return `- [${box}] ${it.text} <!--aura:taskbar ${parts.join(" ")}-->`;
  });
  return `# Taskbar\n\n${lines.join("\n")}\n`;
}

/** Local-calendar day bucket, e.g. "2026-6-24". */
export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Whole local-calendar days between the item's origin day and today. */
export function daysCarried(tsMs: number, nowMs: number): number {
  const a = new Date(tsMs);
  const b = new Date(nowMs);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((db - da) / 86_400_000));
}

/** An open item first added on an earlier day — it "rolled over" to today. */
export function isCarriedOver(item: TaskItem, nowMs: number): boolean {
  return !item.done && dayKey(item.createdAt) !== dayKey(nowMs);
}
