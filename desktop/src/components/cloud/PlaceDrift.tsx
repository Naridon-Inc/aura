// What this place has, against what the project asks it for.
//
// The surface for the oldest question in the trade — "it works on my machine" —
// and the reason it can be this small is that the diff is computed before it
// gets here. `lib/place/drift` already decided which lines block, which are
// merely undeclared and what the header says; this file only has to not bury
// them.
//
// So: no card, no panel of its own, no border. A label, a sentence, and one
// line per thing that is wrong — the same rows the sessions above it use, in
// the same type ladder. A machine that is short three tools should read as
// three lines you can take in on the way past, not as a report you open.
//
// Takes a `Place`, and there is nothing in here that asks which kind it is:
// this laptop answers the same question in the same words, which is the only
// way the comparison anybody actually wants — the box against the machine it
// works on — can ever be drawn.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  alsoHere,
  askDrift,
  blocking,
  driftHeadline,
  driftTone,
  met,
  standingWord,
  trustWarning,
  type Drift,
  type DriftItem,
  type DriftTone,
  type Place,
} from "../../lib/place";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { MENU_LABEL } from "../ui/menuSurface";

/** The accent a row carries. One decision, taken from the tone the library
 *  already assigned, so no second opinion about how bad `disputed` is can grow
 *  in a component. */
const TONE: Record<DriftTone, string> = {
  bad: "var(--color-red)",
  warn: "var(--color-amber)",
  ok: "var(--color-accent)",
  info: "var(--color-text-4)",
};

export function PlaceDrift({ place }: { place: Place }) {
  const [drift, setDrift] = useState<Drift | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(true);
  const [open, setOpen] = useState(false);

  // Asked once per place. Cheap by construction — `deps` is left off, so this
  // is a handful of `command -v` over one connection rather than a dependency
  // install, which is what makes it safe to ask on open.
  useEffect(() => {
    let live = true;
    setDrift(null);
    setError(null);
    setAsking(true);
    askDrift(place)
      .then((d) => {
        if (live) setDrift(d);
      })
      .catch((e: unknown) => {
        // "We couldn't ask" is not "nothing is wrong", and drawing an empty
        // report here would be the second thing worse than saying nothing.
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setAsking(false);
      });
    return () => {
      live = false;
    };
  }, [place.machineId, place.project.root]);

  if (asking && !drift) {
    return (
      <p className="flex items-center gap-1.5 px-2 py-1 text-xs text-text-5">
        <AsciiSpinner /> Checking what this machine has…
      </p>
    );
  }
  if (error) {
    return (
      <p className="px-2 py-1 text-xs" style={{ color: "var(--color-amber)" }}>
        Couldn’t ask this machine what it has — {error}
      </p>
    );
  }
  if (!drift) return null;

  const short = blocking(drift);
  const extra = alsoHere(drift);
  const here = met(drift);
  const warning = trustWarning(drift.trust);
  // Everything that isn't a gap, in the order it is worth reading: what nobody
  // declared first, because that is the half that explains a difference between
  // two places, then the quiet majority that is simply as asked.
  const rest = [...extra, ...here];

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between pr-1">
        <div className={MENU_LABEL}>What this machine has</div>
        {asking && <AsciiSpinner />}
      </div>

      <p className="px-2 pb-0.5 text-xs text-text-4">
        {driftHeadline(drift)}
        {drift.declares_environment && (
          <span className="text-text-5"> · {drift.spec_from}</span>
        )}
      </p>

      {/* An edited-since-sealed spec is not a footnote: its commands are the
          ones this place is about to run unattended. */}
      {warning && (
        <p className="px-2 pb-0.5 text-xs" style={{ color: "var(--color-amber)" }}>
          {warning}
        </p>
      )}

      {short.map((item) => (
        <Row key={item.id} item={item} />
      ))}

      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 px-2 py-0.5 text-left text-xs text-text-5 transition-colors hover:text-text-3"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {open
            ? "Hide what else is here"
            : extra.length > 0
              ? `${extra.length} here that nothing asked for, ${here.length} as asked`
              : `${here.length} as asked`}
        </button>
      )}

      {open && rest.map((item) => <Row key={item.id} item={item} />)}
    </div>
  );
}

/** One line of the diff.
 *
 *  Two lines only when there is something to do about it: the command that
 *  would close the gap gets its own monospace line, because a fix wrapped into
 *  prose is a fix nobody copies. */
function Row({ item }: { item: DriftItem }) {
  const colour = TONE[driftTone(item.standing)];
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 px-2 py-[1px] text-xs">
      <span
        aria-hidden
        className="h-1 w-1 flex-shrink-0 self-center rounded-full"
        style={{ background: colour }}
      />
      <span className="flex-shrink-0 text-text-2">{item.title}</span>
      <span className="flex-shrink-0" style={{ color: colour }}>
        {standingWord(item.standing)}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-5" title={item.detail}>
        {item.fix ? (
          <code className="font-mono text-text-4">{item.fix}</code>
        ) : (
          item.detail
        )}
      </span>
    </div>
  );
}
