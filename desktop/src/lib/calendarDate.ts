// A date on the calendar — one way of writing one, for the whole app.
//
// This is the other half of lib/relativeTime. That module answers "how long
// ago", and every ladder in the app hands over to a date once "ago" stops
// being useful. What it handed over to was written eight different ways:
//
//   Jul 31            eight files
//   Jul 31, 2026      three files
//   Jul 31, 26        one file
//   July 31           two files
//   July 31, 2026     two files
//   7/31/2026         seven files — a bare toLocaleDateString(), which is
//                     whatever the OS locale says and appears nowhere else
//                     in the interface
//
// The seven bare ones are the visible bug: a commit older than a month, a
// session older than a week, an installed mode and a goal's delivering run
// all switch to a format the app never otherwise uses.
//
// The year is the real one. Eight files print "Jul 31" with no year at all,
// so a task due last July and a task due this July read identically — and
// these are surfaces (a commit list, a task board, a goal ledger) whose whole
// job is telling you when something happened. Three others print the year
// always, including on something from this morning.
//
// Two authors had already worked out the answer, separately, in their own
// file: show the year only when it isn't this year. Nobody else found out.
// That rule lives here now.
//
//   today          → "Jul 31"
//   last November  → "Nov 12"          (same year)
//   two years ago  → "Jun 4, 2024"
//
// A clock time is a different question and lives in lib/clockTime. A precise
// instant in a log — the full date and the seconds — is a third, and stays
// with the log that wants it.

export type DateLabelOptions = {
  /** Pass one `Date.now()` when several stamps render in a tick, so two rows
   *  can't disagree about which year is "this" one. */
  now?: number;
  /** Lead with the day of the week — for a divider heading a day's worth of
   *  messages, where "Thursday" is what the reader is actually scanning for. */
  weekday?: "short" | "long";
  /** What an absent or unparseable stamp prints. Empty by default, so a caller
   *  can drop the element rather than print a placeholder beside real dates. */
  empty?: string;
};

function parts(
  ms: number,
  month: "short" | "long",
  opts: DateLabelOptions,
): Intl.DateTimeFormatOptions {
  const d = new Date(ms);
  const thisYear = new Date(opts.now ?? Date.now()).getFullYear();
  return {
    weekday: opts.weekday,
    month,
    day: "numeric",
    // The one decision this module exists to make.
    year: d.getFullYear() === thisYear ? undefined : "numeric",
  };
}

function format(
  ms: number,
  month: "short" | "long",
  opts: DateLabelOptions,
): string {
  if (!Number.isFinite(ms)) return opts.empty ?? "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return opts.empty ?? "";
  return d.toLocaleDateString(undefined, parts(ms, month, opts));
}

/** "Jul 31" — the app's date. From epoch MILLISECONDS. */
export function shortDate(ms: number, opts: DateLabelOptions = {}): string {
  return format(ms, "short", opts);
}

/** From epoch SECONDS — the shape most of our Rust commands return. */
export function shortDateFromSecs(
  unixSecs: number,
  opts: DateLabelOptions = {},
): string {
  if (!Number.isFinite(unixSecs) || unixSecs <= 0) return opts.empty ?? "";
  return shortDate(unixSecs * 1000, opts);
}

/** "July 31" — for a divider or a details row, where the date is the line
 *  rather than a stamp at the end of one. From epoch MILLISECONDS. */
export function longDate(ms: number, opts: DateLabelOptions = {}): string {
  return format(ms, "long", opts);
}
