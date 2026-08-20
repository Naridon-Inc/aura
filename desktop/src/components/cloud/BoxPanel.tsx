// What's running on the box, and how to start something else.
//
// A machine is not one project with one shell. It is a box with clones of
// several repos on it and any number of sessions working in them — some started
// by this window, some by yesterday's laptop, some by a teammate who is still
// attached right now. The workspace used to be able to see none of that: every
// tab it opened was invented locally, landed in one saved directory, and left
// no trace anything else could find.
//
// So this panel is the box's own answer to both questions. The top half is read
// off the machine — click a row and you are sitting in front of work already
// under way. The bottom half starts something new, in a project you pick, on
// its own branch if you want two agents in one repo not to edit the same files
// underneath each other.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Eye,
  GitBranch,
  KeyRound,
  Plus,
  Terminal as TerminalIcon,
  Users,
} from "lucide-react";

import {
  api,
  type BoxProject,
  type BoxSession,
  type Machine,
  type PlaceProjects,
} from "../../lib/api";
import {
  agentLending,
  askAgentKey,
  askCapabilities,
  askPushCredential,
  asleepFor,
  credentialSentence,
  credentialTone,
  howToRunOnMyOwn,
  isAsleep,
  isUnnarrowed,
  keySentence,
  keyTone,
  offerableAgents,
  placeAddress,
  projectsNotice,
  resolveSelectedAgent,
  runningLate,
  sleepingInsteadOfError,
  startsItselfLine,
  wakeHeadline,
  wakeProgress,
  whyNotMine,
  whyNotMyKey,
  withheldProjects,
  type KeyPlan,
  type Place,
  type PlaceCapabilities,
  type PushPlan,
} from "../../lib/place";
import { AgentIcon } from "../agent/AgentIcon";
import { useWaking } from "./useWaking";
import { PlaceDrift } from "./PlaceDrift";
import { PlaceEgress } from "./PlaceEgress";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { SegmentedControl } from "../ui/segmented";
import {
  MENU_LABEL,
  MENU_PANEL,
  MENU_ROW,
  MENU_SEP,
} from "../ui/menuSurface";
import {
  groupByProject,
  sessionLabel,
  sinceWords,
  type BoxState,
} from "./useBox";

export function BoxPanel({
  place,
  box,
  openSessions,
  onAttach,
  onWoke,
  onClose,
}: {
  /** The place this panel is about. Not a bare machine id: everything below —
   *  what is running, what can be started, which agents are installed — is a
   *  question about a place, and the panel that can only be handed a box is the
   *  panel that will need rewriting the day there is another kind. */
  place: Place;
  box: BoxState;
  /** Session names already open as tabs here, so the list can say "open"
   *  instead of offering to open a second view of the same thing. */
  openSessions: string[];
  /** `readOnly` joins without taking the keyboard — the difference between
   *  looking over someone's shoulder and reaching past them for it. */
  onAttach: (session: BoxSession, opts?: { readOnly?: boolean }) => void;
  /** The book row after this place was started again. A machine that was
   *  stopped comes back on a new address, so waking it is not a flag flip and
   *  the caller has to be given the row rather than told "it's up now". */
  onWoke?: (machine: Machine) => void;
  onClose: () => void;
}) {
  const { sessions, projects, offered, error, reading, refresh } = box;
  // The session verbs name a machine, and rightly: there is no session to list
  // or stop on a place with no address.
  const machineId = placeAddress(place);
  const [busy, setBusy] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // Stopping ends whatever an agent was in the middle of, so it arms before it
  // fires. A confirm dialog for this would be heavier than the action deserves;
  // a row that changes its word once is enough to stop a mis-click.
  const [armed, setArmed] = useState<string | null>(null);

  const now = Date.now();
  const open = useMemo(() => new Set(openSessions), [openSessions]);

  const grouped = useMemo(() => groupByProject(sessions ?? []), [sessions]);

  const stop = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        await api.boxStop(machineId, name);
        refresh();
      } catch (e) {
        setStartError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        setArmed(null);
      }
    },
    [machineId, refresh],
  );

  // Aura stopped this machine because nobody was using it. Asked of the place
  // rather than of the read below, because the read is the thing that cannot
  // tell: a stopped box refuses connections exactly the way a broken one does.
  const asleep = isAsleep(place);
  // Bumped whenever this panel does something that changes whether a wake is in
  // the air, so the watch below re-reads at once instead of up to a second
  // later. The gap between pressing a button and the screen admitting it heard
  // you is the gap in which somebody presses it again.
  const [nudge, setNudge] = useState(0);
  // Asked rather than remembered, because the wake may not be ours: anything
  // that reaches this place starts it, and four of the five callers on one wake
  // never pressed anything. A panel that only knew about its own button would
  // sit on "Asleep" over a machine that is visibly booting.
  const waking = useWaking(machineId, nudge);
  const starting = waking?.state === "waking";
  const [wakeError, setWakeError] = useState<string | null>(null);

  const wake = useCallback(async () => {
    setWakeError(null);
    setNudge((n) => n + 1);
    try {
      await api.placeWake(machineId);
      // Then re-read the book, and hand the whole row up. A machine that was
      // stopped comes back on a different address — the provider hands out a
      // new one on start — so the caller has to replace the row it is holding
      // rather than assume the one on screen is still dialable.
      const woken = (await api.machinesList()).find((m) => m.id === machineId);
      if (woken) onWoke?.(woken);
      refresh();
    } catch (e) {
      setWakeError(e instanceof Error ? e.message : String(e));
    } finally {
      setNudge((n) => n + 1);
    }
  }, [machineId, onWoke, refresh]);

  return (
    <div
      className={`${MENU_PANEL} absolute left-2 top-full mt-1 flex max-h-[30rem] w-[26rem] flex-col overflow-y-auto`}
    >
      {/* Running now ------------------------------------------------------ */}
      <div className="flex items-center justify-between pr-1">
        <div className={MENU_LABEL}>Running on this machine</div>
        {reading && sessions !== null && <AsciiSpinner />}
      </div>

      {/* Asleep is asked FIRST, ahead of every other state. This branch is the
          whole reason the book carries a sleep stamp: a stopped machine cannot
          be asked anything, so every reading below — the error, the spinner,
          the empty list — would describe a box that is working exactly as
          intended in the words of one that isn't. */}
      {asleep || starting ? (
        <div className="flex flex-col gap-1.5 px-2 pb-1.5">
          {starting && waking ? (
            /* The wait, said out loud. A minute of nothing is
               indistinguishable from a hang, and both things somebody does
               about a hang — press it again, or go looking for support — are
               wrong here. So: what is happening, how far through the usual
               wait it is, and, once it runs past that, the fact that it has —
               still not as a fault. */
            <>
              <p className="flex items-start gap-1.5 text-xs text-text-4">
                <span className="pt-px">
                  <AsciiSpinner />
                </span>
                <span>{wakeHeadline(waking, now)}</span>
              </p>
              <div className="h-0.5 w-full overflow-hidden rounded-full bg-bg-3">
                <div
                  className="h-full rounded-full transition-[width] duration-1000 ease-linear"
                  style={{
                    width: `${Math.round(wakeProgress(waking, now) * 100)}%`,
                    // Grey once it is over, not amber. The bar has run out of
                    // estimate, which is not the same as anything being wrong,
                    // and a colour that says "wrong" here teaches people to
                    // distrust a feature that works.
                    background: runningLate(waking, now)
                      ? "var(--color-text-5)"
                      : "var(--color-accent)",
                  }}
                />
              </div>
            </>
          ) : (
            <>
              {/* "Using it starts it" when reaching it would, which is the
                  sentence that turns asleep from a thing to press a button
                  about into a thing to ignore. The plain version is the
                  fallback for a box Aura cannot start, and for the moment
                  before the first read lands. */}
              <p className="text-xs text-text-4">
                {(waking && startsItselfLine(waking)) ||
                  sleepingInsteadOfError(place)}
              </p>
              <p className="text-xs text-text-5">
                Aura stopped it because nobody was using it
                {asleepFor(place, now) ? ` ${asleepFor(place, now)} ago` : ""},
                so it isn’t costing anything while it’s off.
              </p>
              {wakeError && (
                <p className="text-xs" style={{ color: "var(--color-amber)" }}>
                  Couldn’t start it again — {wakeError}
                </p>
              )}
              {/* Still offered, even though opening anything here would do it.
                  Someone who is about to work on this box would rather spend
                  the minute now than inside their first command. */}
              <div>
                <Button size="sm" onClick={() => void wake()}>
                  Wake it up
                </Button>
              </div>
            </>
          )}
        </div>
      ) : error ? (
        <p className="px-2 pb-1.5 text-xs" style={{ color: "var(--color-amber)" }}>
          Couldn’t ask the machine what it’s running — {error}
        </p>
      ) : sessions === null ? (
        <p className="flex items-center gap-1.5 px-2 pb-1.5 text-xs text-text-5">
          <AsciiSpinner /> Asking the machine…
        </p>
      ) : sessions.length === 0 ? (
        <p className="px-2 pb-1.5 text-xs text-text-5">
          Nothing running there yet. Anything you start below keeps running when
          you close this window.
        </p>
      ) : (
        grouped.map(([project, rows]) => (
          <div key={project} className="flex flex-col">
            <div className="px-2 pb-0.5 pt-1 text-xs text-text-4">{project}</div>
            {rows.map((s) => {
              const isOpen = open.has(s.name);
              return (
                <div key={s.name} className="group flex items-stretch gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onAttach(s);
                      onClose();
                    }}
                    className={`${MENU_ROW} min-w-0 flex-1`}
                  >
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                      {s.agent ? (
                        <AgentIcon
                          agentId={s.agent}
                          label={s.agent}
                          size={14}
                        />
                      ) : (
                        <TerminalIcon size={13} />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm leading-tight">
                        {sessionLabel(s)}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-4">
                        {s.branch && (
                          <span className="flex min-w-0 items-center gap-0.5">
                            <GitBranch size={10} />
                            <span className="truncate">{s.branch}</span>
                          </span>
                        )}
                        {/* Two clients on one session means somebody else is
                            in here with you — the one fact about a shared box
                            you cannot afford to find out by typing. */}
                        {s.attached > 1 && (
                          <span
                            className="flex items-center gap-0.5"
                            style={{ color: "var(--color-accent)" }}
                          >
                            <Users size={10} />
                            {s.attached} watching
                          </span>
                        )}
                        <span>{sinceWords(s.activity_at, now)}</span>
                        {isOpen && <span>· open here</span>}
                      </span>
                    </span>
                  </button>
                  {/* Joining a session someone is driving means sharing their
                      keyboard: tmux gives every client the same pane, so a
                      stray keystroke of yours lands in their agent. Watching
                      attaches read-only, which is what you nearly always want
                      when the answer to "what is it doing" is the question. */}
                  <button
                    type="button"
                    onClick={() => {
                      onAttach(s, { readOnly: true });
                      onClose();
                    }}
                    title="Watch without typing — the session can't hear your keyboard"
                    className="flex-shrink-0 self-center rounded-md px-1.5 py-1 text-text-4 opacity-0 transition-opacity hover:text-text-1 group-hover:opacity-100"
                  >
                    <Eye size={13} />
                  </button>
                  <button
                    type="button"
                    disabled={busy === s.name}
                    onClick={() =>
                      armed === s.name ? void stop(s.name) : setArmed(s.name)
                    }
                    onBlur={() => setArmed((a) => (a === s.name ? null : a))}
                    title="End this session on the machine"
                    className={`flex-shrink-0 self-center rounded-md px-2 py-1 text-xs transition-opacity ${
                      armed === s.name
                        ? "text-red opacity-100"
                        : "text-text-4 opacity-0 hover:text-text-1 group-hover:opacity-100"
                    }`}
                  >
                    {busy === s.name ? (
                      <AsciiSpinner />
                    ) : armed === s.name ? (
                      "Stop?"
                    ) : (
                      "Stop"
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ))
      )}

      {/* Everything below here reaches the machine — what it is missing, what
          it can start, which projects it holds, whose key it may borrow. On a
          sleeping box each of those would time out and report a failure, and
          five failures underneath one "asleep" line is how a stopped machine
          comes to look broken anyway. Waking it is the one action on offer,
          and it is above; the rest comes back with the box.

          `starting` holds the same line through the minute the box takes to
          come up. A machine mid-boot refuses connections exactly as a stopped
          one does, so drawing these reads the moment a wake begins would spend
          that minute filling the panel with failures about a machine that is
          on its way. */}
      {!asleep && !starting && (
        <>
          <div className={MENU_SEP} />

          {/* Why the thing that works here doesn't work there. Above the start
              controls on purpose: a place three tools short is the reason the
              agent you are about to start will fail, and after the fact it is a
              transcript to read rather than a line to have seen. */}
          <PlaceDrift place={place} />

          <div className={MENU_SEP} />

          <StartSomething
            place={place}
            projects={projects}
            offered={offered}
            onStarted={(s) => {
              refresh();
              onAttach(s);
              onClose();
            }}
            onError={setStartError}
          />

          <div className={MENU_SEP} />

          <AddProject
            place={place}
            onStarted={(s) => {
              refresh();
              onAttach(s);
              onClose();
            }}
            onError={setStartError}
          />

          <div className={MENU_SEP} />

          <KeyLending place={place} onError={setStartError} />

          {startError && (
            <p className="px-2 pb-1 text-xs" style={{ color: "var(--color-red)" }}>
              {startError}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Start a shell or an agent, in a project on the box.
 *
 *  The project is picked from what the machine actually has rather than typed,
 *  because a path that doesn't exist over there fails after the connection
 *  rather than before it — a spinner, then a shell in the home directory, and no
 *  clue which of the two things you got. */
function StartSomething({
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

  if (projects !== null && projects.length === 0) {
    return (
      <>
        <div className={MENU_LABEL}>Start something</div>
        <p className="px-2 pb-1.5 text-xs text-text-5">
          {/* "No projects" and "none of this machine's projects are yours"
              are opposite facts that look identical, and only one of them is
              answered by cloning something. */}
          {offered.withheld.length > 0
            ? "None of the projects on this machine belong to the org you’re in. Put one there below and it shows up here."
            : "This machine has no projects on it yet. Put one there below and it shows up here."}
        </p>
        <div className="px-2 pb-1.5">
          <WithheldNote offered={offered} />
        </div>
      </>
    );
  }

  return (
    <>
      <div className={MENU_LABEL}>Start something</div>
      <div className="flex flex-col gap-1.5 px-2 pb-1.5">
        <Select
          value={chosen}
          onChange={setProject}
          disabled={projects === null}
          placeholder={projects === null ? "Reading projects…" : "Pick a project"}
          aria-label="Project on the machine"
          options={(projects ?? []).map((p) => ({
            value: p.path,
            label: (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{p.name}</span>
                {p.branch && (
                  <span className="truncate text-xs text-text-4">
                    {p.branch}
                  </span>
                )}
                {p.dirty > 0 && (
                  <span className="text-xs" style={{ color: "var(--color-amber)" }}>
                    {p.dirty} uncommitted
                  </span>
                )}
              </span>
            ),
          }))}
        />

        <WithheldNote offered={offered} />

        <div className="flex items-center gap-1.5">
          <SegmentedControl<"shell" | "agent">
            value={kind}
            onChange={setKind}
            ariaLabel="What to start"
            options={[
              { value: "agent", label: "Agent" },
              { value: "shell", label: "Shell" },
            ]}
          />
          {kind === "agent" &&
            (offerable.length > 0 ? (
              <Select
                value={agent}
                onChange={setAgent}
                aria-label="Which agent to run"
                className="flex-1"
                options={offerable.map((a) => ({
                  value: a.id,
                  label: a.label,
                  icon: <AgentIcon agentId={a.id} label={a.label} size={14} />,
                }))}
              />
            ) : (
              // Probed and the box has none. Say so plainly rather than offer a
              // list every pick of which would fail at start.
              <span className="flex-1 px-1 text-xs text-text-5">
                No coding-agent CLIs installed on this machine
              </span>
            ))}
        </div>

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
          <p className="px-1 text-2xs text-text-5">
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
            onKeyDown={(e) => {
              if (e.key === "Enter" && !starting) void start();
            }}
            placeholder="What should it work on? (optional)"
            className="h-7 text-xs"
          />
        )}

        {/* Its own branch means its own worktree over there. Two agents in one
            checkout is not parallelism, it's a merge conflict with extra
            steps — so this is offered rather than buried, and blank is a real
            answer for work you want in the main checkout. */}
        <Input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !starting) void start();
          }}
          placeholder="Its own branch (optional)"
          className="h-7 font-mono text-xs"
        />

        <Button
          variant="accentSoft"
          size="sm"
          disabled={!chosen || starting || (kind === "agent" && !agent)}
          onClick={() => void start()}
          className="self-start"
        >
          {starting ? (
            <>
              <AsciiSpinner /> Starting on the machine…
            </>
          ) : (
            <>
              <Plus size={13} />{" "}
              {kind === "agent" && task.trim() ? "Put it to work" : "Start there"}
            </>
          )}
        </Button>
      </div>
    </>
  );
}

/** Whether this machine may use the key on your own computer.
 *
 *  The one control in this panel that is a decision about trust rather than a
 *  decision about work, and the reason it is here rather than in the connect
 *  wizard: a wizard asks it while somebody is busy doing something else, gets a
 *  yes, and the machine keeps it forever. Asked on the place, it is asked about
 *  a machine the person is currently looking at.
 *
 *  It starts off. Everything under the summary exists because "forward my ssh
 *  agent" is a sentence that means nothing to most people using Aura and the
 *  wrong thing to most of the rest — they picture the key being copied there.
 *  It isn't. What actually happens is narrower in one way and broader in
 *  another, and neither half can be left to be inferred.
 *
 *  Not rendered at all for this laptop: work here already runs beside your key.
 */
function KeyLending({
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
    <>
      <div className={MENU_LABEL}>Your key</div>
      <p
        className="px-2 text-xs"
        style={on ? { color: "var(--color-amber)" } : undefined}
      >
        <span className={on ? undefined : "text-text-5"}>{lending.state}</span>
      </p>
      {/* Folded, because it is three sentences somebody reads once and a line
          they read every time. Open before the first yes is a fair trade for
          never showing it again. */}
      <details className="px-2 pb-1 text-xs text-text-5" open={!on}>
        <summary className="cursor-pointer select-none py-0.5">
          What this lets {place.name.trim() || "that computer"} do
        </summary>
        <ul className="ml-3 list-disc space-y-0.5 py-1">
          {lending.grants.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
        <ul className="ml-3 list-disc space-y-0.5 pb-1 text-text-4">
          {lending.withholds.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </details>
      <button
        type="button"
        disabled={busy}
        onClick={() => void decide(!on)}
        className={`${MENU_ROW} text-sm`}
      >
        {busy ? <AsciiSpinner /> : <KeyRound size={13} />}
        {lending.action}
      </button>
    </>
  );
}

/** Which credential this place will spend on a remote, before it spends it.
 *
 *  A clone is the first push credential a project ever uses, and on a shared
 *  box it is one token belonging to whoever provisioned it. That still works —
 *  it is the only credential most boxes have — but it is no longer allowed to
 *  be silent, because the first anyone learned whose it was used to be a commit
 *  on GitHub with the wrong name against it.
 *
 *  Takes a `Place`, not a machine id: this laptop is asked the same question in
 *  the same words. */
function PushCredentialLine({ place, remote }: { place: Place; remote: string }) {
  const [plan, setPlan] = useState<PushPlan | null>(null);

  useEffect(() => {
    const url = remote.trim();
    if (!url) {
      setPlan(null);
      return;
    }
    let live = true;
    // Typing a URL is a keystroke at a time, and each one would otherwise be a
    // round trip to a box across an ocean.
    const t = setTimeout(() => {
      askPushCredential(place, url)
        .then((p) => live && setPlan(p))
        // A place we can't reach has no answer about credentials, and guessing
        // one here would be a sentence about somebody's identity that nothing
        // checked. The clone itself still says what it did.
        .catch(() => live && setPlan(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [place, remote]);

  if (!plan) return null;
  const tone = credentialTone(plan);
  return (
    <span
      className={`text-xs ${tone === "shared" ? "text-amber-400/90" : "text-text-5"}`}
    >
      {credentialSentence(plan)}
      {/* Only when it is somebody else's: these are the reasons, which are also
          the instructions for having your own. */}
      {tone === "shared" &&
        whyNotMine(plan).map((why) => (
          <span key={why} className="block text-text-5">
            {why}
          </span>
        ))}
    </span>
  );
}

/** Whose key this agent run will spend, before it spends it.
 *
 *  The sibling of [`PushCredentialLine`] and the more expensive of the two: a
 *  push spends a name, a run spends tokens. On a shared box every agent has been
 *  running on one key — `/etc/aura-runner/agent.env`, or the org's own
 *  `anthropic_api_key` — so the bill was real and the attribution was not. That
 *  still works, and on a team that pays centrally it is the right answer; it is
 *  no longer allowed to be silent.
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
    <span
      className={`px-1 text-2xs ${tone === "shared" ? "text-amber-400/90" : "text-text-5"}`}
    >
      {keySentence(plan)}
      {tone === "shared" && (
        <>
          {whyNotMyKey(plan).map((why) => (
            <span key={why} className="block text-text-5">
              {why}
            </span>
          ))}
          <span className="block text-text-5">{howToRunOnMyOwn(plan)}</span>
        </>
      )}
    </span>
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
    return (
      <p className="text-xs" style={{ color: "var(--color-amber)" }}>
        {notice}
      </p>
    );
  }
  return (
    <details className="text-xs text-text-5">
      <summary className="cursor-pointer list-none marker:content-none">
        {notice}
      </summary>
      <ul className="mt-0.5 flex flex-col gap-0.5 pl-1">
        {withheldProjects(offered).map((w) => (
          <li key={w.path} className="text-text-4">
            <span className="text-text-5">{w.name}</span> — {w.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Put a project on the box that isn't on it yet.
 *
 *  Without this, a machine can only ever work on whatever happened to be
 *  cloned there by hand — which makes "run several of my projects on one box"
 *  a thing you do over ssh in another window and then come back to. Collapsed
 *  by default, because it is the thing you do once per project and the panel
 *  above it is the thing you do every day. */
function AddProject({
  place,
  onStarted,
  onError,
}: {
  place: Place;
  onStarted: (s: BoxSession) => void;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [cloning, setCloning] = useState(false);

  // What the folder ends up called, unless you say otherwise. Nobody wants to
  // type the repo's name twice, and `naridon.git` is not what it should be
  // called on disk.
  const [dir, setDir] = useState("");
  const suggested = useMemo(() => repoFolderName(url), [url]);
  const folder = dir.trim() || suggested;
  const machineId = placeAddress(place);

  const clone = useCallback(async () => {
    if (!url.trim() || !folder) return;
    setCloning(true);
    onError(null);
    try {
      const s = await api.boxClone(machineId, url.trim(), folder);
      setUrl("");
      setDir("");
      setOpen(false);
      // A clone is minutes of output on a big repo, so it comes back as a
      // session you can watch rather than a spinner you have to sit in front
      // of — and it keeps going if you close the window.
      onStarted(s);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloning(false);
    }
  }, [machineId, url, folder, onStarted, onError]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${MENU_ROW} text-text-4`}
      >
        <Plus size={13} /> Put another project on this machine
      </button>
    );
  }

  return (
    <>
      <div className={MENU_LABEL}>Put a project on this machine</div>
      <div className="flex flex-col gap-1.5 px-2 pb-1.5">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !cloning) void clone();
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="https://github.com/you/project.git"
          className="h-7 font-mono text-xs"
          autoFocus
        />
        <Input
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !cloning) void clone();
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder={suggested ? `Folder name (${suggested})` : "Folder name"}
          className="h-7 font-mono text-xs"
        />
        {/* Where it lands is the machine's answer, not ours — this laptop has
            no idea where that box keeps things, and a guess would put someone's
            project somewhere they never chose. */}
        <span className="text-xs text-text-5">
          It goes in the machine’s home directory, and the clone runs there —
          you can close this window while it finishes.
        </span>
        {/* Whose token this clone will spend, said before it is spent. */}
        <PushCredentialLine place={place} remote={url} />
        <div className="flex items-center gap-1.5">
          <Button
            variant="accentSoft"
            size="sm"
            disabled={!url.trim() || !folder || cloning}
            onClick={() => void clone()}
          >
            {cloning ? (
              <>
                <AsciiSpinner /> Starting the clone…
              </>
            ) : (
              "Clone it there"
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </>
  );
}

/** The folder a clone URL would naturally become. Pure, and exported-adjacent
 *  only through its own tests: `…/project.git` and `…/project` and a trailing
 *  slash all mean the same folder. */
export function repoFolderName(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  const last = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  // `git@github.com:you/project.git` has no slash before the repo when someone
  // pastes only the scp-style half of it.
  const afterColon = last.slice(last.lastIndexOf(":") + 1);
  return afterColon.replace(/\.git$/i, "");
}
