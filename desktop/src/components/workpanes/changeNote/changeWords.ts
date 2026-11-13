// The words a change note is written in — shared by the diff header that
// sits over a session's or pull request's changes and the change note that
// sits over a commit's file. Both describe the same `aura change-note` facts,
// so both read the same: one set of kind names, one way of humanising an
// identifier, one plain summary. Pure, so the wording is tested without a
// window.

import type { AtlasHoverEntry, ChangedSymbol, FileChangeNote } from "../../../lib/api";
import { humanizeIdentifier } from "../../../lib/prove";
import { sentenceCase } from "@shared/textCase";
import { countOf } from "@shared/plural";

/** tree-sitter kind → a short human word. Unknown kinds pass through. */
export function prettyKind(kind: string): string {
  switch (kind) {
    case "function_item":
    case "function_declaration":
    case "function_definition":
    case "arrow_function":
    case "method_definition":
    case "method_declaration":
      return "fn";
    case "struct_item":
      return "struct";
    case "impl_item":
      return "impl";
    case "class_declaration":
    case "class_definition":
      return "class";
    case "enum_item":
      return "enum";
    case "trait_item":
      return "trait";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
    case "type_item":
      return "type";
    default:
      return kind;
  }
}

/** Both forms of the plain noun, together.
 *
 *  They are written side by side because the summary needs the plural and no
 *  rule can derive it: "enum" is spelled out for the non-engineer as "set of
 *  options", where the HEAD word takes the s. A rule that read only the final
 *  letter summarised two changed enums as "Reworked 2 set of optionses." */
export type PlainKind = { one: string; many: string };

/** The same kinds, spelled out as a plain noun for the non-engineer summary
 *  ("function", "class") rather than the terse mechanism word ("fn"). */
export function plainKind(kind: string): PlainKind {
  switch (prettyKind(kind)) {
    case "fn":
      return { one: "function", many: "functions" };
    case "struct":
      return { one: "structure", many: "structures" };
    case "impl":
      return { one: "implementation", many: "implementations" };
    case "class":
      return { one: "class", many: "classes" };
    case "enum":
      return { one: "set of options", many: "sets of options" };
    case "trait":
      return { one: "trait", many: "traits" };
    case "interface":
      return { one: "interface", many: "interfaces" };
    case "type":
      return { one: "type", many: "types" };
    default:
      return { one: "piece", many: "pieces" };
  }
}

/** "added" | "modified" | "deleted" → a plain word for the non-engineer. */
export function changeWord(change: string): string {
  switch (change) {
    case "added":
      return "added";
    case "deleted":
      return "removed";
    default:
      return "changed";
  }
}

/** The one-character mark a piece wears beside its name. */
export function changeMark(change: string): string {
  return change === "deleted" ? "−" : change === "added" ? "+" : "~";
}

/** A code identifier as a plain phrase, sharing BOTH steps with the Goals
 *  surface — the humanizer that produces the words and the casing that
 *  finishes them: `senderFor` → "Sender for", `fsm_happy_path` → "Fsm happy
 *  path". Falls back to the raw name if it humanizes to nothing. */
export function titleize(id: string): string {
  const words = humanizeIdentifier(id).trim();
  if (!words) return id;
  return sentenceCase(words);
}

/** A plain-English "what kind of thing changed, and how" line, from the AST
 *  facts alone — the fallback meaning when the atlas has no richer summary. */
export function pieceMeaning(s: ChangedSymbol): string {
  const kind = plainKind(s.kind).one;
  switch (s.change) {
    case "added":
      return `A new ${kind}.`;
    case "deleted":
      return `This ${kind} was removed.`;
    default:
      return `This ${kind} was reworked.`;
  }
}

/** One plain sentence summarising the whole file's change, composed from the
 *  real changed pieces (not the engine's identifier-laden one-liner). Groups by
 *  kind and names the pieces in plain words: "Reworked 2 functions (sender for,
 *  deliver) and 1 class (email dispatcher)." Falls back to the engine note when
 *  there are no tracked symbols (a mode-only or below-symbol change). */
export function plainSummary(symbols: ChangedSymbol[], engineNote: string): string {
  if (!symbols.length) return engineNote;
  const added = symbols.filter((s) => s.change === "added").length;
  const removed = symbols.filter((s) => s.change === "deleted").length;
  const verb =
    removed && !added && removed === symbols.length
      ? "Removed"
      : added && !removed && added === symbols.length
        ? "Added"
        : "Reworked";
  // Group by plain kind, preserving first-seen order.
  const groups: { kind: PlainKind; names: string[] }[] = [];
  for (const s of symbols) {
    const kind = plainKind(s.kind);
    const g = groups.find((x) => x.kind.one === kind.one);
    const name = humanizeIdentifier(s.identifier).trim();
    if (g) g.names.push(name);
    else groups.push({ kind, names: [name] });
  }
  const phrases = groups.map((g) => {
    const head = countOf(g.names.length, g.kind.one, g.kind.many);
    const named = g.names.filter(Boolean);
    return named.length ? `${head} (${named.join(", ")})` : head;
  });
  const list =
    phrases.length <= 1
      ? phrases.join("")
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
  return `${verb} ${list}.`;
}

/** A readable absolute timestamp for the "when" hover. Unix seconds,
 *  tolerating milliseconds. */
export function absTime(value: number): string {
  const ms = value > 1e12 ? value : value * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/** Split a repo-relative path into a muted folder + emphasised filename so the
 *  "where" reads at a glance without the whole path shouting. */
export function whereParts(file: string): { folder: string; base: string } {
  const norm = file.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  if (i < 0) return { folder: "", base: norm };
  return { folder: norm.slice(0, i + 1), base: norm.slice(i + 1) };
}

/** The piece's real-world name: the Code Atlas title when we have one, else
 *  the identifier humanized. */
export function pieceTitle(s: ChangedSymbol, entry: AtlasHoverEntry | undefined): string {
  return entry?.title?.trim() || titleize(s.identifier);
}

/** Meaning precedence, most-specific first: this piece's own model line for
 *  this side → the file-level generated line when it is the lone changed piece
 *  → the atlas summary → a plain "what kind of thing changed" fallback. Every
 *  path lands on real words, never an empty placeholder.
 *
 *  Shared with the focused-piece caption in the diff below, so clicking a piece
 *  shows down there exactly the sentence it shows up here. */
export function pieceLine(
  s: ChangedSymbol,
  symbolMeaning: string | undefined,
  meaningOverride: string | undefined,
  entry: AtlasHoverEntry | undefined,
): string {
  return (
    symbolMeaning?.trim() ||
    meaningOverride?.trim() ||
    entry?.summary?.trim() ||
    pieceMeaning(s)
  );
}

/** Which side a piece appears on. A `modified` piece is on both. */
export function onSide(s: ChangedSymbol, side: "previous" | "next"): boolean {
  return side === "previous"
    ? s.change === "deleted" || s.change === "modified"
    : s.change === "added" || s.change === "modified";
}

// ── The commit's own words, for the change note over a commit's file ────────

/** A short, reader-facing summary of the blast radius for the closed line —
 *  the "how far it ripples" clause, kept to a single phrase. */
export function blastSummary(note: FileChangeNote): string | null {
  if (note.features.length) {
    const n = note.features.length;
    return `powers ${n} feature${n === 1 ? "" : "s"}${note.truncated ? "+" : ""}`;
  }
  if (note.dependent_count > 0) {
    const n = note.dependent_count;
    return `${n} other place${n === 1 ? "" : "s"} to re-check`;
  }
  if (note.leaf) return "safe in isolation";
  return null;
}

/** First non-empty line of the commit message — the human "why". Conventional
 *  prefixes (`feat(x):`) are kept; they read fine as a reason clause. */
export function commitReason(message: string): string | null {
  const first = (message ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ?? null;
}

/** Everything in the commit message AFTER the subject line — the elaboration:
 *  the root cause, the thinking, the trade-offs. The closed line already
 *  carries the subject, so this is the part a reader opens for the full "why",
 *  never a repeat of it. Null when the commit recorded only a one-liner. */
export function commitBody(message: string): string | null {
  const lines = (message ?? "").split("\n");
  const subjectIdx = lines.findIndex((l) => l.trim().length > 0);
  if (subjectIdx < 0) return null;
  const rest = lines.slice(subjectIdx + 1).join("\n").trim();
  return rest.length ? rest : null;
}

/** The other files that moved in the SAME change, minus the one annotated:
 *  every file in the commit, symbol-tracked or not, each once. */
export function siblingFiles(
  files: { file: string }[],
  otherFiles: string[],
  self: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...files.map((x) => x.file), ...otherFiles]) {
    if (f === self || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/** Just the file name; the directory goes in the tooltip. */
export function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** An entry-point kind (`http_route`) as words ("http route"). */
export function prettyEntryKind(kind: string): string {
  return kind.replace(/_/g, " ");
}
