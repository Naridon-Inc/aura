// Telling a line of code from a line of prose about code, in whatever language
// the file happens to be written in.
//
// This exists for the guards. A guard that greps is a guard that fires on the
// comment explaining why the thing it forbids was removed — and this repo's
// files are *made* of those comments, so a grepping guard gets switched off
// within a week and the invariant it held dies quietly with it. The opposite
// mistake is worse and quieter still: a reader that mistakes a string for a
// comment swallows the code after it, and every assertion downstream then
// passes on nothing at all.
//
// So each character is classified as one of three things and nothing more:
// code, the text of a literal, or a comment. That is the whole vocabulary the
// guards need. A real parser would be the wrong tool — it would have to keep up
// with five languages, where this only has to keep up with one habit: people
// write about ssh in comments, and reach for it in code.
//
// The Rust half of this reasoning already exists, in `cloudbox/sole_ssh.rs`'s
// `kinds`. This is the same idea taught the other families, because the
// transport forked into TypeScript once already and a Rust-only reader was
// green the entire time it was forked.

/** What a character is doing, which is all any guard needs to know. */
export type Kind = "code" | "text" | "comment";

/**
 * How a file spells its comments and its strings.
 *
 * Grouped by habit rather than by language, with one exception. Every
 * C-descendant agrees about `//` and block comments, and every scripting
 * language here agrees about `#` — but Rust is its own family, because a
 * `'` means something different there than anywhere else and guessing which
 * is exactly the kind of silent misreading this module exists to prevent. A
 * language nobody here writes is `unknown`, and an unknown file is not read at
 * all rather than read wrongly.
 */
export type Family = "rust" | "c" | "hash" | "unknown";

/** Extensions we can read, by family. */
const C_LIKE = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "go",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "cs",
] as const;

const HASH_LIKE = ["sh", "bash", "zsh", "py", "rb", "yml", "yaml", "toml"] as const;

/** Which reader a path wants, by its extension. */
export function familyOf(path: string): Family {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "rs") return "rust";
  if ((C_LIKE as readonly string[]).includes(ext)) return "c";
  if ((HASH_LIKE as readonly string[]).includes(ext)) return "hash";
  return "unknown";
}

/** Whether this module can read a path at all. */
export function isReadable(path: string): boolean {
  return familyOf(path) !== "unknown";
}

/**
 * What each character of a source file is doing.
 *
 * Indexed per *character* rather than per byte: the prose in this repo is full
 * of `—`, `…` and `'`, and an index that disagrees with `String.prototype`'s is
 * an index that lands mid-character and reads the wrong thing.
 */
export function kinds(src: string, family: Family): Kind[] {
  const out = new Array<Kind>(src.length).fill("code");
  if (family === "unknown") return out;
  const slashes = family === "rust" || family === "c";
  let i = 0;

  const fill = (from: number, to: number, k: Kind) => {
    for (let j = from; j < to && j < src.length; j++) out[j] = k;
  };

  while (i < src.length) {
    // ── Comments ─────────────────────────────────────────────────────────
    if (slashes && src.startsWith("//", i)) {
      const end = endOfLine(src, i);
      fill(i, end, "comment");
      i = end;
      continue;
    }
    if (!slashes && src[i] === "#") {
      const end = endOfLine(src, i);
      fill(i, end, "comment");
      i = end;
      continue;
    }
    if (slashes && src.startsWith("/*", i) && opensBlock(src, i)) {
      // Counted, because Rust's block comments nest. Where they don't, a `/*`
      // inside a block comment is vanishingly rare, and over-counting only ever
      // *extends* a comment — never shortens one, which is the direction that
      // would hide a spawn.
      let depth = 0;
      while (i < src.length) {
        if (src.startsWith("/*", i)) {
          depth++;
          fill(i, i + 2, "comment");
          i += 2;
        } else if (src.startsWith("*/", i)) {
          depth--;
          fill(i, i + 2, "comment");
          i += 2;
          if (depth === 0) break;
        } else {
          out[i] = "comment";
          i++;
        }
      }
      continue;
    }

    // ── Literals ─────────────────────────────────────────────────────────
    // Rust's raw strings, which hold this repo's regexes and shell fragments
    // and obey none of the escaping below.
    if (family === "rust") {
      const raw = rawStringEnd(src, i);
      if (raw !== null) {
        fill(i, raw, "text");
        i = raw;
        continue;
      }
    }

    // Python's triple quotes, which are where a `#` most often hides.
    if (family === "hash") {
      const triple = tripleQuoteEnd(src, i);
      if (triple !== null) {
        fill(i, triple, "text");
        i = triple;
        continue;
      }
    }

    if (opensLiteral(src, i, family)) {
      const quote = src[i]!;
      // A shell's single quotes suspend every escape there is, backslash
      // included — reading `'\'` as an escaped quote runs the literal on to the
      // end of the file.
      const escapes = !(family === "hash" && quote === "'");
      out[i] = "text";
      i++;
      while (i < src.length) {
        out[i] = "text";
        if (escapes && src[i] === "\\") {
          if (i + 1 < src.length) out[i + 1] = "text";
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    i++;
  }
  return out;
}

/**
 * Whether the character at `i` opens a string or character literal.
 *
 * The whole question is Rust's `'`. In `&'a str` it names a lifetime, and read
 * as a literal its quote never closes — after which every character to the end
 * of the file is text and a guard passes because it can no longer see any code.
 * A Rust character literal is one character and then a closing quote, or an
 * escape; a lifetime is neither.
 */
function opensLiteral(src: string, i: number, family: Family): boolean {
  const ch = src[i];
  if (ch === '"') return true;
  if (ch === "`") return family === "c";
  if (ch !== "'") return false;
  if (family !== "rust") return true;
  const next = src[i + 1];
  if (next === undefined) return false;
  if (next === "\\") return true;
  const one = [...src.slice(i + 1)][0];
  return one !== undefined && src[i + 1 + one.length] === "'";
}

/**
 * Whether the `/*` at `i` really opens a comment, or is prose that looks like
 * one.
 *
 * Learned the hard way by this directory's other reader, `code.ts`, and worth
 * restating because the failure is invisible: `SettingsDialog.tsx` renders the
 * text `themes/*.json`, and that `/*` — inside JSX text, neither comment nor
 * string — opened a match that ran thirty-two thousand characters to the next
 * real `*&#47;`. Half the file vanished before any scan saw it. For a guard,
 * that direction is the dangerous one: a blanked region is a region where a
 * spawn cannot be found, so the file passes.
 *
 * A real block comment always begins a line or follows an opening delimiter.
 * Prose never does — the `/*` in a glob has a word character in front of it.
 */
function opensBlock(src: string, i: number): boolean {
  if (i === 0) return true;
  return " \t\n\r(,;:={[*/".includes(src[i - 1]!);
}

/** The index of the newline ending the line holding `i` (or the end). */
function endOfLine(src: string, i: number): number {
  const nl = src.indexOf("\n", i);
  return nl === -1 ? src.length : nl;
}

/** Where `r"…"` / `r#"…"#` starting at `i` ends, or null if one doesn't. */
function rawStringEnd(src: string, i: number): number | null {
  if (src[i] !== "r") return null;
  const before = src[i - 1];
  if (before !== undefined && /[A-Za-z0-9_]/.test(before)) return null;
  let hashes = 0;
  while (src[i + 1 + hashes] === "#") hashes++;
  if (src[i + 1 + hashes] !== '"') return null;
  const close = `"${"#".repeat(hashes)}`;
  const at = src.indexOf(close, i + hashes + 2);
  return at === -1 ? src.length : at + close.length;
}

/** Where `"""…"""` / `'''…'''` starting at `i` ends, or null if one doesn't. */
function tripleQuoteEnd(src: string, i: number): number | null {
  for (const q of ['"""', "'''"]) {
    if (!src.startsWith(q, i)) continue;
    const at = src.indexOf(q, i + 3);
    return at === -1 ? src.length : at + 3;
  }
  return null;
}

/**
 * The same source with every comment blanked out.
 *
 * Blanked rather than removed, so an offset into the result is still an offset
 * into the original and a finding can name the line it is really on. Newlines
 * survive for the same reason.
 */
export function withoutComments(src: string, family: Family): string {
  const k = kinds(src, family);
  const out: string[] = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = k[i] === "comment" && src[i] !== "\n" ? " " : src[i]!;
  }
  return out.join("");
}

/**
 * The same Rust with every `#[cfg(test)]` item cut out of it.
 *
 * The claim these guards make is about *production* code. This repo's place
 * modules dial a real box on purpose in their live tests, and every one of them
 * would fail a reader that could not tell the two apart. A file gated whole
 * with an inner `#![cfg(test)]` comes back empty, which is the honest reading:
 * none of it ships.
 *
 * `not(test)` is the opposite claim — it means "production", and stays.
 */
export function productionRust(src: string): string {
  const k = kinds(src, "rust");
  const keep = new Array<boolean>(src.length).fill(true);
  let i = 0;
  while (i < src.length) {
    if (k[i] !== "code" || src[i] !== "#") {
      i++;
      continue;
    }
    const inner = src.startsWith("#![cfg(", i);
    if (!inner && !src.startsWith("#[cfg(", i)) {
      i++;
      continue;
    }
    const attrEnd = closedBy(src, k, i + (inner ? 2 : 1), "[", "]");
    if (attrEnd === null) break;
    const attr = src.slice(i, attrEnd + 1);
    if (!attr.includes("test") || attr.includes("not(test")) {
      i = attrEnd + 1;
      continue;
    }
    if (inner) return "";
    const itemEnd = endOfItem(src, k, attrEnd + 1);
    if (itemEnd === null) break;
    for (let j = i; j <= itemEnd; j++) keep[j] = false;
    i = itemEnd + 1;
  }
  const out: string[] = [];
  for (let j = 0; j < src.length; j++) if (keep[j]) out.push(src[j]!);
  return out.join("");
}

/** The index of the delimiter closing the one at `open`. */
function closedBy(
  src: string,
  k: Kind[],
  open: number,
  l: string,
  r: string,
): number | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (k[i] !== "code") continue;
    if (src[i] === l) depth++;
    else if (src[i] === r) {
      depth--;
      // Unbalanced is a file we cannot read, not a claim about it.
      if (depth < 0) return null;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Where the item starting at `from` ends: its closing brace, or the semicolon
 * of one with no body (`#[cfg(test)] use super::*;`).
 *
 * Brackets and parens are counted, so the `;` inside a `[u8; 4]` return type is
 * not mistaken for the end of the item.
 */
function endOfItem(src: string, k: Kind[], from: number): number | null {
  let nested = 0;
  for (let i = from; i < src.length; i++) {
    if (k[i] !== "code") continue;
    const ch = src[i];
    if (ch === "(" || ch === "[") nested++;
    else if (ch === ")" || ch === "]") nested = Math.max(0, nested - 1);
    else if (ch === ";" && nested === 0) return i;
    else if (ch === "{" && nested === 0) return closedBy(src, k, i, "{", "}");
  }
  return null;
}

/**
 * A file's production source, ready to search: comments blanked, and in Rust
 * the test-gated items cut.
 *
 * An unreadable file comes back empty — a guard makes no claim about a language
 * it cannot read, and saying so here keeps every caller from having to.
 */
export function readable(path: string, src: string): string {
  const family = familyOf(path);
  if (family === "unknown") return "";
  return withoutComments(family === "rust" ? productionRust(src) : src, family);
}
