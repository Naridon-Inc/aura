// Memorable place-name slugs for auto-naming a new workspace branch when the
// user doesn't type one — mirrors the CLI's place-name list so a worktree
// reads like "houston" or "machu-picchu" instead of an opaque hash. Every name
// is already lowercase + hyphen-safe, so it drops straight into a git branch
// name with no further slugging.

export const PLACE_NAMES: string[] = [
  "houston",
  "auckland",
  "lagos",
  "machu-picchu",
  "kyoto",
  "oslo",
  "cairo",
  "lima",
  "dakar",
  "hanoi",
  "porto",
  "tbilisi",
  "nairobi",
  "bergen",
  "quito",
  "reykjavik",
  "helsinki",
  "lisbon",
  "marrakesh",
  "valencia",
  "santiago",
  "montevideo",
  "tallinn",
  "ljubljana",
  "zagreb",
  "casablanca",
  "kampala",
  "kigali",
  "accra",
  "windhoek",
  "ushuaia",
  "valparaiso",
  "antigua",
  "salvador",
  "medellin",
  "bogota",
  "asuncion",
  "managua",
  "tegucigalpa",
  "guadalajara",
  "monterrey",
  "merida",
  "naples",
  "palermo",
  "seville",
  "granada",
  "bilbao",
  "antwerp",
  "bruges",
  "rotterdam",
  "gothenburg",
  "aarhus",
  "trondheim",
  "tromso",
  "vilnius",
  "riga",
  "krakow",
  "wroclaw",
  "brno",
  "bratislava",
];

/** Pick a memorable place name not already in `taken`. Falls back to a
 *  suffixed name (`houston-2`) when every base name is taken, so it always
 *  returns something usable for a branch. */
export function randomPlaceName(taken?: Set<string>): string {
  const used = taken ?? new Set<string>();
  const free = PLACE_NAMES.filter((n) => !used.has(n));
  if (free.length > 0) {
    return free[Math.floor(Math.random() * free.length)];
  }
  // Every base name is taken — append an incrementing suffix to a random base.
  const base = PLACE_NAMES[Math.floor(Math.random() * PLACE_NAMES.length)];
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
