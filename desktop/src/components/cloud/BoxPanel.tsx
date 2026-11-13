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
//
// Drawn as the shared cloud details surface: a header, the status table, the
// sessions as port-style rows, and one section per question below them.

import { useCallback, useMemo, useState } from "react";
import {
  Activity,
  Eye,
  GitBranch,
  RotateCw,
  Terminal as TerminalIcon,
  Users,
} from "lucide-react";

import { api, type BoxSession, type Machine } from "../../lib/api";
import { findMachine } from "../../lib/machineRef";
import {
  asleepFor,
  isAsleep,
  placeAddress,
  runningLate,
  sleepingInsteadOfError,
  startsItselfLine,
  wakeHeadline,
  wakeProgress,
  type Place,
} from "../../lib/place";
import { AgentIcon } from "../agent/AgentIcon";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { CloudStatus } from "../ui/cloud-workspace";
import { MENU_ANIM, MENU_SURFACE_CLASS } from "../ui/menuSurface";
import { Progress } from "../ui/progress";
import { ErrorNote, LoadingState } from "../ui/state";
import "../ui/cloud-patterns.css";
import "../ui/machine-workspace.css";
import { AddProject } from "./BoxAddProject";
import { KeyLending } from "./BoxKeyLending";
import { StartSomething } from "./BoxStartSomething";
import { PlaceDrift } from "./PlaceDrift";
import { useWaking } from "./useWaking";
import {
  groupByProject,
  sessionLabel,
  sinceWords,
  type BoxState,
} from "./useBox";

export { repoFolderName } from "./BoxAddProject";

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
      const woken = findMachine(await api.machinesList(), machineId);
      if (woken) onWoke?.(woken);
      refresh();
    } catch (e) {
      setWakeError(e instanceof Error ? e.message : String(e));
    } finally {
      setNudge((n) => n + 1);
    }
  }, [machineId, onWoke, refresh]);

  // Each start lands the person in the thing they just started.
  const started = (s: BoxSession) => {
    refresh();
    onAttach(s);
    onClose();
  };

  return (
    <div
      className={`${MENU_SURFACE_CLASS} ${MENU_ANIM} ui-popover ui-cloud-details ui-box-panel`}
      role="dialog"
      aria-label="Running on this machine"
      // The library flyout appear plays on `data-state=open`; this panel is
      // not a Radix popover, so it says so itself, and grows from under the
      // ＋ at the strip's right end.
      data-state="open"
      style={{ transformOrigin: "top right" }}
    >
      <header>
        <strong>Running on this machine</strong>
        {reading && sessions !== null && <AsciiSpinner size={10} />}
      </header>

      {/* Asleep is asked FIRST, ahead of every other state. This branch is the
          whole reason the book carries a sleep stamp: a stopped machine cannot
          be asked anything, so every reading below — the error, the spinner,
          the empty list — would describe a box that is working exactly as
          intended in the words of one that isn't. */}
      {asleep || starting ? (
        <div className="ui-box-asleep">
          <dl className="ui-cloud-resource-table">
            <dt>
              <Activity />
              Status
            </dt>
            <dd>
              {/* Still offered, even though opening anything here would do it.
                  Someone who is about to work on this box would rather spend
                  the minute now than inside their first command. */}
              {!starting && (
                <button
                  type="button"
                  className="ui-cloud-resource-restart"
                  onClick={() => void wake()}
                >
                  <RotateCw size={12} />
                  Wake it up
                </button>
              )}
              <CloudStatus state={starting ? "starting" : "sleeping"} />
            </dd>
          </dl>
          {starting && waking ? (
            /* The wait, said out loud. A minute of nothing is
               indistinguishable from a hang, and both things somebody does
               about a hang — press it again, or go looking for support — are
               wrong here. So: what is happening, how far through the usual
               wait it is, and, once it runs past that, the fact that it has —
               still not as a fault. */
            <>
              <p role="status">{wakeHeadline(waking, now)}</p>
              <Progress
                className="ui-box-wake-progress"
                value={Math.round(wakeProgress(waking, now) * 100)}
                aria-label="How far through the usual start-up wait"
                // Grey once it is over, not amber. The bar has run out of
                // estimate, which is not the same as anything being wrong,
                // and a colour that says "wrong" here teaches people to
                // distrust a feature that works.
                data-late={runningLate(waking, now) ? "" : undefined}
              />
            </>
          ) : (
            <>
              {/* "Using it starts it" when reaching it would, which is the
                  sentence that turns asleep from a thing to press a button
                  about into a thing to ignore. The plain version is the
                  fallback for a box Aura cannot start, and for the moment
                  before the first read lands. */}
              <p>
                {(waking && startsItselfLine(waking)) ||
                  sleepingInsteadOfError(place)}
              </p>
              <p className="ui-cloud-note">
                Aura stopped it because nobody was using it
                {asleepFor(place, now) ? ` ${asleepFor(place, now)} ago` : ""},
                so it isn’t costing anything while it’s off.
              </p>
              {wakeError && <ErrorNote>Couldn’t start it again — {wakeError}</ErrorNote>}
            </>
          )}
        </div>
      ) : error ? (
        <ErrorNote>Couldn’t ask the machine what it’s running — {error}</ErrorNote>
      ) : sessions === null ? (
        <LoadingState label="Asking the machine…" />
      ) : sessions.length === 0 ? (
        <p>
          Nothing running there yet. Anything you start below keeps running when
          you close this window.
        </p>
      ) : (
        grouped.map(([project, rows]) => (
          <div key={project} className="ui-box-group">
            <small>{project}</small>
            {rows.map((s) => {
              const isOpen = open.has(s.name);
              return (
                <div key={s.name} className="ui-cloud-port ui-box-session">
                  <button
                    type="button"
                    className="ui-box-session-open"
                    onClick={() => {
                      onAttach(s);
                      onClose();
                    }}
                  >
                    <span className="ui-box-session-mark">
                      {s.agent ? (
                        <AgentIcon agentId={s.agent} label={s.agent} size={14} />
                      ) : (
                        <TerminalIcon size={13} />
                      )}
                    </span>
                    <div>
                      <span>{sessionLabel(s)}</span>
                      <small className="ui-box-meta">
                        {s.branch && (
                          <span>
                            <GitBranch size={10} />
                            {s.branch}
                          </span>
                        )}
                        {/* Two clients on one session means somebody else is
                            in here with you — the one fact about a shared box
                            you cannot afford to find out by typing. */}
                        {s.attached > 1 && (
                          <span data-tone="ok">
                            <Users size={10} />
                            {s.attached} watching
                          </span>
                        )}
                        <span>{sinceWords(s.activity_at, now)}</span>
                        {isOpen && <span>· open here</span>}
                      </small>
                    </div>
                  </button>
                  {/* Joining a session someone is driving means sharing their
                      keyboard: tmux gives every client the same pane, so a
                      stray keystroke of yours lands in their agent. Watching
                      attaches read-only, which is what you nearly always want
                      when the answer to "what is it doing" is the question. */}
                  <Button
                    variant="ghost"
                    size="iconXs"
                    className="ui-box-session-action"
                    onClick={() => {
                      onAttach(s, { readOnly: true });
                      onClose();
                    }}
                    title="Watch without typing — the session can't hear your keyboard"
                    aria-label="Watch without typing"
                  >
                    <Eye />
                  </Button>
                  <Button
                    variant={armed === s.name ? "destructive" : "ghost"}
                    size="xs"
                    className="ui-box-session-action"
                    data-armed={armed === s.name ? "" : undefined}
                    disabled={busy === s.name}
                    onClick={() =>
                      armed === s.name ? void stop(s.name) : setArmed(s.name)
                    }
                    onBlur={() => setArmed((a) => (a === s.name ? null : a))}
                    title="End this session on the machine"
                  >
                    {busy === s.name ? (
                      <AsciiSpinner size={10} />
                    ) : armed === s.name ? (
                      "Stop?"
                    ) : (
                      "Stop"
                    )}
                  </Button>
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
          {/* Why the thing that works here doesn't work there. Above the start
              controls on purpose: a place three tools short is the reason the
              agent you are about to start will fail, and after the fact it is a
              transcript to read rather than a line to have seen. */}
          <section>
            <PlaceDrift place={place} />
          </section>

          <section>
            <StartSomething
              place={place}
              projects={projects}
              offered={offered}
              onStarted={started}
              onError={setStartError}
            />
          </section>

          <section>
            <AddProject place={place} onStarted={started} onError={setStartError} />
          </section>

          <KeyLending place={place} onError={setStartError} />

          {startError && <ErrorNote>{startError}</ErrorNote>}
        </>
      )}
    </div>
  );
}
