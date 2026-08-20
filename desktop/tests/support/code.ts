// Every source scan in tests/ strips comments first, because most of these
// files carry a comment naming the exact string they stopped writing — a scan
// that reads comments finds the epitaph and reports the corpse as alive.
//
// ORDER MATTERS, and it is the opposite of the obvious one. Line comments go
// first. A line comment may legally contain an open-block-comment token: a
// glob does it every time, and ChangesPanel.tsx has one naming `.aura` with a
// double-star wildcard. Strip block comments first and the regex treats that
// as an opening delimiter, then deletes everything up to the next closing one
// — in ChangesPanel, five kilobytes, including the exact lines a scan was
// pinning.
//
// A haystack with a hole in it fails `toContain` loudly, which is survivable.
// It passes an occurs-exactly-once count while a second copy hides inside the
// deleted region, which is not: the scan reports the file clean because it
// never saw the offending half. Eleven test files had their own copy of this
// in the wrong order. There is one copy now.

// The same hole, one layer down. Ordering the two passes correctly stopped a
// LINE comment from opening a fake block; nothing stopped ordinary prose from
// doing it. SettingsDialog.tsx renders
//
//     <code>themes/*.json</code>
//
// and that `/*` — inside JSX text, not a comment, not even a string — opened a
// match that ran until the next real `*/` thirty-two thousand characters
// later. Half the file vanished before any scan saw it, and three assertions
// about code that is plainly there failed as "not found". Had the assertions
// been `.not.toContain`, they would have passed on a file with its middle
// removed, which is the same silence this helper exists to prevent.
//
// A block comment in this codebase always begins a line or follows an opening
// delimiter. Prose never does — the `/*` in a glob has a word character in
// front of it. That distinction is enough, and it is checked below rather
// than assumed.

/** Characters a real `/*` may follow. Anything else means it's prose. */
const BLOCK_OPENER_PREDECESSORS = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  "(",
  ",",
  ";",
  ":",
  "=",
  "{",
  "[",
]);

/** Drop `/* … *\/` pairs, skipping openers that are really text. */
function stripBlockComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const prev = i === 0 ? "\n" : src[i - 1];
      if (BLOCK_OPENER_PREDECESSORS.has(prev)) {
        const end = src.indexOf("*/", i + 2);
        // An unterminated comment really does run to the end of the file.
        i = end === -1 ? src.length : end + 2;
        continue;
      }
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** Source with comments removed, for scans that must not read prose. */
export function stripComments(src: string): string {
  return stripBlockComments(
    src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, ""),
  );
}

/** Read a file under `aura-shell/src` with its comments removed. */
export async function readSrc(rel: string): Promise<string> {
  return stripComments(
    await Bun.file(`${import.meta.dir}/../../src/${rel}`).text(),
  );
}
