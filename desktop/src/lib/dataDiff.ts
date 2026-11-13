// dataDiff — what changed in a settings or data file, in plain words.
//
// A code file's change is told piece by piece from its syntax tree. A JSON,
// TOML or YAML file has no functions to name, so the line miner had nothing to
// say about one and the editor fell back to a single generic sentence over a
// diff that plainly said a lot. This reads both versions as data and compares
// them structurally instead:
//
//   · a list of records is matched record by record, by whichever field
//     identifies them (email, id, handle …), so a team member who moved to the
//     top reads as moved — not as one person removed and another added;
//   · a field that stopped being saved reads as exactly that;
//   · a value that changed reads "used to … → now …", a switch reads "turned
//     on/off", and a timestamp reads "updated" rather than two raw numbers.
//
// Each row leads with the human sentence; the key it came from travels beside
// it for anyone who wants to find it in the file. Values under a key that looks
// like a secret, and opaque token-shaped strings, are never quoted. Pure and
// deterministic, so it paints instantly and is tested without a window.

import { countOf } from "@shared/plural";
import { sentenceCase } from "@shared/textCase";
import { dataFormatOf, parseData } from "./dataParse";
import { humanizeIdentifier } from "./prove";

export type ChangeMark = "+" | "−" | "~";

/** One changed thing: its mark, the plain sentence, and the key it lives at. */
export type DataChangeRow = { mark: ChangeMark; text: string; key: string };

/** Larger files are not compared — a lockfile's churn is not a story. */
const MAX_BYTES = 512 * 1024;
const MAX_ROWS = 200;
const MAX_DEPTH = 5;

/** The plain rows for one data file's change, or `null` when the file is not a
 *  data file, is too large, or either version does not read as data. An empty
 *  list means both versions hold the same data (a formatting-only edit). */
export function describeDataChange(
  path: string,
  before: string,
  after: string,
): DataChangeRow[] | null {
  const format = dataFormatOf(path);
  if (!format || /(^|\/)(package-lock|npm-shrinkwrap|composer\.lock)[^/]*$/.test(path)) return null;
  if (before.length > MAX_BYTES || after.length > MAX_BYTES) return null;
  const a = parseData(before, format);
  const b = parseData(after, format);
  if (a === undefined || b === undefined) return null;
  const rows: DataChangeRow[] = [];
  diffValue(a, b, [], rows);
  return rows.slice(0, MAX_ROWS);
}

// ── walking the two values ────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): boolean {
  return v === null || (typeof v !== "object" && typeof v !== "function");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function diffValue(a: unknown, b: unknown, path: string[], rows: DataChangeRow[]): void {
  if (rows.length >= MAX_ROWS || deepEqual(a, b)) return;
  if (path.length < MAX_DEPTH && isObj(a) && isObj(b)) return diffObject(a, b, path, rows);
  if (path.length < MAX_DEPTH && Array.isArray(a) && Array.isArray(b)) {
    return diffArray(a, b, path, rows);
  }
  const key = path[path.length - 1] ?? "";
  rows.push({ mark: "~", text: sentenceCase(changePhrase(key, a, b)), key: path.join(".") });
}

function diffObject(a: Obj, b: Obj, path: string[], rows: DataChangeRow[]): void {
  const keys = [...Object.keys(a), ...Object.keys(b).filter((k) => !has(a, k))];
  for (const k of keys) {
    const p = [...path, k];
    if (!has(a, k)) rows.push({ mark: "+", text: addedText(k, b[k]), key: p.join(".") });
    else if (!has(b, k)) rows.push({ mark: "−", text: `Removed ${nounFor(k, a[k])}`, key: p.join(".") });
    else diffValue(a[k], b[k], p, rows);
  }
}

function has(o: Obj, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function diffArray(a: unknown[], b: unknown[], path: string[], rows: DataChangeRow[]): void {
  const key = path[path.length - 1] ?? "";
  const where = path.join(".");
  const list = humanizeIdentifier(key) || "list";
  if (a.concat(b).every(isObj)) return diffRecords(a as Obj[], b as Obj[], path, rows);
  if (a.concat(b).every(isScalar)) {
    const aKeys = new Set(a.map(scalarKey));
    const bKeys = new Set(b.map(scalarKey));
    const added = b.filter((v) => !aKeys.has(scalarKey(v)));
    const removed = a.filter((v) => !bKeys.has(scalarKey(v)));
    if (!added.length && !removed.length) {
      rows.push({ mark: "~", text: `${sentenceCase(list)}: order changed`, key: where });
      return;
    }
    pushListRows(rows, "+", added, list, where);
    pushListRows(rows, "−", removed, list, where);
    return;
  }
  rows.push({
    mark: "~",
    text: `${sentenceCase(list)} changed (${a.length} → ${countOf(b.length, "item")})`,
    key: where,
  });
}

function scalarKey(v: unknown): string {
  return `${typeof v}:${String(v)}`;
}

function pushListRows(
  rows: DataChangeRow[],
  mark: ChangeMark,
  values: unknown[],
  list: string,
  where: string,
): void {
  if (!values.length) return;
  const verb = mark === "+" ? "Added" : "Removed";
  const prep = mark === "+" ? "to" : "from";
  if (values.length > 3) {
    const shown = values.slice(0, 3).map(preview).join(", ");
    rows.push({
      mark,
      text: `${verb} ${countOf(values.length, singular(list))} ${prep} ${list}: ${shown}, …`,
      key: where,
    });
    return;
  }
  for (const v of values) rows.push({ mark, text: `${verb} ${preview(v)} ${prep} ${list}`, key: where });
}

// ── lists of records ──────────────────────────────────────────────────────

const IDENTITY_FIELDS = [
  "id", "uuid", "email", "handle", "login", "username", "key", "slug", "path", "name", "title",
];
const LABEL_FIELDS = [
  "name", "title", "display_name", "displayName", "label", "handle", "login", "username",
  "email", "id", "key", "slug", "path",
];

/** The field that identifies a record on both sides: unique within each side,
 *  present on most records, and pairing up the most records across the two. */
function identityField(a: Obj[], b: Obj[]): string | null {
  let best: string | null = null;
  let bestPairs = 0;
  for (const f of IDENTITY_FIELDS) {
    const av = a.map((r) => idValue(r[f]));
    const bv = b.map((r) => idValue(r[f]));
    if (!usable(av) || !usable(bv)) continue;
    const aSet = new Set(av.filter(Boolean));
    const pairs = bv.filter((v) => v && aSet.has(v)).length;
    if (pairs > bestPairs) {
      best = f;
      bestPairs = pairs;
    }
  }
  return best;
}

function idValue(v: unknown): string | null {
  return typeof v === "string" ? v || null : typeof v === "number" ? String(v) : null;
}

function usable(values: (string | null)[]): boolean {
  const present = values.filter((v): v is string => !!v);
  if (!values.length) return true;
  return present.length * 2 >= values.length && new Set(present).size === present.length;
}

function diffRecords(a: Obj[], b: Obj[], path: string[], rows: DataChangeRow[]): void {
  const where = path.join(".");
  const list = humanizeIdentifier(path[path.length - 1] ?? "") || "list";
  const noun = singular(list);
  const pairOf = pairRecords(a, b);
  const moves = movedRecords(pairOf);
  const pairedA = new Set(pairOf.values());

  // First pass: what happened to each record, in the file's new order.
  type Seen =
    | { kind: "added"; name: string | null }
    | { kind: "changed"; name: string; phrases: string[]; move?: string };
  const seen: Seen[] = [];
  b.forEach((item, bi) => {
    const ai = pairOf.get(bi);
    if (ai === undefined) {
      seen.push({ kind: "added", name: labelOf(item) });
      return;
    }
    const phrases = recordPhrases(a[ai], item);
    const move = moves.get(bi);
    if (!phrases.length && !move) return;
    const name = labelOf(item) ?? `${sentenceCase(noun)} ${bi + 1}`;
    seen.push({ kind: "changed", name, phrases, move });
  });

  // Records that changed in exactly the same way say so once, together: five
  // people who all stopped carrying the same three fields are one fact.
  const groups = new Map<string, string[]>();
  for (const s of seen) {
    if (s.kind !== "changed" || !s.phrases.length) continue;
    const k = s.phrases.join("\u0000");
    groups.set(k, [...(groups.get(k) ?? []), s.name]);
  }
  const told = new Set<string>();
  for (const s of seen) {
    if (s.kind === "added") {
      rows.push({
        mark: "+",
        text: s.name ? `${s.name} added as ${article(noun)} ${noun}` : `Added ${article(noun)} new ${noun}`,
        key: where,
      });
      continue;
    }
    const k = s.phrases.join("\u0000");
    const group = s.phrases.length ? (groups.get(k) ?? []) : [];
    if (group.length > 1) {
      if (s.move) rows.push({ mark: "~", text: `${s.name} ${s.move}`, key: where });
      if (told.has(k)) continue;
      told.add(k);
      rows.push({ mark: "~", text: `${namesOf(group, noun)}: ${joinPhrases(s.phrases)}`, key: where });
      continue;
    }
    const text = !s.phrases.length
      ? `${s.name} ${s.move}`
      : `${s.name}: ${joinPhrases(s.move ? [s.move, ...s.phrases] : s.phrases)}`;
    rows.push({ mark: "~", text, key: where });
  }
  a.forEach((item, ai) => {
    if (pairedA.has(ai)) return;
    const name = labelOf(item);
    rows.push({
      mark: "−",
      text: name ? `${name} removed from ${list}` : `Removed ${article(noun)} ${noun}`,
      key: where,
    });
  });
}

/** b-index → a-index for the records that are the same record on both sides. */
function pairRecords(a: Obj[], b: Obj[]): Map<number, number> {
  const out = new Map<number, number>();
  const field = identityField(a, b);
  if (field) {
    const byId = new Map<string, number>();
    a.forEach((r, i) => {
      const v = idValue(r[field]);
      if (v) byId.set(v, i);
    });
    b.forEach((r, i) => {
      const v = idValue(r[field]);
      const ai = v ? byId.get(v) : undefined;
      if (ai !== undefined) out.set(i, ai);
    });
    return out;
  }
  if (a.length === b.length) {
    b.forEach((_, i) => out.set(i, i));
    return out;
  }
  const taken = new Set<number>();
  b.forEach((r, i) => {
    const ai = a.findIndex((x, j) => !taken.has(j) && deepEqual(x, r));
    if (ai >= 0) {
      taken.add(ai);
      out.set(i, ai);
    }
  });
  return out;
}

/** Which paired records changed position relative to the others, worded by
 *  where they went. The records on the longest run that kept its order stay
 *  put; only the rest are said to have moved. */
function movedRecords(pairOf: Map<number, number>): Map<number, string> {
  const pairs = [...pairOf.entries()].sort((x, y) => x[0] - y[0]); // [bi, ai] in new order
  const seq = pairs.map(([, ai]) => ai);
  const keep = longestIncreasing(seq);
  const oldRank = new Map([...seq].sort((x, y) => x - y).map((ai, r) => [ai, r] as const));
  const out = new Map<number, string>();
  pairs.forEach(([bi, ai], newRank) => {
    if (keep.has(newRank)) return;
    const was = oldRank.get(ai) ?? newRank;
    const where =
      newRank === 0
        ? "moved to the top"
        : newRank === pairs.length - 1
          ? "moved to the bottom"
          : newRank < was
            ? "moved up"
            : "moved down";
    out.set(bi, where);
  });
  return out;
}

/** Indexes (into `seq`) of one longest strictly increasing subsequence. */
function longestIncreasing(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails[tails.length - 1] ?? -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

/** What changed inside one record, as short lowercase phrases. */
function recordPhrases(a: Obj, b: Obj): string[] {
  const removed = Object.keys(a).filter((k) => !has(b, k));
  const added = Object.keys(b).filter((k) => !has(a, k));
  const changed = Object.keys(b).filter((k) => has(a, k) && !deepEqual(a[k], b[k]));
  const out: string[] = [];
  if (removed.length) out.push(`stopped saving ${listJoin(removed.map((k) => nounFor(k, a[k])))}`);
  if (added.length) {
    const named = added.map((k) => {
      const v = b[k];
      const quiet = !isScalar(v) || hidesValue(k, v) || isTime(k, v) || v === null;
      return quiet ? nounFor(k, v) : `${nounFor(k, v)} (${preview(v)})`;
    });
    out.push(`now saves ${listJoin(named)}`);
  }
  for (const k of changed) out.push(changePhrase(k, a[k], b[k]));
  return out;
}

/** "Sam and Rio", or "Sam, Rio and 3 other members" for a long list. */
function namesOf(names: string[], noun: string): string {
  if (names.length <= 3) return listJoin(names);
  return `${names.slice(0, 2).join(", ")} and ${countOf(names.length - 2, `other ${noun}`)}`;
}

function joinPhrases(phrases: string[]): string {
  if (phrases.length <= 3) return phrases.join("; ");
  return `${phrases.slice(0, 3).join("; ")}; and ${countOf(phrases.length - 3, "more change")}`;
}

function labelOf(item: Obj): string | null {
  for (const f of LABEL_FIELDS) {
    const v = item[f];
    if (typeof v === "string" && v.trim()) {
      const s = f === "path" ? (v.split("/").filter(Boolean).pop() ?? v) : v.trim();
      return clip(s, 40);
    }
  }
  return null;
}

// ── words ─────────────────────────────────────────────────────────────────

/** A changed value, as a lowercase phrase led by what it is. */
function changePhrase(key: string, a: unknown, b: unknown): string {
  const noun = nounFor(key, b ?? a);
  if (typeof a === "boolean" && typeof b === "boolean") return `${noun} turned ${b ? "on" : "off"}`;
  if (!isScalar(a) || !isScalar(b)) return `${noun} changed`;
  if (hidesValue(key, a) || hidesValue(key, b)) return `${noun} changed`;
  if (isTime(key, a) && isTime(key, b)) return `${noun} updated`;
  return `${noun} used to ${preview(a)} → now ${preview(b)}`;
}

function addedText(key: string, v: unknown): string {
  const noun = nounFor(key, v);
  if (isObj(v)) {
    const n = Object.keys(v).length;
    return n ? `Added ${noun} (${countOf(n, "setting")})` : `Added ${noun}`;
  }
  if (Array.isArray(v)) return `Added ${noun} (${countOf(v.length, "item")})`;
  if (v === null || hidesValue(key, v) || isTime(key, v) || isFolderPath(key, v)) return `Added ${noun}`;
  return `Added ${noun}: ${preview(v)}`;
}

/** What a key holds, as a plain lowercase noun phrase. */
function nounFor(key: string, value: unknown): string {
  if (isFolderPath(key, value)) return "this computer's folder path";
  const words = humanizeIdentifier(key) || key || "the value";
  if (/(_at|At)$/.test(key)) return `${humanizeIdentifier(key.replace(/(_at|At)$/, ""))} time`;
  if (typeof value === "number" && !isTime(key, value) && singular(words) !== words) {
    return `${singular(words)} count`;
  }
  return words;
}

/** An absolute path on the machine that wrote the file — meaningless to anyone
 *  else, so it is named for what it is rather than quoted. */
function isFolderPath(key: string, v: unknown): boolean {
  return (
    typeof v === "string" &&
    /(root|dir|path|folder|cwd|home|workspace)/i.test(key) &&
    (/^\/(Users|home|Volumes|var|opt|private|mnt|tmp)\//.test(v) || /^[A-Za-z]:\\/.test(v) || v.startsWith("~/"))
  );
}

const SECRET_KEY =
  /(secret|token|passw|api[_-]?key|apikey|private[_-]?key|credential|auth[_-]?key|cookie|session[_-]?key|signature)/i;

/** True when a value must not be quoted: it sits under a secret-looking key,
 *  or it is an opaque token-shaped string nobody reads as words anyway. */
function hidesValue(key: string, v: unknown): boolean {
  if (SECRET_KEY.test(key)) return true;
  return (
    typeof v === "string" &&
    v.length >= 24 &&
    /^[A-Za-z0-9_\-+/=.]+$/.test(v) &&
    /\d/.test(v) &&
    /[A-Za-z]/.test(v)
  );
}

function isTime(key: string, v: unknown): boolean {
  if (/(_at|At|_on|time|Time|timestamp|_ts|date|Date|seen|Seen)$/.test(key)) return true;
  if (typeof v === "number") return v > 1e9 && v < 1e14 && /(time|stamp|seen|date|_at)/i.test(key);
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);
}

function preview(v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (/^\/|^[A-Za-z]:\\|^~\//.test(v) && v.includes("/")) {
      const tail = v.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
      return `“…/${tail}”`;
    }
    return `“${clip(v.replace(/\s+/g, " "), 32)}”`;
  }
  if (Array.isArray(v)) return countOf(v.length, "item");
  if (isObj(v)) return countOf(Object.keys(v).length, "setting");
  return String(v);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The singular of a plain noun phrase, by its last word. */
export function singular(phrase: string): string {
  const words = phrase.split(" ");
  const last = words.pop() ?? "";
  let one = last;
  if (/[^aeiou]ies$/i.test(last) && last.length > 4) one = last.slice(0, -3) + "y";
  else if (/(ss|sh|ch|x|z|us|as)es$/i.test(last)) one = last.slice(0, -2);
  else if (/[^su]s$/i.test(last) && last.length > 3) one = last.slice(0, -1);
  return [...words, one].join(" ");
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? "an" : "a";
}

function listJoin(items: string[]): string {
  const uniq = [...new Set(items)];
  if (uniq.length <= 1) return uniq[0] ?? "";
  return `${uniq.slice(0, -1).join(", ")} and ${uniq[uniq.length - 1]}`;
}
