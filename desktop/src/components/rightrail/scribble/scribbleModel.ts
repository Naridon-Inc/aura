/** Scribble — domain model for the daily block board.
 *
 *  A Scribble is a running, day-bucketed board of blocks. Each block is a short
 *  unit of *freeform markdown* (bold / italic / @mention / inline gif image) —
 *  either a plain note or a task (checkbox). Every block records WHO wrote it
 *  and WHEN, and — once a task is checked — who completed it and when. Any block
 *  can be pinned (many pins allowed).
 *
 *  Persistence is a clean, hand-editable (and agent-editable) markdown list,
 *  with the structured metadata tucked into a trailing HTML comment so the raw
 *  Page stays readable and an agent appending a bare `- [ ] thing` line still
 *  parses (it just inherits default metadata):
 *
 *    - [ ] Ship the public API @mhask  <!--aura:scribble a=mhask t=1721808000000 pin=1-->
 *    - [x] Fix the DMG installer        <!--aura:scribble a=unaiz t=1721635200000 d=1721815200000 db=unaiz-->
 *    A quick note ![](https://x/y.gif)  <!--aura:scribble a=ashiq t=1721808000000-->
 *
 *  Open tasks persist day after day (they "carry" forward); `createdAt` is
 *  never mutated, so the age chip keeps counting and a carried task is obvious.
 *  Pure data + transforms — no React, no I/O. */

import { shortDate } from "../../../lib/calendarDate";
import { relativeAge } from "../../../lib/relativeTime";

export type ScribbleBlock = {
  /** Stable id for React keys + in-place updates (persisted so edits/toggles
   *  from another device reconcile to the same block). */
  id: string;
  /** Body: freeform inline markdown — **bold**, *italic*, `@handle`, and inline
   *  gifs/images `![](url)`. No headings or block structures. */
  text: string;
  /** A task renders a checkbox; a note is just a line. */
  isTask: boolean;
  done: boolean;
  /** Handle that checked the task off, or null while open / for notes. */
  doneBy: string | null;
  /** Epoch ms the task was checked off, or null. */
  doneAt: number | null;
  /** Handle that wrote the block ("" when hand-added without metadata). */
  author: string;
  /** Epoch ms the block was added — drives the age chip + day bucket + carry. */
  createdAt: number;
  /** Pinned blocks surface in the space's pinned strip. Many may be pinned. */
  pinned: boolean;
};

function randSuffix(seed: number): string {
  // Deterministic-enough per-line suffix without Math.random (unavailable in
  // some runtimes and needless here — the id only needs to be locally unique).
  return (Math.abs(seed * 2654435761) % 100000).toString(36);
}

export function newBlockId(createdAt: number, seq: number): string {
  return `sb-${createdAt}-${randSuffix(createdAt + seq * 7919)}`;
}

// `- [ ] body <!--aura:scribble ..-->` (task) — the box + comment are optional
// so a hand-typed `- [ ] foo` or a bare prose line both parse.
const TASK_RE =
  /^\s*[-*]\s*\[([ xX])\]\s+(.*?)\s*(?:<!--\s*aura:scribble\s+(.*?)\s*-->)?\s*$/;
// A note line: optional leading bullet, then body, optional metadata comment.
const NOTE_RE = /^\s*(?:[-*]\s+)?(.*?)\s*(?:<!--\s*aura:scribble\s+(.*?)\s*-->)?\s*$/;

type Meta = {
  id: string;
  a: string;
  t: number | null;
  d: number | null;
  db: string;
  pin: boolean;
};

function parseMeta(meta: string | undefined): Meta {
  const out: Meta = { id: "", a: "", t: null, d: null, db: "", pin: false };
  if (!meta) return out;
  for (const m of meta.matchAll(/(\w+)=(\S+)/g)) {
    const k = m[1];
    const v = m[2];
    if (k === "id") out.id = v;
    else if (k === "a") out.a = v === "-" ? "" : v;
    else if (k === "db") out.db = v === "-" ? "" : v;
    else if (k === "pin") out.pin = v === "1" || v === "true";
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

/** Parse the markdown doc into blocks. Blank lines and a leading `# ...`
 *  heading are ignored. Blocks missing a stored timestamp inherit `fallbackTs`
 *  (capture it once per load so ages don't jitter between renders). */
export function parseScribble(md: string, fallbackTs: number): ScribbleBlock[] {
  const blocks: ScribbleBlock[] = [];
  const seen = new Set<string>();
  let seq = 0;
  // Drop a block already seen this parse: an exact id repeat, or (for lines an
  // agent/old build wrote without metadata) an identical text+kind. Guards
  // against pages doubled by an earlier bug without collapsing two distinct
  // notes a user genuinely typed (those carry different ids / timestamps).
  const isDup = (key: string): boolean => {
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  };
  for (const raw of (md || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue; // optional title heading
    // A line that is only an HTML comment (e.g. a legacy `<!--aura:day ..-->`
    // separator) carries no body — never a block. Real blocks put the body
    // first and tuck the `aura:scribble` metadata in a *trailing* comment.
    if (line.startsWith("<!--")) continue;
    const task = TASK_RE.exec(raw);
    if (task && task[2].trim()) {
      const meta = parseMeta(task[3]);
      const text = task[2].trim();
      if (isDup(meta.id ? `id:${meta.id}` : `task:${text}`)) continue;
      const createdAt = meta.t ?? fallbackTs;
      const done = task[1].toLowerCase() === "x";
      blocks.push({
        id: meta.id || newBlockId(createdAt, seq++),
        text,
        isTask: true,
        done,
        doneBy: done ? meta.db || null : null,
        doneAt: done ? meta.d ?? fallbackTs : null,
        author: meta.a,
        createdAt,
        pinned: meta.pin,
      });
      continue;
    }
    const note = NOTE_RE.exec(raw);
    const body = note?.[1]?.trim();
    if (!body) continue;
    const meta = parseMeta(note?.[2]);
    if (isDup(meta.id ? `id:${meta.id}` : `note:${body}`)) continue;
    const createdAt = meta.t ?? fallbackTs;
    blocks.push({
      id: meta.id || newBlockId(createdAt, seq++),
      text: body,
      isTask: false,
      done: false,
      doneBy: null,
      doneAt: null,
      author: meta.a,
      createdAt,
      pinned: meta.pin,
    });
  }
  return blocks;
}

function serializeBlock(b: ScribbleBlock): string {
  const parts: string[] = [];
  parts.push(`id=${b.id}`);
  if (b.author) parts.push(`a=${b.author}`);
  parts.push(`t=${b.createdAt}`);
  if (b.isTask && b.done) {
    if (b.doneAt) parts.push(`d=${b.doneAt}`);
    if (b.doneBy) parts.push(`db=${b.doneBy}`);
  }
  if (b.pinned) parts.push("pin=1");
  const meta = `<!--aura:scribble ${parts.join(" ")}-->`;
  if (b.isTask) return `- [${b.done ? "x" : " "}] ${b.text} ${meta}`;
  return `${b.text} ${meta}`;
}

/** Serialize blocks back to the markdown board in array order — the array is
 *  the single source of truth for ordering, so an Enter-inserted block keeps
 *  its position and the layout round-trips through save/load unchanged. Empty
 *  blocks are dropped so an in-progress draft never persists. */
export function serializeScribble(blocks: ScribbleBlock[]): string {
  const ordered = blocks.filter((b) => b.text.trim().length > 0);
  return ordered.map(serializeBlock).join("\n") + (ordered.length ? "\n" : "");
}

/** Compact, human age like `now` / `4m` / `3h` / `2d` / `1w`. */
export function formatAge(tsMs: number, nowMs: number): string {
  // One ladder for the whole app — see lib/relativeTime. This copy skipped the
  // seconds rung, so a block written 50 seconds ago read "0m".
  return relativeAge(tsMs, { now: nowMs, style: "compact" });
}

/** Local-calendar day bucket, e.g. "2026-6-24" (month is 0-based, internal). */
export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Whole local-calendar days between two instants (>= 0). */
export function daysBetween(aMs: number, bMs: number): number {
  const a = new Date(aMs);
  const b = new Date(bMs);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((db - da) / 86_400_000));
}

/** A friendly day label: "Today", "Yesterday", else a full date. */
export function dayLabel(dayMs: number, nowMs: number): string {
  const diff = daysBetween(dayMs, nowMs);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  // The year-only-when-it-differs rule was worked out here first; it is
  // the whole app's now — see lib/calendarDate.
  return shortDate(dayMs, { now: nowMs, weekday: "short" });
}

/** An open task first added on an earlier day — it "carried" into today. */
export function isCarried(b: ScribbleBlock, nowMs: number): boolean {
  return b.isTask && !b.done && dayKey(b.createdAt) !== dayKey(nowMs);
}

export type ScribbleDay = {
  /** dayKey() value. */
  key: string;
  /** A representative instant inside the day (for labels/sorting). */
  ts: number;
  /** Whether this is the live, editable "today" canvas. */
  isToday: boolean;
  /** Blocks shown in this day, reading order (oldest first). */
  blocks: ScribbleBlock[];
};

/** Bucket blocks into day canvases for the forever-scroll.
 *
 *  Today's canvas collects everything created today PLUS every open task
 *  carried from an earlier day (so live work is all in one place). Each past
 *  day keeps the blocks created that day that have "settled" — notes and
 *  completed tasks — as read-only history; its still-open tasks live in today
 *  instead, so nothing shows twice. Within a day, blocks keep their array order
 *  (the source of truth) so carried tasks lead, then the day's own blocks in
 *  the order they were written. Days are returned newest-first. */
export function bucketDays(blocks: ScribbleBlock[], nowMs: number): ScribbleDay[] {
  const todayKey = dayKey(nowMs);
  const today: ScribbleBlock[] = [];
  const past = new Map<string, { ts: number; blocks: ScribbleBlock[] }>();
  for (const b of blocks) {
    const k = dayKey(b.createdAt);
    if (k === todayKey) {
      today.push(b);
      continue;
    }
    if (isCarried(b, nowMs)) {
      today.push(b); // open task from an earlier day → surfaces in today
      continue;
    }
    let bucket = past.get(k);
    if (!bucket) {
      bucket = { ts: b.createdAt, blocks: [] };
      past.set(k, bucket);
    }
    bucket.blocks.push(b);
    if (b.createdAt < bucket.ts) bucket.ts = b.createdAt;
  }
  const days: ScribbleDay[] = [];
  days.push({ key: todayKey, ts: nowMs, isToday: true, blocks: today });
  const pastDays = [...past.entries()]
    .map(([key, v]) => ({ key, ts: v.ts, isToday: false, blocks: v.blocks }))
    .sort((a, b) => b.ts - a.ts); // newest past day first
  return [...days, ...pastDays];
}
