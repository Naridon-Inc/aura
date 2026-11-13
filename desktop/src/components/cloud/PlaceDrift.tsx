// What this place has, against what the project asks it for.
//
// The surface for the oldest question in the trade — "it works on my machine" —
// and the reason it can be this small is that the diff is computed before it
// gets here. `lib/place/drift` already decided which lines block, which are
// merely undeclared and what the header says; this file only has to not bury
// them.
//
// So: no card, no panel of its own. A label, a sentence, and one line per
// thing that is wrong, in the machine panel's own type ladder. A machine that
// is short three tools should read as three lines you can take in on the way
// past, not as a report you open.
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
  type Place,
} from "../../lib/place";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";

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
      <p className="ui-box-asking">
        <AsciiSpinner size={10} /> Checking what this machine has…
      </p>
    );
  }
  if (error) {
    return <p data-tone="warn">Couldn’t ask this machine what it has — {error}</p>;
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
    <div className="ui-box-facts-block">
      <div className="ui-cloud-row">
        <strong>What this machine has</strong>
        {asking && <AsciiSpinner size={10} />}
      </div>

      <p>
        {driftHeadline(drift)}
        {drift.declares_environment && <span> · {drift.spec_from}</span>}
      </p>

      {/* An edited-since-sealed spec is not a footnote: its commands are the
          ones this place is about to run unattended. */}
      {warning && <p data-tone="warn">{warning}</p>}

      {short.length > 0 && (
        <ul className="ui-box-facts">
          {short.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      )}

      {rest.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="ui-box-facts-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          {open
            ? "Hide what else is here"
            : extra.length > 0
              ? `${extra.length} here that nothing asked for, ${here.length} as asked`
              : `${here.length} as asked`}
        </Button>
      )}

      {open && (
        <ul className="ui-box-facts">
          {rest.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One line of the diff.
 *
 *  The command that would close the gap is set in monospace, because a fix
 *  wrapped into prose is a fix nobody copies. The tone is the one the library
 *  already assigned, so no second opinion about how bad `disputed` is can grow
 *  in a component. */
function Row({ item }: { item: DriftItem }) {
  return (
    <li data-tone={driftTone(item.standing)}>
      <span aria-hidden className="ui-box-fact-dot" />
      <span className="ui-box-fact-title">{item.title}</span>
      <span className="ui-box-fact-word">{standingWord(item.standing)}</span>
      <span className="ui-box-fact-detail" title={item.detail}>
        {item.fix ? <code>{item.fix}</code> : item.detail}
      </span>
    </li>
  );
}
