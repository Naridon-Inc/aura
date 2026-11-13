// Start a shell or an agent, in a project on the box.
//
// The project is picked from what the machine actually has rather than typed,
// because a path that doesn't exist over there fails after the connection
// rather than before it — a spinner, then a shell in the home directory, and no
// clue which of the two things you got.

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";

import {
  api,
  type BoxProject,
  type BoxSession,
  type PlaceProjects,
} from "../../lib/api";
import {
  askAgentKey,
  askCapabilities,
  howToRunOnMyOwn,
  isUnnarrowed,
  keySentence,
  keyTone,
  offerableAgents,
  placeAddress,
  projectsNotice,
  resolveSelectedAgent,
  whyNotMyKey,
  withheldProjects,
  type KeyPlan,
  type Place,
  type PlaceCapabilities,
} from "../../lib/place";
import { AgentIcon } from "../agent/AgentIcon";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { PlaceEgress } from "./PlaceEgress";

export function StartSomething({
  place,
  projects,
  offered,
  onStarted,
  onError,
}: {
  place: Place;
  projects: BoxProject[] | null;
  /** The same answer whole, for the sentence under the picker. A dropdown that
   *  is shorter than the machine, with nothing said, is the one thing this
   *  surface must not be: the person using it put those repos there. */
  offered: PlaceProjects;
  onStarted: (s: BoxSession) => void;
  onError: (msg: string | null) => void;
}) {
  const machineId = placeAddress(place);
  const [project, setProject] = useState("");
  const [kind, setKind] = useState<"shell" | "agent">("agent");
  const [agent, setAgent] = useState("claude");
  const [branch, setBranch] = useState("");
  const [task, setTask] = useState("");
  const [starting, setStarting] = useState(false);
  // What THIS place can run. `null` = not asked yet / probe failed / place
  // unreachable → offer the full set, because we-don't-know is not it-has-none.
  const [capabilities, setCapabilities] = useState<PlaceCapabilities | null>(
    null,
  );

  // Ask the place what it has, once per place, so the picker offers what will
  // run over there instead of the six we imagine every box holds. Best-effort:
  // a failed probe leaves it null — NOT an empty capabilities, which would be
  // the place saying it has nothing — and the session start still says plainly
  // if a pick isn't installed.
  useEffect(() => {
    let alive = true;
    setCapabilities(null);
    void askCapabilities(place)
      .then((caps) => {
        if (alive) setCapabilities(caps);
      })
      .catch(() => {
        /* unreachable / probe blip — leave null so we offer the full set */
      });
    return () => {
      alive = false;
    };
  }, [machineId, place.project.root]);

  // The agents to offer, and a selection kept valid as that set resolves.
  const offerable = useMemo(
    () => offerableAgents(capabilities),
    [capabilities],
  );
  useEffect(() => {
    setAgent((cur) => resolveSelectedAgent(cur, offerable));
  }, [offerable]);

  // The first project is a reasonable default only because the list is the
  // box's own; picking for someone out of a list we invented would be worse
  // than making them choose.
  const chosen = project || projects?.[0]?.path || "";

  const start = useCallback(async () => {
    if (!chosen) return;
    setStarting(true);
    onError(null);
    try {
      const s = await api.boxStart(machineId, {
        project: chosen,
        kind,
        agent: kind === "agent" ? agent : null,
        branch: branch.trim() || null,
        // What it is for is also what to call it. A tab reading "Fix the login
        // redirect" is worth more than one reading `aura-agent-naridon-3f1c`,
        // and this is the only moment anyone knows the answer.
        title: kind === "agent" ? task.trim() || null : null,
        prompt: kind === "agent" ? task.trim() || null : null,
      });
      setBranch("");
      setTask("");
      onStarted(s);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [machineId, chosen, kind, agent, branch, task, onStarted, onError]);

  const heading = (
    <div className="ui-cloud-row">
      <strong>Start something</strong>
    </div>
  );

  if (projects !== null && projects.length === 0) {
    return (
      <>
        {heading}
        <p>
          {/* "No projects" and "none of this machine's projects are yours"
              are opposite facts that look identical, and only one of them is
              answered by cloning something. */}
          {offered.withheld.length > 0
            ? "None of the repositories on this machine belong to the org you’re in. Put one there below and it shows up here."
            : "This machine has no repositories on it yet. Put one there below and it shows up here."}
        </p>
        <WithheldNote offered={offered} />
      </>
    );
  }

  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !starting) void start();
  };

  return (
    <>
      {heading}
      <div className="ui-box-form">
        <Select
          value={chosen}
          onChange={setProject}
          disabled={projects === null}
          placeholder={projects === null ? "Reading repositories…" : "Pick a repository"}
          aria-label="Repository on the machine"
          options={(projects ?? []).map((p) => ({
            value: p.path,
            label: (
              <span className="ui-box-repo">
                <span>{p.name}</span>
                {p.branch && <small>{p.branch}</small>}
                {p.dirty > 0 && <small data-tone="warn">{p.dirty} uncommitted</small>}
              </span>
            ),
          }))}
        />

        <WithheldNote offered={offered} />

        <div className="ui-cloud-segments" role="group" aria-label="What to start">
          {(["agent", "shell"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
            >
              {k === "agent" ? "Agent" : "Shell"}
            </button>
          ))}
        </div>

        {kind === "agent" &&
          (offerable.length > 0 ? (
            <Select
              value={agent}
              onChange={setAgent}
              aria-label="Which agent to run"
              options={offerable.map((a) => ({
                value: a.id,
                label: a.label,
                icon: <AgentIcon agentId={a.id} label={a.label} size={14} />,
              }))}
            />
          ) : (
            // Probed and the box has none. Say so plainly rather than offer a
            // list every pick of which would fail at start.
            <p className="ui-cloud-note">
              No coding-agent CLIs installed on this machine
            </p>
          ))}

        {/* Whose key the run will spend, before it spends it. Beside the picker
            rather than in a settings pane, because the credential follows from
            which engine was just chosen and the moment to know it is now. */}
        {kind === "agent" && agent.trim() !== "" && (
          <AgentKeyLine place={place} engine={agent} />
        )}

        {/* Honest about where these run: once the box has answered, the list is
            what IT has, not what this laptop holds. Silent before the probe
            lands (we're optimistically showing the full set) and when the box
            couldn't be reached. */}
        {kind === "agent" && capabilities !== null && offerable.length > 0 && (
          <p className="ui-cloud-note">
            Only the agents installed on this machine are shown — they run there,
            not on your laptop.
          </p>
        )}

        {/* What that agent will be able to reach while it works, before it is
            started. Only for an agent, and that is the split rather than an
            omission: a shell is a person at a keyboard, and confining one would
            be a different feature with a different argument. */}
        {kind === "agent" && offerable.length > 0 && (
          <PlaceEgress place={place} bin={agent} />
        )}

        {/* The piece of work itself. A box that can only be handed a shell is
            a box you have to sit with; typing the job here means the agent is
            already on it before you have finished switching windows, and can
            still be on it tomorrow. Optional on purpose — plenty of the time
            you want the agent open and waiting, and inventing an instruction
            for someone would be worse than leaving it blank. */}
        {kind === "agent" && (
          <Input
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={enter}
            placeholder="What should it work on? (optional)"
            aria-label="What the agent should work on"
          />
        )}

        {/* Its own branch means its own worktree over there. Two agents in one
            checkout is not parallelism, it's a merge conflict with extra
            steps — so this is offered rather than buried, and blank is a real
            answer for work you want in the main checkout. */}
        <Input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={enter}
          placeholder="Its own branch (optional)"
          aria-label="Branch to start it on"
          className="ui-box-mono"
        />

        <div className="ui-cloud-inline">
          <Button
            size="sm"
            disabled={!chosen || starting || (kind === "agent" && !agent)}
            onClick={() => void start()}
          >
            {starting ? (
              <>
                <AsciiSpinner size={10} /> Starting on the machine…
              </>
            ) : (
              <>
                <Plus />
                {kind === "agent" && task.trim() ? "Put it to work" : "Start there"}
              </>
            )}
          </Button>
        </div>
      </div>
    </>
  );
}

/** Whose key this agent run will spend, before it spends it.
 *
 *  The sibling of the clone form's push-credential line and the more expensive
 *  of the two: a push spends a name, a run spends tokens. On a shared box every
 *  agent has been running on one key — `/etc/aura-runner/agent.env`, or the
 *  org's own `anthropic_api_key` — so the bill was real and the attribution was
 *  not. That still works, and on a team that pays centrally it is the right
 *  answer; it is no longer allowed to be silent.
 *
 *  Amber only when the credential is somebody else's, and then with the reasons —
 *  which are also the instructions for having your own. Takes a `Place`, so this
 *  laptop is asked the same question in the same words. */
function AgentKeyLine({ place, engine }: { place: Place; engine: string }) {
  const [plan, setPlan] = useState<KeyPlan | null>(null);

  useEffect(() => {
    const bin = engine.trim();
    if (!bin) {
      setPlan(null);
      return;
    }
    let live = true;
    // Switching agents in the picker is a click at a time, and each one would
    // otherwise be a round trip to a box across an ocean.
    const t = setTimeout(() => {
      askAgentKey(place, bin)
        // A place we can't reach has no answer about credentials, and guessing
        // one would be a sentence about somebody's money that nothing checked.
        .then((p) => live && setPlan(p))
        .catch(() => live && setPlan(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [place, engine]);

  if (!plan) return null;
  const tone = keyTone(plan);
  return (
    <p
      className="ui-box-credential"
      data-tone={tone === "shared" ? "warn" : undefined}
    >
      {keySentence(plan)}
      {tone === "shared" && (
        <>
          {whyNotMyKey(plan).map((why) => (
            <span key={why}>{why}</span>
          ))}
          <span>{howToRunOnMyOwn(plan)}</span>
        </>
      )}
    </p>
  );
}

/** Why the picker is shorter than the machine.
 *
 *  A box discovers projects box-wide, and on a shared runner that means two
 *  orgs' work in one listing — so the list is narrowed to the org you opened the
 *  place as. Saying nothing about it would be the worst version of this feature:
 *  the person looking at the dropdown is precisely the person who cloned the
 *  missing repo, and a silently shorter list reads as a box that lost it.
 *
 *  Two different sentences, deliberately. A clean filter is ordinary and gets
 *  the quiet colour with the reasons folded behind a summary line; "showing
 *  everything because we couldn't reach your org" is a warning that the list is
 *  WIDER than asked for, and it gets amber — the answer to that one is to try
 *  again, not to go looking for missing repos. */
function WithheldNote({ offered }: { offered: PlaceProjects }) {
  const notice = projectsNotice(offered);
  if (!notice) return null;
  if (isUnnarrowed(offered)) {
    return <p data-tone="warn">{notice}</p>;
  }
  return (
    <details className="ui-box-withheld">
      <summary>{notice}</summary>
      <ul className="ui-box-list">
        {withheldProjects(offered).map((w) => (
          <li key={w.path}>
            <span>{w.name}</span> — {w.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}
