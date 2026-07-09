// timelineModel — the pure, testable spine of the Project Timeline wizard.
//
// The Timeline answers one question: *how did this project evolve?* It takes
// the real intent log (`api.auraIntentRecent` → IntentRow[]) — the same source
// the Sessions list reads — and folds it into a time-ordered narrative:
//
//   • moments   — one per logged intent (the "why" + the files/code it touched)
//   • sessions  — contiguous runs (a Claude session id, or an agent's unbroken
//                 stretch of work) so the scrubber can show coherent chapters
//   • days      — local-day buckets for the scrubber's date ticks
//   • churn     — a per-bucket sparkline of additions/deletions over time
//
// Everything here is a pure function of the rows: no I/O, no React, no clock
// reads beyond what the caller passes in. That keeps the scrubber math honest
// and unit-testable, and keeps the components thin.

import type { IntentRow } from "./api";
import { isToolMetadataPath } from "./categorizeChange";

/** A new session starts when an agent's work has a gap larger than this and the
 *  rows carry no durable session id to bind them. 45 min mirrors the "a coffee
 *  break ends a session" heuristic the Sessions view leans on. */
const SESSION_GAP_SECS = 45 * 60;

export type TimelineFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  commit: string | null;
};

/** One logged intent, placed on the timeline. */
export type TimelineMoment = {
  row: IntentRow;
  /** Unix seconds (the intent log stores seconds). */
  ts: number;
  intent: string;
  intentType: string | null;
  agentId: string;
  sessionId: string | null;
  files: TimelineFile[];
  adds: number;
  dels: number;
  fileCount: number;
  /** Index into `model.sessions` for the chapter this moment belongs to. */
  sessionIndex: number;
};

/** A contiguous run of moments — the timeline's chapters. */
export type TimelineSession = {
  id: string;
  agentId: string;
  startTs: number;
  endTs: number;
  title: string;
  momentIndices: number[];
  adds: number;
  dels: number;
  fileCount: number;
};

/** A local-day bucket, for the scrubber's date ticks. */
export type TimelineDay = {
  key: string;
  label: string;
  startTs: number;
  count: number;
};

/** A fixed-width churn bucket for the scrubber sparkline. */
export type TimelineBucket = {
  startTs: number;
  endTs: number;
  adds: number;
  dels: number;
  count: number;
};

export type TimelineModel = {
  moments: TimelineMoment[];
  sessions: TimelineSession[];
  days: TimelineDay[];
  buckets: TimelineBucket[];
  minTs: number;
  maxTs: number;
  spanSecs: number;
  totalAdds: number;
  totalDels: number;
  /** Unique file paths touched across the whole history. */
  totalFiles: number;
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS = [
  "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat",
];

/** Stable local-day key (YYYY-MM-DD) from unix seconds. */
export function dayKeyOf(tsSecs: number): string {
  const d = new Date(tsSecs * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Short "30 Apr" day label from unix seconds. */
export function dayLabelOf(tsSecs: number): string {
  const d = new Date(tsSecs * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "Thu 30 Apr · 14:32" — the absolute moment stamp the detail panel shows. */
export function momentStamp(tsSecs: number): string {
  const d = new Date(tsSecs * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${hh}:${mm}`;
}

/** "just now" / "2h" / "3d" from a positive seconds-ago delta. */
export function relTimeOf(secsAgo: number): string {
  if (!Number.isFinite(secsAgo) || secsAgo < 0) return "just now";
  if (secsAgo < 45) return "just now";
  const mins = Math.floor(secsAgo / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(secsAgo / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(secsAgo / 86400);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** A short, human chapter title from an intent string (first sentence, capped). */
export function chapterTitle(intent: string): string {
  const trimmed = (intent || "").trim();
  if (!trimmed) return "Untitled session";
  // First sentence or first 64 chars, whichever is shorter.
  const stop = trimmed.search(/[.!?\n]/);
  const head = stop > 8 ? trimmed.slice(0, stop) : trimmed;
  return head.length > 64 ? `${head.slice(0, 63).trimEnd()}…` : head;
}

/** Split a raw intent into a short headline (its first sentence) and the rest of
 *  the prose. Engineers tend to log intents as one dense run-on sentence — left
 *  raw, the whole paragraph lands as the moment's headline and reads as a wall.
 *  The Timeline shows only the first sentence big, and tucks the remainder behind
 *  a calm, collapsible "reasoning" so each beat reads like a diary entry, not a
 *  commit dump. Pure + deterministic.
 *
 *  The sentence boundary requires punctuation followed by whitespace, so it never
 *  splits a decimal ("v1.5") or a file name ("App.tsx", "timelineModel.ts"). */
export function splitIntentStory(intent: string): { headline: string; rest: string } {
  const norm = (intent || "").replace(/\s+/g, " ").trim();
  if (!norm) return { headline: "", rest: "" };
  // Drop a leading agent/auto marker so the headline opens with the meaning.
  const cleaned = norm.replace(/^\[(?:auto|skip|wip)\]\s*/i, "");

  // Break at the EARLIEST natural clause boundary so a dense run-on doesn't land
  // as a multi-line title: end of the first sentence (.!? + space), an em/en-dash
  // aside, or a colon that introduces detail (": ", never a "::" path separator).
  const b = firstClauseBoundary(cleaned);
  if (b > 11 && b < cleaned.length - 1) {
    const headline = cleaned.slice(0, b).trim();
    const rest = cleaned.slice(b).replace(/^[\s:—–-]+/, "").trim();
    if (headline.length >= 12) return { headline: capHeadline(headline), rest };
  }

  // No boundary: word-cap the headline; if it overflows, the full text becomes
  // the reasoning so nothing is lost and the title never walls.
  const capped = capHeadline(cleaned);
  return { headline: capped, rest: capped.endsWith("…") ? cleaned : "" };
}

/** Index of the earliest clause boundary in `s`, or -1. The headline is `s` up
 *  to (and, for a sentence, including) that boundary. */
function firstClauseBoundary(s: string): number {
  let best = -1;
  const consider = (i: number): void => {
    if (i >= 0 && (best < 0 || i < best)) best = i;
  };
  // Sentence end: .!? followed by whitespace (decimal/filename-safe). Keep the
  // punctuation with the headline, so cut just after it.
  const sent = s.search(/[.!?]\s/);
  if (sent >= 0) consider(sent + 1);
  // Em/en/hyphen aside surrounded by spaces — break before the dash.
  const dash = s.search(/\s[—–-]\s/);
  if (dash >= 0) consider(dash);
  // Colon introducing detail (": "), but never a "::" path separator.
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] === ":" && /\s/.test(s[i + 1]) && s[i - 1] !== ":") {
      consider(i);
      break;
    }
  }
  return best;
}

const HEADLINE_MAX = 90;

/** Headlines don't need trailing punctuation; cap over-long ones at a word
 *  boundary so a title never cuts mid-word. */
function capHeadline(s: string): string {
  const trimmed = s.replace(/\s*[.;,:]+$/, "").trim();
  if (trimmed.length <= HEADLINE_MAX) return trimmed;
  const slice = trimmed.slice(0, HEADLINE_MAX);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > HEADLINE_MAX * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** Break prose into sentence "beats" for a calm, story-like layout (one beat per
 *  line). Same decimal/filename-safe boundary as splitIntentStory. */
export function sentenceBeats(prose: string): string[] {
  const norm = (prose || "").replace(/\s+/g, " ").trim();
  if (!norm) return [];
  return norm
    .split(/(?<=[.!?])\s+(?=[A-Z(“"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Map a position 0..1 along the timeline to a unix-seconds timestamp. */
export function tsAtFraction(model: TimelineModel, frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  return model.minTs + f * model.spanSecs;
}

/** The 0..1 position of a timestamp along the timeline. Span 0 → centered. */
export function fractionOfTs(model: TimelineModel, ts: number): number {
  if (model.spanSecs <= 0) return 0.5;
  return Math.max(0, Math.min(1, (ts - model.minTs) / model.spanSecs));
}

/** Index of the moment whose timestamp is nearest `ts` (binary-friendly small
 *  scan; moments are sorted). Returns -1 for an empty model. */
export function nearestMomentIndex(model: TimelineModel, ts: number): number {
  const ms = model.moments;
  if (ms.length === 0) return -1;
  let best = 0;
  let bestD = Math.abs(ms[0].ts - ts);
  for (let i = 1; i < ms.length; i++) {
    const d = Math.abs(ms[i].ts - ts);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Running totals up to AND including `momentIndex` — the "by this point in
 *  the project's life" stats the detail panel shows as you scrub. */
export function cumulativeAt(
  model: TimelineModel,
  momentIndex: number,
): { adds: number; dels: number; files: number; sessions: number; moments: number } {
  let adds = 0;
  let dels = 0;
  const paths = new Set<string>();
  const sessions = new Set<number>();
  const upTo = Math.min(momentIndex, model.moments.length - 1);
  for (let i = 0; i <= upTo; i++) {
    const m = model.moments[i];
    adds += m.adds;
    dels += m.dels;
    sessions.add(m.sessionIndex);
    for (const f of m.files) paths.add(f.path);
  }
  return {
    adds,
    dels,
    files: paths.size,
    sessions: sessions.size,
    moments: upTo + 1,
  };
}

/** Build the timeline model from raw intent rows. Rows may arrive in any order
 *  (the Sessions feed is newest-first) — we sort ascending here so the whole
 *  module can assume chronological order. `bucketCount` controls the sparkline
 *  resolution. */
export function buildTimelineModel(
  rows: IntentRow[],
  bucketCount = 72,
): TimelineModel {
  const clean = rows
    .filter((r) => Number.isFinite(r.timestamp) && r.timestamp > 0)
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  if (clean.length === 0) {
    return {
      moments: [],
      sessions: [],
      days: [],
      buckets: [],
      minTs: 0,
      maxTs: 0,
      spanSecs: 0,
      totalAdds: 0,
      totalDels: 0,
      totalFiles: 0,
    };
  }

  const minTs = clean[0].timestamp;
  const maxTs = clean[clean.length - 1].timestamp;
  const spanSecs = Math.max(0, maxTs - minTs);

  const moments: TimelineMoment[] = [];
  const sessions: TimelineSession[] = [];
  const allPaths = new Set<string>();
  let totalAdds = 0;
  let totalDels = 0;

  for (const row of clean) {
    // Aura's own bookkeeping (`.aura/…` intent logs, `.entire/…` object-store
    // shards) is NOT part of the project's story — counting it bloats the
    // Timeline with thousands of phantom "lines changed" and dozens of phantom
    // files. Drop those paths BEFORE we measure churn, so every count (files,
    // adds/dels, the sparkline buckets) reflects only real code the build
    // touched. Churn is then summed from this filtered set, not the raw row.
    const files: TimelineFile[] = (row.changeset?.files ?? [])
      .filter((f) => !isToolMetadataPath(f.path))
      .map((f) => ({
        path: f.path,
        status: f.status ?? "modified",
        additions: typeof f.additions === "number" ? f.additions : 0,
        deletions: typeof f.deletions === "number" ? f.deletions : 0,
        commit: f.commit ?? null,
      }));
    const churn = files.reduce(
      (acc, f) => {
        acc.adds += f.additions;
        acc.dels += f.deletions;
        return acc;
      },
      { adds: 0, dels: 0 },
    );
    for (const f of files) allPaths.add(f.path);
    totalAdds += churn.adds;
    totalDels += churn.dels;

    const sessionId = (row.claude_session_id ?? "").trim() || null;
    const agentId = row.agent_id || "unknown";

    // Decide whether this moment extends the current session chapter or opens
    // a new one. A durable session id always binds its rows together; absent
    // that, an unbroken stretch of the same agent within the gap window stays
    // one chapter.
    const cur = sessions[sessions.length - 1];
    const extendsCurrent =
      cur != null &&
      (sessionId != null
        ? cur.id === sessionId
        : cur.id.startsWith("gap:") &&
          cur.agentId === agentId &&
          row.timestamp - cur.endTs <= SESSION_GAP_SECS);

    let sessionIndex: number;
    if (extendsCurrent && cur) {
      sessionIndex = sessions.length - 1;
      cur.endTs = row.timestamp;
      cur.adds += churn.adds;
      cur.dels += churn.dels;
    } else {
      sessionIndex = sessions.length;
      sessions.push({
        id: sessionId ?? `gap:${agentId}:${row.timestamp}`,
        agentId,
        startTs: row.timestamp,
        endTs: row.timestamp,
        title: chapterTitle(row.intent),
        momentIndices: [],
        adds: churn.adds,
        dels: churn.dels,
        fileCount: 0,
      });
    }

    const momentIndex = moments.length;
    sessions[sessionIndex].momentIndices.push(momentIndex);
    moments.push({
      row,
      ts: row.timestamp,
      intent: row.intent || "",
      intentType: row.intent_type ?? null,
      agentId,
      sessionId,
      files,
      adds: churn.adds,
      dels: churn.dels,
      fileCount: files.length,
      sessionIndex,
    });
  }

  // Per-session unique file count.
  for (const s of sessions) {
    const paths = new Set<string>();
    for (const mi of s.momentIndices) {
      for (const f of moments[mi].files) paths.add(f.path);
    }
    s.fileCount = paths.size;
  }

  // Days — one entry per distinct local day, in order.
  const days: TimelineDay[] = [];
  const seenDay = new Map<string, TimelineDay>();
  for (const m of moments) {
    const key = dayKeyOf(m.ts);
    let day = seenDay.get(key);
    if (!day) {
      day = { key, label: dayLabelOf(m.ts), startTs: m.ts, count: 0 };
      seenDay.set(key, day);
      days.push(day);
    }
    day.count += 1;
  }

  // Churn sparkline buckets — fixed count across the span. A zero span (all
  // moments at one instant) collapses to a single bucket.
  const buckets: TimelineBucket[] = [];
  const n = spanSecs > 0 ? Math.max(1, bucketCount) : 1;
  const width = spanSecs > 0 ? spanSecs / n : 1;
  for (let i = 0; i < n; i++) {
    buckets.push({
      startTs: minTs + i * width,
      endTs: minTs + (i + 1) * width,
      adds: 0,
      dels: 0,
      count: 0,
    });
  }
  for (const m of moments) {
    let bi =
      spanSecs > 0 ? Math.floor(((m.ts - minTs) / spanSecs) * n) : 0;
    if (bi >= n) bi = n - 1;
    if (bi < 0) bi = 0;
    buckets[bi].adds += m.adds;
    buckets[bi].dels += m.dels;
    buckets[bi].count += 1;
  }

  return {
    moments,
    sessions,
    days,
    buckets,
    minTs,
    maxTs,
    spanSecs,
    totalAdds,
    totalDels,
    totalFiles: allPaths.size,
  };
}
