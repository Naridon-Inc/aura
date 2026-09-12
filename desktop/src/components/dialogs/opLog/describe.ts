// What Aura did, said the way the person reading it would say it.
//
// The list used to print the engine's own `summary` string straight onto the
// screen. Those strings are written for a log file, and it showed:
//
//     Linked files to a reason   Attributed 1 path(s) to intent #1788769912
//     Linked files to a reason   Attributed 1 path(s) to intent #1788769912
//     …eight more of exactly that…
//     Wrote down a reason        Logged intent: [Image #1] these screens as we
//
// Every complaint in that picture is fixable from data already on the row, and
// none of it needs a sentence invented:
//
//   • the ten identical rows are ONE action — ten files filed under one
//     reason. They share `undo_payload.intent_ts`, so they group.
//   • `undo_payload.file_paths` holds the actual file names. Say those.
//   • `intent #1788769912` is a timestamp. It is also the key into the intent
//     log, so the reason itself can be looked up and shown instead of its id.
//   • "Logged intent: " is a prefix the writer adds, `[Image #1]` is a
//     placeholder the chat leaves behind, and the tail is a 60-character cut
//     landing mid-word. All three are presentation, all three come off.
//
// Everything below reads a real field or a fixed label. Where a fact is
// missing (no payload, no matching intent row) the line is dropped rather
// than guessed — a person opening this window is usually worried, and a
// plausible sentence is worse than a short one.

import type { OpEntry } from "../../../lib/api";
import { opKindLabel } from "../../../lib/opKinds";

/** One file an op touched, as the row prints it. */
export type OpFile = {
  /** Absolute path exactly as the engine recorded it — the hover text. */
  path: string;
  /** Basename. What the row prints. */
  name: string;
  /** Not inside this project. Worth saying: most people are surprised to see
   *  scratch files and agent notes in here, and the honest answer is that
   *  those really are the paths the step was recorded against. */
  outside: boolean;
};

/** A group of ops rendered as one line. */
export type OpStory = {
  /** Plain-language action. Never an id, never an engine tag. */
  title: string;
  /** The reason in the user's own words, cleaned. Null when unknown. */
  reason: string | null;
  /** A short factual aside when the engine's own summary is already plain
   *  English (the clash kinds). Null otherwise. */
  note: string | null;
  files: OpFile[];
  /** How many recorded steps this line stands for. 1 for an ordinary row. */
  steps: number;
};

/** Consecutive ops the list shows as a single line. `lead` is the newest — the
 *  one selection and undo act on, so undo keeps meaning exactly what it meant
 *  when every step had its own row. */
export type OpGroup = {
  id: string;
  kind: string;
  lead: OpEntry;
  ops: OpEntry[];
};

const LOGGED_PREFIX = /^Logged intent:\s*/i;
const SNAPSHOT_PREFIX = /^Snapshotted\s+/i;
/** `[Image #1]`, `[Image 2]` — what the chat leaves where a screenshot was. */
const IMAGE_TOKEN = /\[image\s*#?\d*\]/gi;
/** `record_op` cuts the intent at 60 chars before writing the summary
 *  (cmd_aura.rs: `trimmed.chars().take(60)`), so a summary that long is a
 *  sentence with its last word bitten off. */
const SUMMARY_CUT = 60;

function payload(op: OpEntry): Record<string, unknown> | null {
  const p = op.undo_payload;
  return p && typeof p === "object" && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * The reason, readable. Strips the writer's prefix and the chat's image
 * placeholders, collapses the whitespace that leaves behind, and — when the
 * text is a known truncation — ends it on a whole word with an ellipsis
 * instead of mid-syllable.
 */
export function cleanReason(raw: string, opts: { truncated?: boolean } = {}): string {
  let t = raw.replace(LOGGED_PREFIX, "").replace(IMAGE_TOKEN, " ");
  t = t.replace(/\s+/g, " ").trim();
  // A message that was only a screenshot leaves nothing to quote. Say nothing.
  if (t === "") return "";
  if (opts.truncated) {
    const whole = t.replace(/\s+\S*$/, "");
    t = `${whole === "" ? t : whole}…`;
  }
  return t;
}

/** The reason as the op itself recorded it, and whether that record was cut. */
function reasonFromSummary(op: OpEntry): { text: string; truncated: boolean } {
  const body = op.summary.replace(LOGGED_PREFIX, "");
  return { text: body, truncated: body.length >= SUMMARY_CUT };
}

export function fileFromPath(path: string, repoRoot: string): OpFile {
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const root = repoRoot.replace(/\/+$/, "");
  const outside = root === "" || !(path === root || path.startsWith(`${root}/`));
  return { path, name, outside };
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** What makes two neighbouring ops the same action. Null = never grouped. */
function groupKey(op: OpEntry): string | null {
  if (op.kind === "intent_attribute") {
    const ts = num(payload(op)?.intent_ts);
    return ts === null ? null : `attr:${ts}`;
  }
  if (op.kind === "log_intent") {
    const r = cleanReason(reasonFromSummary(op).text);
    return r === "" ? null : `reason:${r}`;
  }
  if (op.kind === "snapshot") return "snapshot";
  return null;
}

/**
 * Fold consecutive same-action ops into one line each.
 *
 * Only CONSECUTIVE runs fold, so the list still reads as history in the order
 * it happened — nothing is gathered up from elsewhere in the timeline and
 * reordered. An undone step never joins a live one, because the line has to be
 * able to say "undone" about all of it or none of it.
 */
export function groupOps(ops: readonly OpEntry[]): OpGroup[] {
  const out: OpGroup[] = [];
  let open: { key: string; group: OpGroup } | null = null;
  for (const op of ops) {
    const base = groupKey(op);
    const key = base === null ? null : `${base}|${op.undone_at === null ? "live" : "undone"}`;
    if (open !== null && key !== null && open.key === key) {
      open.group.ops.push(op);
      continue;
    }
    const group: OpGroup = { id: op.op_id, kind: op.kind, lead: op, ops: [op] };
    out.push(group);
    open = key === null ? null : { key, group };
  }
  return out;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "twice", then "3 times". Nobody says "2 times". */
function times(n: number): string {
  return n === 2 ? "twice" : `${n} times`;
}

/**
 * The line for one group.
 *
 * `reasonByTs` is the intent log keyed by its timestamp — the same number the
 * op payloads carry as `intent_ts`. A hit gives the reason in full; a miss
 * falls back to the op's own (truncated) copy, or to nothing.
 */
export function describeGroup(
  group: OpGroup,
  repoRoot: string,
  reasonByTs: ReadonlyMap<number, string>,
): OpStory {
  const steps = group.ops.length;
  const lead = group.lead;
  const p = payload(lead);
  const blank: OpStory = { title: opKindLabel(group.kind), reason: null, note: null, files: [], steps };

  const lookup = (ts: number | null): string | null => {
    if (ts === null) return null;
    const full = reasonByTs.get(ts);
    return full === undefined ? null : cleanReason(full);
  };

  switch (group.kind) {
    case "log_intent": {
      const full = lookup(num(p?.intent_ts));
      const own = reasonFromSummary(lead);
      const reason = full ?? cleanReason(own.text, { truncated: own.truncated });
      return {
        ...blank,
        title: steps > 1 ? `Wrote down the same reason ${times(steps)}` : "Wrote down why",
        reason: reason === "" ? null : reason,
      };
    }
    case "intent_attribute": {
      const files = dedupe(group.ops.flatMap((o) => strings(payload(o)?.file_paths))).map((f) =>
        fileFromPath(f, repoRoot),
      );
      if (files.length === 0) return blank;
      return {
        ...blank,
        title: `Linked ${files.length} ${plural(files.length, "file", "files")} to why ${plural(
          files.length,
          "it",
          "they",
        )} changed`,
        reason: lookup(num(p?.intent_ts)),
        files,
      };
    }
    case "snapshot": {
      const files = dedupe(
        group.ops
          .map((o) => (SNAPSHOT_PREFIX.test(o.summary) ? o.summary.replace(SNAPSHOT_PREFIX, "") : ""))
          .filter((s) => s !== ""),
      ).map((f) => fileFromPath(f, repoRoot));
      if (files.length === 0) return { ...blank, title: `Kept a copy of ${steps} ${plural(steps, "file", "files")}` };
      return {
        ...blank,
        title:
          files.length === 1
            ? `Kept a copy of ${files[0].name}`
            : `Kept a copy of ${files.length} files`,
        files,
      };
    }
    case "guard_revert": {
      const file = str(payload(lead)?.file);
      const f = file === null ? null : fileFromPath(file, repoRoot);
      return {
        ...blank,
        title: f === null ? "Put a file back the way it was" : `Put ${f.name} back the way it was`,
        files: f === null ? [] : [f],
      };
    }
    // Split and merge name their two reasons by timestamp — "Split intent
    // #1788769912 → #1788770004" — so the summary is dropped and the reasons
    // are looked up instead. Either can be missing; a title on its own is a
    // true thing to say, a made-up description of which reason is not.
    case "intent_split": {
      const kept = lookup(num(p?.kept_ts));
      return { ...blank, title: "Split one reason into two", reason: kept };
    }
    case "intent_merge": {
      const kept = lookup(num(p?.kept_ts));
      return { ...blank, title: "Merged two reasons into one", reason: kept };
    }
    // The clash kinds already write plain English ("Conflict on parseRow in
    // src/lib/rows.ts"), so their summary is kept as a factual aside.
    case "conflict_open":
      return { ...blank, title: "Found a clash", note: lead.summary };
    case "conflict_resolve":
      return { ...blank, title: "Settled a clash", note: lead.summary };
    default:
      // A kind this file hasn't caught up with. `opKindLabel` still names it,
      // and the engine's own words go underneath rather than nothing at all.
      return { ...blank, note: lead.summary };
  }
}

/** How many of a story's files live outside the project being looked at. */
export function outsideCount(files: readonly OpFile[]): number {
  return files.reduce((n, f) => n + (f.outside ? 1 : 0), 0);
}
