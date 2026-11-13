// What an agent started here will be able to reach — before it is started.
//
// A run has two phases and they get different networks. Setup installs, with
// everything, because a list that has to contain whatever `npm ci` reaches is
// not a list. The agent phase — the half nobody is watching — is default-deny
// with an allowlist, and that split is what bounds what a prompt injection can
// actually carry out: reading a token is only worth doing if there is somewhere
// to send it.
//
// Shown here rather than after the fact for the same reason the drift report is:
// this is the sentence that changes what somebody does next. Afterwards it is a
// transcript. `lib/place/egress` already decided the tone, the headline and the
// order of the rows; this file only has to not bury them.
//
// Takes a `Place`, and nothing in here asks which kind it is. A wall that exists
// on a box and not on a laptop is the same feature as no wall — the agent
// anybody runs unattended is the one on their own machine at 2am.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  askAgentPhase,
  egressHeadline,
  egressTone,
  endpointLabel,
  listed,
  reasonWord,
  type AgentPhase,
  type Allowed,
  type EgressTone,
  type Place,
} from "../../lib/place";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";

/** The accent the headline carries.
 *
 *  Three, not two. `unsealed` is amber because the run WORKS — with less than
 *  the project asked for — and drawn as either green or red it is read wrong
 *  both ways. `open` is the one that matters most: a machine holding nobody to
 *  anything, which a panel showing a list would otherwise imply it was. */
const TONE: Record<EgressTone, "ok" | "warn" | "bad"> = {
  held: "ok",
  unsealed: "warn",
  open: "bad",
};

/** The dot beside one row, by why that row is on the list. What the project
 *  chose is the half worth auditing; the floor is not news. */
const REASON_TONE: Record<Allowed["reason"], "ok" | "info"> = {
  declared: "ok",
  remote: "info",
  model: "info",
};

export function PlaceEgress({ place, bin }: { place: Place; bin: string }) {
  const [plan, setPlan] = useState<AgentPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(true);
  const [open, setOpen] = useState(false);

  // Asked once per place and agent. The floor depends on which agent: `claude`
  // cannot work without api.anthropic.com and `codex` cannot work without
  // api.openai.com, so a plan drawn for the wrong one is a plan for a different
  // run.
  useEffect(() => {
    let live = true;
    setPlan(null);
    setError(null);
    setAsking(true);
    askAgentPhase(place, bin)
      .then((p) => {
        if (live) setPlan(p);
      })
      .catch((e: unknown) => {
        // "We couldn't ask" is not "it reaches nothing". Drawing an empty
        // allowlist here would be claiming a wall nobody has checked for.
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setAsking(false);
      });
    return () => {
      live = false;
    };
  }, [place.machineId, place.project.root, bin]);

  if (asking && !plan) {
    return (
      <p className="ui-box-asking">
        <AsciiSpinner size={10} /> Working out what an agent here could reach…
      </p>
    );
  }
  if (error) {
    return <p data-tone="warn">Couldn’t work out this place’s allowlist — {error}</p>;
  }
  if (!plan) return null;

  const rows = listed(plan);

  return (
    <div className="ui-box-facts-block">
      <div className="ui-cloud-row">
        <strong>What an agent here can reach</strong>
        {asking && <AsciiSpinner size={10} />}
      </div>

      <p data-tone={TONE[egressTone(plan)]}>{egressHeadline(plan)}</p>

      {/* The note always says something true and actionable — which wall is
          holding it, or exactly why nothing is. It is the whole answer when a
          machine can hold no wall, so it is never behind a disclosure. */}
      <p>{plan.note}</p>

      {rows.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="ui-box-facts-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          {open ? "Hide the list" : `Show all ${rows.length}`}
        </Button>
      )}

      {open && (
        <ul className="ui-box-facts">
          {rows.map((row) => (
            <Row key={`${row.endpoint.host}:${row.endpoint.port}`} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One machine on the list, and why it is on it.
 *
 *  The port is never elided, even when it is 443: the same host on 22 and on 443
 *  are two different permissions, and a list somebody can sign off on without
 *  having read it is not doing the job. */
function Row({ row }: { row: Allowed }) {
  return (
    <li data-tone={REASON_TONE[row.reason]}>
      <span aria-hidden className="ui-box-fact-dot" />
      <code className="ui-box-fact-title">{endpointLabel(row.endpoint)}</code>
      <span className="ui-box-fact-detail">{reasonWord(row.reason)}</span>
    </li>
  );
}
