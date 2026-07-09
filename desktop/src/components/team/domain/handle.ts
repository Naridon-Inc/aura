/** Team (chat) domain — pseudonymous handle generator.
 *
 *  Reddit-style `adjective-animal-NNN` handles for the #aura public
 *  channel's "use a handle instead" path. The default identity stays the
 *  real git name (decision: "real name, disclosed first"); this only
 *  supplies an opt-in alias scoped to #aura.
 *
 *  `pseudonymFor(seed)` is pure and deterministic — the same seed (the
 *  stable device id) always yields the same handle, so a user who picks
 *  a handle, dismisses, and returns sees a consistent alias without us
 *  persisting anything ourselves. `randomHandle()` is the shuffle button's
 *  non-deterministic variant. Word lists are small, curated, and calm
 *  (arctic / nature) — no external dependency, lowercase, hyphenated. */

// Curated calm/arctic adjectives — kept short so handles stay readable.
const ADJECTIVES = [
  "arctic",
  "calm",
  "frost",
  "glacial",
  "polar",
  "quiet",
  "still",
  "snow",
  "north",
  "pale",
  "silver",
  "drift",
  "tidal",
  "lunar",
  "amber",
  "slate",
];

// Curated animals — recognisable, friendly, single-word.
const ANIMALS = [
  "otter",
  "fox",
  "seal",
  "hare",
  "owl",
  "lynx",
  "puffin",
  "narwhal",
  "heron",
  "marten",
  "ermine",
  "raven",
  "wren",
  "tern",
  "vole",
  "elk",
];

/** FNV-1a 32-bit hash — small, fast, dependency-free, good enough to spread
 *  a device-id seed across the word lists deterministically. */
function hash32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    // Multiply by the FNV prime (0x01000193) with 32-bit overflow.
    h = Math.imul(h, 0x01000193);
  }
  // Coerce to an unsigned 32-bit integer.
  return h >>> 0;
}

/** Build the `adjective-animal-NNN` slug from three indices/number. */
function compose(adjIdx: number, aniIdx: number, num: number): string {
  const adj = ADJECTIVES[adjIdx % ADJECTIVES.length];
  const ani = ANIMALS[aniIdx % ANIMALS.length];
  // Three-digit suffix (100–999) keeps the shape uniform and avoids the
  // jarring look of a one- or two-digit tail.
  const nnn = 100 + (num % 900);
  return `${adj}-${ani}-${nnn}`;
}

/** Deterministic handle for a seed (use the stable `device_id`). The same
 *  seed always returns the same handle. */
export function pseudonymFor(seed: string): string {
  const safe = seed && seed.length > 0 ? seed : "aura";
  const h = hash32(safe);
  // Pull three independent fields out of the single hash by slicing bits.
  const adjIdx = h % ADJECTIVES.length;
  const aniIdx = (h >>> 8) % ANIMALS.length;
  const num = (h >>> 16) % 900;
  return compose(adjIdx, aniIdx, num);
}

/** Non-deterministic handle for the shuffle / regenerate button. */
export function randomHandle(): string {
  const adjIdx = Math.floor(Math.random() * ADJECTIVES.length);
  const aniIdx = Math.floor(Math.random() * ANIMALS.length);
  const num = Math.floor(Math.random() * 900);
  return compose(adjIdx, aniIdx, num);
}
