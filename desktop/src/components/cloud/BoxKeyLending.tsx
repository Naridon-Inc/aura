// Whether this machine may use the key on your own computer.
//
// The one control in the machine panel that is a decision about trust rather
// than a decision about work, and the reason it is here rather than in the
// connect wizard: a wizard asks it while somebody is busy doing something
// else, gets a yes, and the machine keeps it forever. Asked on the place, it is
// asked about a machine the person is currently looking at.
//
// It starts off. Everything under the summary exists because "forward my ssh
// agent" is a sentence that means nothing to most people using Aura and the
// wrong thing to most of the rest — they picture the key being copied there.
// It isn't. What actually happens is narrower in one way and broader in
// another, and neither half can be left to be inferred.
//
// Not rendered at all for this laptop: work here already runs beside your key.

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, KeyRound } from "lucide-react";

import { api } from "../../lib/api";
import { agentLending, placeAddress, type Place } from "../../lib/place";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Switch } from "../ui/switch";

export function KeyLending({
  place,
  onError,
}: {
  place: Place;
  onError: (msg: string | null) => void;
}) {
  const machineId = placeAddress(place);
  // The book's row is what the panel was handed, and it is right until this
  // control changes it. After that the engine's answer is the authority — it is
  // the thing that also closed the connection.
  const [on, setOn] = useState(place.identity.forward_agent);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOn(place.identity.forward_agent);
    if (!machineId) return;
    let live = true;
    api
      .placeForwarding({ root: place.project.root, machineId })
      .then((f) => live && setOn(f.on))
      // A machine we can't reach still has a recorded decision, and the row we
      // were handed carries it. Nothing to correct.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [machineId, place.identity.forward_agent, place.project.root]);

  const lending = useMemo(
    () =>
      agentLending({
        ...place,
        identity: { ...place.identity, forward_agent: on },
      }),
    [place, on],
  );
  if (!lending.offered) return null;

  const decide = async (next: boolean) => {
    setBusy(true);
    onError(null);
    try {
      setOn((await api.placeForwardSet(machineId, next)).on);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="ui-cloud-row">
        <KeyRound size={14} />
        <strong>Your key</strong>
        {busy && <AsciiSpinner size={10} />}
        <Switch
          checked={on}
          disabled={busy}
          onCheckedChange={(next) => void decide(next)}
          aria-label={lending.action}
          title={lending.action}
        />
      </div>
      <p data-tone={on ? "warn" : undefined}>{lending.state}</p>
      {/* Folded, because it is three sentences somebody reads once and a line
          they read every time. Open before the first yes is a fair trade for
          never showing it again. */}
      <details className="ui-cloud-internal-details" open={!on}>
        <summary>
          <ChevronRight size={12} />
          What this lets {place.name.trim() || "that computer"} do
        </summary>
        <ul className="ui-box-list">
          {lending.grants.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
        <ul className="ui-box-list" data-tone="quiet">
          {lending.withholds.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
