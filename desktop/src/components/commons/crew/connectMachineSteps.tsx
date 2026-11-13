// The connect-a-machine wizard's three pages — Machine, Set up & sign in,
// Start — drawn the way the cloud setup draws a step: a heading and its line,
// the fields, then the one move that takes you on. The state and every command
// they trigger live in ConnectMachineWizard; these only show it.

import { ArrowRight, CircleCheck, Cloud, ExternalLink, KeyRound } from "lucide-react";
import type { MemberAccount } from "../../../lib/api";
import type { BaseBuild } from "../../../lib/place";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Field } from "../../ui/field";
import { Input } from "../../ui/input";
import { openExternal } from "../../../lib/openExternal";
import { AccountRows, StatusRow, WarmRows } from "./connectMachineRows";
import type { BoxKind } from "./connectMachine";
import "../../ui/cloud-patterns.css";
import "../../ui/connect-machine.css";

const BOX_KINDS: { value: BoxKind; label: string }[] = [
  { value: "mine", label: "Just me" },
  { value: "shared", label: "My team" },
];

// ── Step 1 ────────────────────────────────────────────────────────────────
export function StepMachine({
  host,
  setHost,
  user,
  setUser,
  keyPath,
  setKeyPath,
  name,
  setName,
  namePlaceholder,
  boxKind,
  setBoxKind,
  canConnect,
  onConnect,
}: {
  host: string;
  setHost: (v: string) => void;
  user: string;
  setUser: (v: string) => void;
  keyPath: string;
  setKeyPath: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  namePlaceholder: string;
  boxKind: BoxKind;
  setBoxKind: (k: BoxKind) => void;
  canConnect: boolean;
  onConnect: () => void;
}) {
  return (
    <>
      <header>
        <h1>Bring a machine</h1>
        <p>
          Any Linux box you can reach. A cloud VM or a spare server. Aura connects over SSH;
          your key stays on your Mac and is never uploaded.
        </p>
      </header>
      <div className="ui-connect-machine-form">
        <Field label="Address" htmlFor="connect-machine-host">
          <Input
            id="connect-machine-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="e.g. 203.0.113.10 or box.example.com"
            spellCheck={false}
          />
        </Field>
        <Field label="Sign-in user" htmlFor="connect-machine-user">
          <Input
            id="connect-machine-user"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="ubuntu"
            spellCheck={false}
          />
        </Field>
        <Field
          label="SSH key file"
          htmlFor="connect-machine-key"
          description="The private key that opens this box. Stays local."
        >
          <Input
            id="connect-machine-key"
            className="ui-connect-machine-mono"
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
            placeholder="~/.ssh/id_ed25519"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Name on your board"
          htmlFor="connect-machine-name"
          optional
          description="What this machine is called on your board. Defaults to its address."
        >
          <Input
            id="connect-machine-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={namePlaceholder}
          />
        </Field>
        {/* Asked here, before anything is done to the box, because it decides
            what the next step DOES — not just how the last one is labelled. On a
            shared machine, step 2 makes you a Unix account of your own and moves
            this session into it before it writes a single credential. */}
        <Field
          label="Who uses this machine"
          description={
            boxKind === "mine"
              ? "One runner on this machine, draining everything you send it, under the login above."
              : "Aura gives you your own account on it — your own home, your own sign-in, your own runner — so nobody has to share a login with the rest of the team. The login above is only used to set it up."
          }
        >
          <div className="ui-cloud-segments" role="group" aria-label="Who uses this machine">
            {BOX_KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                aria-pressed={boxKind === k.value}
                onClick={() => setBoxKind(k.value)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <Button onClick={onConnect} disabled={!canConnect}>
        Connect <ArrowRight />
      </Button>
    </>
  );
}

// ── Step 2 ────────────────────────────────────────────────────────────────
export function StepSetup({
  phase,
  preparing,
  prepared,
  loginUrl,
  boxKind,
  account,
  warm,
  warmProblem,
  warmNote,
  onPrepare,
  onNext,
}: {
  phase: "connecting" | "ready" | "unreachable";
  preparing: boolean;
  prepared: boolean;
  loginUrl: string | null;
  boxKind: BoxKind;
  /** What the box reported about this member's own account, once it has one. */
  account: MemberAccount | null;
  /** What joining cost this member — the install they paid for, or the one
   *  somebody else already had. */
  warm: BaseBuild | null;
  /** Why they were not started from the team's environment, when they weren't. */
  warmProblem: string | null;
  /** What the copy is doing, while it is doing it. */
  warmNote: string | null;
  onPrepare: () => void;
  onNext: () => void;
}) {
  const shared = boxKind === "shared";
  return (
    <>
      <header>
        <h1>Set up &amp; sign in</h1>
        <p>
          {shared
            ? "Aura gives you your own account on this machine, joins it to your cloud board and signs Claude in. The sign-in opens in your browser. You approve with your own account, so the box never sees a password."
            : "Aura joins this machine to your cloud board and signs Claude in. The sign-in opens in your browser. You approve with your own account, so the box never sees a password."}
        </p>
      </header>
      {phase === "unreachable" ? (
        <>
          <StatusRow alert text="The machine never answered." />
          <p>
            Aura opened a connection but nothing on the other end replied. That is usually the
            address, the sign-in user, or a key this box won't accept. Go back a step, check
            them, and connect again.
          </p>
        </>
      ) : phase !== "ready" ? (
        <StatusRow spinner text="Waiting for the machine to answer…" />
      ) : !prepared ? (
        <>
          <StatusRow ok text="Connected to the machine." />
          <p>
            {shared ? (
              <>
                Next, Aura makes you a user of your own on this machine, moves this terminal into
                it, then mints a runner token on your account and runs{" "}
                <code>claude setup-token</code> there. Your teammates get their own the same way
                — nobody shares a login.
              </>
            ) : (
              <>
                Next, Aura mints a runner token on your account, exports it on the box, and runs{" "}
                <code>claude setup-token</code> for you.
              </>
            )}
          </p>
          <Button onClick={onPrepare} disabled={preparing}>
            {preparing ? <AsciiSpinner size={10} /> : <KeyRound />}
            Set up &amp; sign in
          </Button>
          {warmNote && <StatusRow spinner text={warmNote} />}
        </>
      ) : (
        <>
          <div className="ui-connect-machine-rows">
            {account && <AccountRows account={account} />}
            <WarmRows warm={warm} problem={warmProblem} />
            <StatusRow ok text="Machine joined to your board." />
          </div>
          {loginUrl ? (
            <p>
              Open the sign-in page, approve with your Claude account, then paste the code it
              gives you back into the terminal and press Enter.
            </p>
          ) : (
            <StatusRow spinner text="Waiting for the sign-in link…" />
          )}
          <div className="ui-cloud-inline">
            {loginUrl && (
              <Button onClick={() => void openExternal(loginUrl)}>
                <ExternalLink />
                Open sign-in page
              </Button>
            )}
            <Button variant={loginUrl ? "secondary" : "default"} onClick={onNext}>
              I've pasted the code. Continue <ArrowRight />
            </Button>
          </div>
        </>
      )}
    </>
  );
}

// ── Step 3 ────────────────────────────────────────────────────────────────
export function StepStart({
  startPhase,
  online,
  setupLog,
  boxKind,
  memberLogin,
  onStart,
  onDone,
}: {
  startPhase: "idle" | "starting" | "timeout";
  online: boolean;
  setupLog: string | null;
  boxKind: BoxKind;
  /** The account this session became in step 2, on a machine that is shared.
   *  Null on a machine of your own, where the login you connected as is
   *  already yours alone. */
  memberLogin: string | null;
  onStart: () => void;
  onDone: () => void;
}) {
  const starting = startPhase === "starting";
  return (
    <>
      <header>
        <h1>Start your machine</h1>
        <p>
          Turn the runner on as a service, so it comes back on its own after a restart. It stays
          awake once you close your Mac and works through every task you send it.
        </p>
      </header>
      {online ? (
        <>
          <StatusRow ok text="Your machine is online." />
          <p>
            Work you send to the cloud will start running here. You can close this and check back
            any time.
          </p>
          <Button onClick={onDone}>
            <CircleCheck />
            Done
          </Button>
        </>
      ) : startPhase === "timeout" ? (
        <>
          <StatusRow alert text="Your machine hasn't checked in yet." />
          <p>
            A cold box can take a minute, but this is longer than usual. Here's the tail of its
            startup log. It usually says what went wrong (aura not installed on the box, a bad
            token, or no network).
          </p>
          {setupLog ? (
            <pre className="ui-cloud-logs" aria-label="Startup log">
              {setupLog}
            </pre>
          ) : (
            <StatusRow spinner text="Fetching the startup log…" />
          )}
          <Button onClick={onStart}>
            <Cloud />
            Try starting again
          </Button>
        </>
      ) : (
        <>
          {/* What gets installed follows from who uses the machine, which was
              answered in step 1 and acted on in step 2. Saying it again here is
              the last chance to notice it's wrong before a service exists. */}
          <p>
            {boxKind === "mine" ? (
              "One runner on this machine, draining everything you send it."
            ) : memberLogin ? (
              <>
                Your runner is installed under <code>{memberLogin}</code>, the account Aura made
                for you here, and starts on its own after a reboot without anyone logged in. It
                keeps its own sign-in, its own files and its own spending. Your teammates connect
                the same way and get their own.
              </>
            ) : (
              <>
                Your runner is installed under the account you're signed in as on this machine. Go
                back to <em>Set up &amp; sign in</em> first if you haven't — that's the step that
                gives you an account of your own.
              </>
            )}
          </p>
          <Button onClick={onStart} disabled={starting}>
            {starting ? <AsciiSpinner size={10} /> : <Cloud />}
            Start the runner
          </Button>
          {starting && (
            <StatusRow spinner text="Starting your machine. Waiting for your board to see it…" />
          )}
        </>
      )}
    </>
  );
}
