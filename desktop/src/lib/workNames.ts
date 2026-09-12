// Naming a new copy of the repo after the work it is for.
//
// Starting work used to mint a branch out of a pool of place names, so a
// project with six copies open read `granada`, `auckland`, `zagreb`, … — six
// names that tell you nothing about which one holds the login fix. The
// objective the user types in the composer was right there and went unused.
//
// The rule here: the branch (and therefore the worktree folder beside it) is
// named after what the user said they were doing. A place name is what's left
// when there is genuinely nothing to name it after.
//
// Mirrors `aura-loop/src/worktree_name.rs` — the CLI (`aura work`, the crew
// loop) and the desktop have to slug the same sentence the same way, or the
// same piece of work gets two different names depending on where it started.

import { randomPlaceName } from "./placeNames";

/** Longest slug we produce. Long enough for a real sentence fragment, short
 *  enough that the folder name beside the repo stays readable. */
export const MAX_WORK_NAME_LENGTH = 40;

/** Below this, a slug is never cut at a word boundary — better a mid-word cut
 *  than a name too short to identify the work. */
const MIN_BOUNDARY_LENGTH = 20;

/** Namespaces stripped off the front of a label before slugging, so
 *  `feat/worktree-control-plane` names a copy `worktree-control-plane`. The
 *  branch-flow prefix says what KIND of change it is, never what it is about,
 *  and the name's whole job is telling copies apart. */
const REF_PREFIXES = [
  "refs/heads/",
  "refs/remotes/",
  "origin/",
  "upstream/",
  "feature/",
  "feat/",
  "fix/",
  "bugfix/",
  "hotfix/",
  "chore/",
  "refactor/",
  "docs/",
  "doc/",
  "test/",
  "tests/",
  "perf/",
  "build/",
  "ci/",
  "style/",
  "revert/",
  "release/",
  "wip/",
  "spike/",
  "experiment/",
  "exp/",
  "bug/",
  "task/",
  "story/",
  "epic/",
  // Aura's own worktree namespaces, so a name round-trips.
  "work/",
  "loop/",
  "lane/",
  "aura/",
];

/** Conventional-commit types, stripped when the label opens `<type>: ` or
 *  `<type>(<scope>): ` — "fix(auth): reject expired tokens" is about
 *  rejecting expired tokens. */
const COMMIT_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "revert",
];

/** Drop a leading `<type>: ` / `<type>(<scope>): ` head. Returns null when
 *  the label doesn't open with one. */
function withoutCommitType(s: string): string | null {
  const colon = s.indexOf(":");
  if (colon < 0) return null;
  const head = s.slice(0, colon);
  const open = head.indexOf("(");
  // The scope, when present, is the parenthesised tail of the head. An
  // unclosed `(` means this isn't a commit head at all.
  if (open >= 0 && !head.endsWith(")")) return null;
  const type = (open >= 0 ? head.slice(0, open) : head).trim().toLowerCase();
  if (!type || !COMMIT_TYPES.includes(type)) return null;
  return s.slice(colon + 1);
}

/** Drop every leading namespace and commit type, returning the part that
 *  describes the work. A label that is ONLY a prefix (`feat/`) keeps it —
 *  stripping to nothing would force a pointless fallback. */
export function stripWorkPrefixes(raw: string): string {
  let rest = raw.trim();
  for (;;) {
    const before = rest;
    for (const prefix of REF_PREFIXES) {
      if (rest.length < prefix.length) continue;
      if (rest.slice(0, prefix.length).toLowerCase() !== prefix) continue;
      const stripped = rest.slice(prefix.length).trimStart();
      if (stripped) {
        rest = stripped;
        break;
      }
    }
    const withoutType = withoutCommitType(rest);
    if (withoutType && withoutType.trim()) rest = withoutType.trimStart();
    if (rest === before) return rest;
  }
}

/** Cut a slug to the cap, preferring the last word boundary inside it so the
 *  name reads as words rather than a severed one. */
function cap(slug: string): string {
  if (slug.length <= MAX_WORK_NAME_LENGTH) return slug;
  const head = slug.slice(0, MAX_WORK_NAME_LENGTH);
  const boundary = head.lastIndexOf("-");
  const cut = boundary >= MIN_BOUNDARY_LENGTH ? boundary : MAX_WORK_NAME_LENGTH;
  return trimDashes(slug.slice(0, cut));
}

function trimDashes(s: string): string {
  return s.replace(/^-+/, "").replace(/-+$/, "");
}

/** Lowercase, `[a-z0-9-]`-only, repeats collapsed, ends trimmed, capped.
 *  Non-ASCII is a separator, not a transliteration — `café-99` is `caf-99`,
 *  which is honest about what survived instead of inventing letters nobody
 *  typed. Returns "" when nothing usable survives; the caller decides what
 *  that means rather than getting an invented name. */
export function slugifyWorkName(raw: string): string {
  const kebab = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return cap(trimDashes(kebab));
}

/** The slug for a label believed to describe the work: prefixes off, then
 *  slugged. `null` when nothing usable survives — the caller's signal to fall
 *  back to a generated name. */
export function workNameFrom(label: string | null | undefined): string | null {
  if (!label) return null;
  const slug = slugifyWorkName(stripWorkPrefixes(label));
  return slug || null;
}

/** Highest `-N` suffix `uniqueWorkName` tries before handing back the last
 *  candidate anyway. A repo with a thousand copies of one name has a bigger
 *  problem than its naming, and git's own "already exists" is a better place
 *  to hear about it than a loop that never ends. */
const MAX_SUFFIX = 1000;

/** `base` if it is free, else `base-2`, `base-3`, … The suffix is made to fit
 *  INSIDE the length cap (the base is shortened for it), so a name at the cap
 *  can still be disambiguated. */
export function uniqueWorkName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= MAX_SUFFIX; n += 1) {
    const suffix = `-${n}`;
    const room = Math.max(0, MAX_WORK_NAME_LENGTH - suffix.length);
    const head = base.length > room ? trimDashes(base.slice(0, room)) : base;
    const candidate = `${head}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${MAX_SUFFIX}`;
}

/** The branch a new piece of work gets: named after the objective the user
 *  typed, made unique against the names already in the repo. Falls back to a
 *  memorable place name only when the objective yields nothing sluggable —
 *  a name is better than a hash, but a name for the WORK is better than
 *  either. */
export function workBranchName(objective: string, taken: ReadonlySet<string>): string {
  const described = workNameFrom(objective);
  if (described) return uniqueWorkName(described, taken);
  return randomPlaceName(taken);
}
