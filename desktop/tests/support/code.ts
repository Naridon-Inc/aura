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

/** Read a file under `aura-shell/src` with its comments removed.
 *
 *  A handful of ui files are no longer sources but addresses: they re-export
 *  a module from `aura-shared/ui`, where the console reads the very same
 *  bytes. A scan pinning "the tab strip still does X" must read the strip,
 *  not the forwarding line — so a pure re-export shim is followed to the
 *  shared file, exactly the way the bundler follows it. */
export async function readSrc(rel: string): Promise<string> {
  const stripped = stripComments(
    await Bun.file(`${import.meta.dir}/../../src/${rel}`).text(),
  );
  const shim = stripped
    .trim()
    .match(/^export \* from "@shared\/(ui\/[\w-]+)";$/);
  if (shim) {
    return stripComments(
      await Bun.file(
        `${import.meta.dir}/../../../aura-shared/${shim[1]}.tsx`,
      ).text(),
    );
  }
  return stripped;
}

// A whole-tree scan is the most common shape in tests/: walk every source
// file under `src` and assert that nothing outside one module says a
// particular thing. Two dozen of them, each opening the glob itself and
// awaiting one `Bun.file(...).text()` per file in sequence.
//
// That is a few hundred serial round trips per test, and it was running on
// bun's default 5 second budget. Enough on an idle machine; not enough with
// the whole suite running beside a dev server, so a rotating handful of them
// failed every run at 5000-something milliseconds with an empty offenders
// list underneath — red because the machine was busy, not because they found
// anything. Tests that go red on load stop being read, which is the real
// cost.
//
// So the tree is read ONCE per process, in parallel, and memoized: the
// second scan in a file is free, and the first is I/O-bound rather than
// round-trip-bound. Each caller still applies its own predicate — this
// shares the reading, not the judgment.

/** Memoized by glob pattern plus whether comments were stripped. */
const trees = new Map<string, Promise<ReadonlyMap<string, string>>>();

async function readTree(
  pattern: string,
  strip: boolean,
): Promise<ReadonlyMap<string, string>> {
  const root = `${import.meta.dir}/../../src`;
  const rels: string[] = [];
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: root })) {
    rels.push(rel);
  }
  const texts = await Promise.all(
    rels.map((rel) => Bun.file(`${root}/${rel}`).text()),
  );
  return new Map(
    rels.map((rel, i) => [rel, strip ? stripComments(texts[i]) : texts[i]]),
  );
}

function tree(pattern: string, strip: boolean) {
  const key = `${strip ? "s" : "r"}:${pattern}`;
  let found = trees.get(key);
  if (found === undefined) {
    found = readTree(pattern, strip);
    trees.set(key, found);
  }
  return found;
}

/** Every file under `src` matching `pattern`, verbatim, keyed by its path
 *  relative to `src`. Use this when the scan has to see comments too. */
export function srcTree(
  pattern = "**/*.{ts,tsx}",
): Promise<ReadonlyMap<string, string>> {
  return tree(pattern, false);
}

/** The same tree with comments removed — the right default for a scan that
 *  pins what the app SAYS, since most of these files carry a comment naming
 *  the exact string they stopped writing. */
export function strippedSrcTree(
  pattern = "**/*.{ts,tsx}",
): Promise<ReadonlyMap<string, string>> {
  return tree(pattern, true);
}
