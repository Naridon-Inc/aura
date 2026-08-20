// How long ago something happened — one ladder, for the whole app.
//
// There were sixteen. Fourteen private `relAge` copies in components plus two
// exported from streamSummary, and no two agreed. They disagreed on where the
// ladder stops (some ended at days, so a year-old impact alert read "412d"),
// on the floor ("just now" vs "0s"), on whether the answer carries the word
// "ago", and on what an unknown time prints ("", "—", or "NaN"). Two of them
// were outright wrong: one skipped the seconds rung entirely, so anything
// between 45 and 60 seconds old read "0m ago"; the app's one *shared* helper
// stopped at hours, so a week-old agent session read "168h ago".
//
// Two forms are genuinely different and both survive:
//
//   · prose   — "3d ago". Reads inside a sentence or under a heading.
//   · compact — "3d". A dense inline stamp beside a breadcrumb or in a chip,
//               where the word "ago" is the only thing that wouldn't fit.
//
// Everything else — where the ladder stops, what "just now" means, what an
// unknown timestamp prints — is the same everywhere now, because a reader
// moving between two panes should not have to work out whether "3d" and
// "3d ago" are the same claim.
//
// ── Searching for the name finds only what you already suspect ───────────
//
// That first sweep searched for `relAge` and believed it was done. Eighteen
// more ladders were in the tree, under eleven names it never thought to
// look for: `relativeTime` (×5), `relTime` (×3), `formatAge` (×3), and one
// each of `endedAgoLabel`, `agoLabel`, `formatTimestamp`, `relAgo`, `relWhen`,
// `fmtTs`, `statusRelTime`. A second sweep by name found five of them. What
// found the rest, in a single query, was grepping for the *shape of the
// output* rather than the name of the function:
//
//     `\$\{[^}]+\}(s|m|h|d|w|mo|y) ago`
//
// A copy is identified by what it prints. It is not identified by what its
// author happened to call it, because the whole reason it exists is that its
// author did not know the shared one was there.
//
// Between them the eighteen reproduced every defect named above, plus one it
// hadn't anticipated:
//
//   ends at days       ChecksPane, automationsCopy, ReviewDialog, ClipsTray,
//                      FileInsightStrip, CrashRecoveryToast, StartInAgent-
//                      Button. A check that last ran a year ago read "412d
//                      ago" — the exact symptom named at the top of this file,
//                      still shipping on seven surfaces.
//   the 45–60s hole    crewShared, missionData, TimeMachinePane. Under 45
//                      seconds is "just now", and the next line divides by 60
//                      and floors, so 45s through 59s printed "0m ago".
//   rounds the age UP  ChecksPane, askEngine, ReviewDialog, TaskDetailSide-
//                      Panel used Math.round, so 90 seconds read "2m ago" and
//                      45 minutes read "1h ago". A stamp may be vague about
//                      how old something is. It may not say it is older.
//   its own words      askEngine spelled the units out — "5 min ago", "2 hrs
//                      ago", "3 days ago" — next to every other surface's
//                      "5m ago / 2h ago / 3d ago", in the same window.
//
// Two of them documented themselves as copies, which did not help. missionData
// said "Mirrors crewShared.relativeTime" and mirrored the bug along with the
// rungs. SplitDiffHeader claimed to be "the same shape the Goals cards use, so
// 'when' reads consistently across surfaces" while skipping the weeks rung, so
// a ten-day-old commit read "10d ago" there and "1w ago" on the card it named.
// Asserting consistency is not the same as sharing the code that produces it.
//
// And chatSlashHandler declared its own ladder on line 473 of a file that
// imports this one on line 18 and calls it on line 725.
//
// ── The shape you search for is still only one shape ─────────────────────
//
// That grep looked for `${n}d ago`. Nine more ladders were sitting in plain
// sight printing `${n}d` — the compact style, the same rungs minus the word
// the query was anchored on. Searching by output shape beats searching by
// name, and it is still a search for one shape: whatever form you picture
// while writing the pattern is the only form it can return.
//
// The cure is to grep for the *decision* instead of the rendering. Every one
// of the nine was found by:
//
//     return "now"|"just now"          — the floor every ladder has to pick
//     `\$\{[^}]+\}(s|m|h|d|w|mo|y)`    — a bare quantity-plus-unit
//
// The nine:
//
//   SessionsPane, SessionDetailPane and OverviewPane held byte-identical
//   copies of `relTime`, down to the same doc line — and all three had the
//   45-second hole this file was written to close: under 45s is "just now",
//   then the next line floors secsAgo/60, so 45s through 59s printed "0m".
//   scribbleModel and taskbar were a second byte-identical pair with the same
//   hole. taskbar's was exported and called by nobody.
//
//   radarFormat, syncFormat and OpLogDialog all stopped at days.
//
//   workspaces/model's `shortAge` had rungs of its own — 48h, 14d, 9w, 24mo —
//   and rounded at every step. A checkout last touched 36 hours ago read "36h"
//   in the Workspaces list and "1d" in Sessions; one touched 90 minutes ago
//   read "2h". The same checkout, two ages, and one of them older than true.
//
// Five of the nine also disagreed about the floor itself — "just now" under 45
// seconds, "now" under 5, "now" under 60 — which is the tell that nobody was
// copying from anybody. They each solved it fresh.

/** Prose ("3d ago") or compact ("3d"). */
export type AgeStyle = "prose" | "compact";

export type AgeOptions = {
  /** Pass `Date.now()` from the caller when several stamps render in one
   *  tick, so they can't disagree by a second. Defaults to now. */
  now?: number;
  style?: AgeStyle;
  /** What to print when the timestamp is missing or unparseable. Defaults to
   *  an empty string, which lets the caller omit the element entirely rather
   *  than print a placeholder next to a real value. */
  empty?: string;
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** The one ladder, from a delta already measured in seconds.
 *
 *  Rungs: just now · 42s · 9m · 3h · 5d · 3w · 7mo · 2y. Each rung hands over
 *  before its own unit reads absurd — days stop at a week rather than running
 *  to "412d", and weeks stop at five rather than colliding with months. */
export function relativeAgeFromDelta(
  secsAgo: number,
  opts: AgeOptions = {},
): string {
  const { style = "prose" } = opts;
  const suffix = style === "prose" ? " ago" : "";
  // A non-finite delta is an unknown age, not an enormous one. Without this,
  // NaN falls past every rung and prints "NaNy".
  const s = Number.isFinite(secsAgo) ? Math.max(0, Math.floor(secsAgo)) : 0;
  if (s < 5) return style === "prose" ? "just now" : "now";
  if (s < MINUTE) return `${s}s${suffix}`;
  if (s < HOUR) return `${Math.floor(s / MINUTE)}m${suffix}`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h${suffix}`;
  if (s < WEEK) return `${Math.floor(s / DAY)}d${suffix}`;
  if (s < MONTH) return `${Math.floor(s / WEEK)}w${suffix}`;
  if (s < YEAR) return `${Math.floor(s / MONTH)}mo${suffix}`;
  return `${Math.floor(s / YEAR)}y${suffix}`;
}

/** From epoch MILLISECONDS. */
export function relativeAge(ms: number, opts: AgeOptions = {}): string {
  if (!Number.isFinite(ms) || ms <= 0) return opts.empty ?? "";
  return relativeAgeFromDelta(((opts.now ?? Date.now()) - ms) / 1000, opts);
}

/** From epoch SECONDS — the shape most of our Rust commands return. */
export function relativeAgeFromSecs(
  unixSecs: number,
  opts: AgeOptions = {},
): string {
  if (!Number.isFinite(unixSecs) || unixSecs <= 0) return opts.empty ?? "";
  return relativeAge(unixSecs * 1000, opts);
}

/** From an epoch stamp that might be in SECONDS or in MILLISECONDS.
 *
 *  Not a convenience — a fact about our data. One component renders both:
 *  loop nodes stamp seconds, the goals ledger stamps millis, and the crew's
 *  task detail puts them on adjacent rows. Two files had already worked this
 *  out and hand-written the same test (crewShared, PrRightRail), which is
 *  precisely how a copy starts: a real need, met locally, twice.
 *
 *  The boundary is 1e12. Read as millis that is September 2001; read as
 *  seconds it is the year 33658. Every stamp we hold falls on one side or the
 *  other, so the test can only misread a seconds-epoch 31 millennia out, or a
 *  millis-epoch from before the iPod. Prefer the explicit `relativeAge` or
 *  `relativeAgeFromSecs` wherever the unit is actually known. */
export function relativeAgeAuto(
  unix: number | null | undefined,
  opts: AgeOptions = {},
): string {
  if (!unix || !Number.isFinite(unix) || unix <= 0) return opts.empty ?? "";
  return relativeAge(unix < 1e12 ? unix * 1000 : unix, opts);
}

/** From an ISO-8601 string — the shape the task board and PR APIs return.
 *  An unparseable string is an unknown time, not a zero one. */
export function relativeAgeFromIso(
  iso: string | null | undefined,
  opts: AgeOptions = {},
): string {
  if (!iso) return opts.empty ?? "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return opts.empty ?? "";
  return relativeAge(ms, opts);
}
