// ConnectMachineWizard — the "bring a machine and turn it into your always-on
// cloud runner" flow. It exists because setting a runner box up by hand meant
// three separate SSH sessions and copy-pasted tokens. Here you point at a Linux
// box, and Aura walks the whole thing in one embedded terminal:
//
//   1. Machine        — where is it + which SSH key opens it (the key never
//                        leaves your Mac).
//   2. Set up & sign in — Aura opens a real terminal on the box, joins it to
//                        your cloud board, and runs `claude setup-token`. That
//                        login opens a page in YOUR browser — you approve with
//                        your own account, so the box never sees a password.
//   3. Start          — turns the machine on; when your board sees it, you're
//                        done and work you send starts draining there.
//
// The one thing the browser can't do itself — mint a runner token on your
// signed-in account — goes through `api.runnerProvision` (which shells the same
// `aura runner register` the CLI uses). Everything else is real commands typed
// into the embedded terminal for you, so nothing is hidden.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Cloud,
  TerminalSquare,
  KeyRound,
  ExternalLink,
  CircleCheck,
  CircleAlert,
} from "lucide-react";

import { FullscreenOverlay } from "../../FullscreenOverlay";
import { Terminal } from "../../Terminal";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { useWizard, WizardStepTabs, type WizardStepMeta } from "../../ui/wizard";
import { api, missionState } from "../../../lib/api";
import { openExternal } from "../../../lib/openExternal";
import { trackFeature } from "../../../lib/track";

const STEPS: WizardStepMeta[] = [
  { id: "machine", label: "Machine" },
  { id: "setup", label: "Set up & sign in" },
  { id: "start", label: "Start" },
];

/** A single interactive SSH session — the box's shell, hosted in xterm. We keep
 *  one for the whole wizard so the token we export and the login we run all live
 *  in the same shell the runner is finally started in. */
const TERM_INSTANCE = "connect-machine-terminal";

/** Fences we `echo` around the runner-log tail so we can scrape just the log
 *  body out of the shared terminal stream. See the pty listener for how the
 *  matching command is built with `""` so the command echo doesn't self-match. */
const LOG_START = "___AURA_LOG_START___";
const LOG_END = "___AURA_LOG_END___";

/** Strip ANSI escape sequences so a scraped log reads as plain text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

type Props = {
  /** Board root — feeds the terminal's spawn dir + the online probe. */
  repoRoot: string;
  onClose: () => void;
  /** Fired once the runner reports online, so the panel can refresh itself. */
  onOnline?: () => void;
};

export function ConnectMachineWizard({ repoRoot, onClose, onOnline }: Props) {
  const wiz = useWizard(STEPS.length);

  // ── Step 1: where the box is ────────────────────────────────────────────
  const [host, setHost] = useState("");
  const [user, setUser] = useState("ubuntu");
  const [keyPath, setKeyPath] = useState("");

  // ── The live SSH terminal ───────────────────────────────────────────────
  const [launched, setLaunched] = useState(false);
  const [ptyId, setPtyId] = useState<string | null>(null);

  // ── Step 2: join the board + sign Claude in ─────────────────────────────
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  // ── Step 3: start + confirm online ──────────────────────────────────────
  // `startPhase` is a DURABLE lifecycle for the runner boot. Unlike the old
  // `starting` flag — which reset the instant the start command was written —
  // it holds "starting" until the board actually sees the box (→ online) or we
  // give up ("timeout") and pull the boot log so the failure isn't invisible.
  const [startPhase, setStartPhase] = useState<"idle" | "starting" | "timeout">(
    "idle",
  );
  const [online, setOnline] = useState(false);
  const [setupLog, setSetupLog] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const [error, setError] = useState<string | null>(null);

  // The runner's board name. Editable up front so naming isn't blocked on the
  // host address; falls back to the host, then a sensible default.
  const [name, setName] = useState("");
  const effectiveName = useMemo(
    () => name.trim() || host.trim() || "my-machine",
    [name, host],
  );

  const hostValid = /^[A-Za-z0-9._-]+$/.test(host.trim());
  const userValid = /^[A-Za-z0-9._-]+$/.test(user.trim());
  const keyValid = keyPath.trim().length > 0 && !/["`]/.test(keyPath);
  const canConnect = hostValid && userValid && keyValid;

  // Write a line into the box's shell exactly as if the user typed it. All the
  // "magic" the wizard does is just this — real commands, visible in the
  // terminal, nothing behind their back.
  const runInTerminal = useCallback(
    async (line: string) => {
      if (!ptyId) return;
      const data = line.endsWith("\n") ? line : `${line}\n`;
      await invoke("pty_write", { id: ptyId, data }).catch(() => {});
    },
    [ptyId],
  );

  // Build the `ssh` line. The key path is double-quoted so spaces survive; a
  // leading `~` becomes `$HOME` so it still expands inside the quotes. We reject
  // `"`/backtick in the key path up front (keyValid), so quoting is safe.
  const sshCommand = useMemo(() => {
    const kp = keyPath.trim().replace(/^~(?=\/)/, "$HOME");
    return [
      "ssh",
      "-i",
      `"${kp}"`,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      `${user.trim()}@${host.trim()}`,
    ].join(" ");
  }, [keyPath, user, host]);

  // ── Scrape the terminal for the `claude setup-token` sign-in URL ─────────
  // We add our own listener on the same `pty:<id>` stream the terminal renders;
  // Tauri events are broadcast, so this never steals bytes from the screen. Once
  // we've asked for the login, the first https URL that appears is the one to
  // open in the user's browser.
  const awaitingUrl = useRef(false);
  const scrollback = useRef("");
  // Same technique, reused to pull `~/aura-runner.log` back off the box when a
  // start times out. The markers are split with `""` in the shell command so
  // the terminal's echo of the *command line* never contains the exact marker
  // — only the `echo` output does — which keeps the scrape from matching the
  // command instead of the log body.
  const awaitingLog = useRef(false);
  const logScrollback = useRef("");
  useEffect(() => {
    if (!ptyId) return;
    let unlisten: UnlistenFn | undefined;
    const decoder = new TextDecoder();
    (async () => {
      unlisten = await listen<number[]>(`pty:${ptyId}`, (e) => {
        if (!awaitingUrl.current && !awaitingLog.current) return;
        const chunk = decoder.decode(new Uint8Array(e.payload));
        if (awaitingUrl.current) {
          scrollback.current += chunk;
          // Keep only a recent tail so the match stays cheap.
          if (scrollback.current.length > 8000) {
            scrollback.current = scrollback.current.slice(-8000);
          }
          const m = scrollback.current.match(
            /https?:\/\/[^\s"'<>]*(?:anthropic|claude\.ai|oauth|login|auth)[^\s"'<>]*/i,
          );
          if (m) {
            awaitingUrl.current = false;
            setLoginUrl(m[0]);
          }
        }
        if (awaitingLog.current) {
          logScrollback.current += chunk;
          if (logScrollback.current.length > 16000) {
            logScrollback.current = logScrollback.current.slice(-16000);
          }
          const end = logScrollback.current.indexOf(LOG_END);
          if (end !== -1) {
            const start = logScrollback.current.indexOf(LOG_START);
            const body =
              start !== -1
                ? logScrollback.current.slice(start + LOG_START.length, end)
                : logScrollback.current.slice(0, end);
            awaitingLog.current = false;
            setSetupLog(
              stripAnsi(body).trim() ||
                "The runner log was empty — the box may not have run `aura` at all. Check that aura is installed and on PATH there.",
            );
          }
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [ptyId]);

  const onConnect = useCallback(() => {
    setError(null);
    setLaunched(true);
    trackFeature("connect_machine_open");
    wiz.next();
  }, [wiz]);

  // Step 2: mint the runner token on the signed-in account, export it into the
  // box's shell, then kick off the browser sign-in.
  const onPrepare = useCallback(async () => {
    if (!ptyId || preparing) return;
    setPreparing(true);
    setError(null);
    try {
      const prov = await api.runnerProvision(effectiveName);
      // Join the board: export the token in THIS shell (so the runner we start
      // later inherits it) and persist it for a service to pick up.
      await runInTerminal(`export AURA_RUNNER_TOKEN='${prov.token}'`);
      await runInTerminal(
        "mkdir -p ~/.config/aura && " +
          'printf "AURA_RUNNER_TOKEN=%s\\n" "$AURA_RUNNER_TOKEN" > ~/.config/aura/runner.env',
      );
      // Sign Claude in — this prints a URL we open in the user's own browser.
      awaitingUrl.current = true;
      scrollback.current = "";
      await runInTerminal("claude setup-token");
      setPrepared(true);
      trackFeature("connect_machine_prepared");
    } catch (e) {
      setError(String(e));
    } finally {
      setPreparing(false);
    }
  }, [ptyId, preparing, effectiveName, runInTerminal]);

  // Pull the last of `~/aura-runner.log` off the box and into the panel, so a
  // start that never checks in isn't a silent spinner. Reuses the terminal
  // scrape (see the pty listener above).
  const tailSetupLog = useCallback(async () => {
    awaitingLog.current = true;
    logScrollback.current = "";
    await runInTerminal(
      `echo "___AURA""_LOG_START___"; tail -n 60 ~/aura-runner.log 2>&1; echo "___AURA""_LOG_END___"`,
    );
  }, [runInTerminal]);

  // Step 3: start the runner in the same shell, then wait for the board to see
  // it. `--all-projects` so one box drains every project you own. We do NOT
  // clear the phase after writing the command — it stays "starting" until the
  // poll below sees the box online or times out, so the UI is honest about the
  // fact that booting takes a moment.
  const onStart = useCallback(async () => {
    if (!ptyId || startPhase === "starting") return;
    setStartPhase("starting");
    setOnline(false);
    setSetupLog(null);
    setError(null);
    startedAtRef.current = Date.now();
    try {
      await runInTerminal(
        "nohup aura runner serve --all-projects > ~/aura-runner.log 2>&1 &",
      );
      trackFeature("connect_machine_started");
    } catch (e) {
      setError(String(e));
      setStartPhase("idle");
    }
  }, [ptyId, startPhase, runInTerminal]);

  // Poll the board for this machine coming online. Runs while we're prepared or
  // actively starting; stops as soon as it's seen. If an explicit start hasn't
  // checked in within START_TIMEOUT_MS, flip to "timeout" and pull the boot log
  // so the user sees WHY instead of an endless spinner.
  useEffect(() => {
    if (online) return;
    if (startPhase !== "starting" && !prepared) return;
    const START_TIMEOUT_MS = 45_000;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const ms = await missionState([repoRoot]);
        if (alive && ms.host?.online) {
          setOnline(true);
          onOnline?.();
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (!alive) return;
      if (
        startPhase === "starting" &&
        startedAtRef.current !== null &&
        Date.now() - startedAtRef.current > START_TIMEOUT_MS
      ) {
        setStartPhase("timeout");
        void tailSetupLog();
        return;
      }
      timer = window.setTimeout(tick, 4000);
    };
    timer = window.setTimeout(tick, 4000);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [startPhase, prepared, online, repoRoot, onOnline, tailSetupLog]);

  const tabs = (
    <WizardStepTabs
      steps={STEPS}
      index={wiz.index}
      onJump={wiz.goTo}
      canJump={(i) => i <= wiz.index || (i === 1 && launched)}
      isComplete={(i) =>
        (i === 0 && launched) || (i === 1 && prepared) || (i === 2 && online)
      }
    />
  );

  return (
    <FullscreenOverlay onClose={onClose} tabs={tabs} closeHint="Esc to close">
      <div className="flex h-full min-h-0">
        {/* Left — step guidance + actions. */}
        <div className="w-[380px] shrink-0 overflow-y-auto border-r border-line-soft">
          <div className="flex flex-col gap-4 px-6 py-6">
            {wiz.index === 0 && (
              <StepMachine
                host={host}
                setHost={setHost}
                user={user}
                setUser={setUser}
                keyPath={keyPath}
                setKeyPath={setKeyPath}
                name={name}
                setName={setName}
                namePlaceholder={host.trim() || "my-machine"}
                canConnect={canConnect}
                onConnect={onConnect}
              />
            )}
            {wiz.index === 1 && (
              <StepSetup
                connected={!!ptyId}
                preparing={preparing}
                prepared={prepared}
                loginUrl={loginUrl}
                onPrepare={onPrepare}
                onNext={wiz.next}
              />
            )}
            {wiz.index === 2 && (
              <StepStart
                startPhase={startPhase}
                online={online}
                setupLog={setupLog}
                onStart={onStart}
                onDone={onClose}
              />
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-[8px] border border-red/40 bg-red/5 px-3.5 py-2.5 text-[12px] leading-snug text-red">
                <CircleAlert size={14} className="mt-0.5 shrink-0" />
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Right — the live terminal on the box (persists across steps). */}
        <div className="flex min-w-0 flex-1 flex-col bg-bg-1">
          <div className="flex items-center gap-2 border-b border-line-soft/60 px-4 py-2 text-[11.5px] text-text-4">
            <TerminalSquare size={13} />
            {launched ? (
              <span className="truncate">
                {user}@{host} — {ptyId ? "connected" : "connecting…"}
              </span>
            ) : (
              <span>The machine's terminal opens here once you connect.</span>
            )}
          </div>
          <div className="min-h-0 flex-1">
            {launched ? (
              <Terminal
                instanceId={TERM_INSTANCE}
                repoRoot={repoRoot}
                cwd={repoRoot}
                bootCommand={sshCommand}
                onOpened={(id) => setPtyId(id)}
              />
            ) : (
              <div className="grid h-full place-items-center px-8 text-center text-[12.5px] text-text-5">
                <div className="flex max-w-[280px] flex-col items-center gap-3">
                  <Cloud size={26} className="text-text-4" />
                  Fill in your machine on the left and press{" "}
                  <span className="text-text-3">Connect</span>. Aura opens a real
                  SSH session here — you'll see everything it runs.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </FullscreenOverlay>
  );
}

// ── Step 1 ────────────────────────────────────────────────────────────────
function StepMachine({
  host,
  setHost,
  user,
  setUser,
  keyPath,
  setKeyPath,
  name,
  setName,
  namePlaceholder,
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
  canConnect: boolean;
  onConnect: () => void;
}) {
  return (
    <>
      <Header
        icon={<Cloud size={17} />}
        title="Bring a machine"
        sub="Any Linux box you can reach — a cloud VM or a spare server. Aura connects over SSH; your key stays on your Mac and is never uploaded."
      />
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-text-2">Address</span>
        <Input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="e.g. 203.0.113.10 or box.example.com"
          className="text-[13px]"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-text-2">
          Sign-in user
        </span>
        <Input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="ubuntu"
          className="text-[13px]"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-text-2">
          SSH key file
        </span>
        <Input
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
          placeholder="~/.ssh/id_ed25519"
          className="text-[13px] font-mono"
        />
        <span className="text-[11px] text-text-5">
          The private key that opens this box. Stays local.
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-text-2">
          Name on your board{" "}
          <span className="font-normal text-text-5">(optional)</span>
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={namePlaceholder}
          className="text-[13px]"
        />
        <span className="text-[11px] text-text-5">
          What this machine is called on your board. Defaults to its address.
        </span>
      </label>
      <Button
        variant="default"
        onClick={onConnect}
        disabled={!canConnect}
        className="mt-1 w-full"
      >
        <KeyRound size={14} />
        Connect
      </Button>
    </>
  );
}

// ── Step 2 ────────────────────────────────────────────────────────────────
function StepSetup({
  connected,
  preparing,
  prepared,
  loginUrl,
  onPrepare,
  onNext,
}: {
  connected: boolean;
  preparing: boolean;
  prepared: boolean;
  loginUrl: string | null;
  onPrepare: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <Header
        icon={<KeyRound size={17} />}
        title="Set up & sign in"
        sub="Aura joins this machine to your cloud board and signs Claude in. The sign-in opens in your browser — you approve with your own account, so the box never sees a password."
      />
      {!connected ? (
        <Row spinner text="Connecting to the machine…" />
      ) : !prepared ? (
        <>
          <Row ok text="Connected to the machine." />
          <p className="text-[12px] leading-snug text-text-4">
            Next, Aura mints a runner token on your account, exports it on the
            box, and runs <code className="text-text-3">claude setup-token</code>{" "}
            for you.
          </p>
          <Button
            variant="accentSoft"
            onClick={onPrepare}
            disabled={preparing}
            className="w-full"
          >
            {preparing ? <AsciiSpinner /> : <KeyRound size={14} />}
            Set up & sign in
          </Button>
        </>
      ) : (
        <>
          <Row ok text="Machine joined to your board." />
          {loginUrl ? (
            <>
              <p className="text-[12px] leading-snug text-text-4">
                Open the sign-in page, approve with your Claude account, then
                paste the code it gives you back into the terminal and press
                Enter.
              </p>
              <Button
                variant="default"
                onClick={() => void openExternal(loginUrl)}
                className="w-full"
              >
                <ExternalLink size={14} />
                Open sign-in page
              </Button>
            </>
          ) : (
            <Row spinner text="Waiting for the sign-in link…" />
          )}
          <Button variant="subtle" onClick={onNext} className="w-full">
            I've pasted the code — continue
          </Button>
        </>
      )}
    </>
  );
}

// ── Step 3 ────────────────────────────────────────────────────────────────
function StepStart({
  startPhase,
  online,
  setupLog,
  onStart,
  onDone,
}: {
  startPhase: "idle" | "starting" | "timeout";
  online: boolean;
  setupLog: string | null;
  onStart: () => void;
  onDone: () => void;
}) {
  const starting = startPhase === "starting";
  return (
    <>
      <Header
        icon={<Cloud size={17} />}
        title="Start your machine"
        sub="Turn the runner on. It stays awake after you close your Mac and drains every project you send it."
      />
      {online ? (
        <>
          <Row ok text="Your machine is online." />
          <p className="text-[12px] leading-snug text-text-4">
            Work you send to the cloud will start running here. You can close
            this and check back any time.
          </p>
          <Button variant="accentSoft" onClick={onDone} className="w-full">
            <CircleCheck size={14} />
            Done
          </Button>
        </>
      ) : startPhase === "timeout" ? (
        <>
          <Row alert text="Your machine hasn't checked in yet." />
          <p className="text-[12px] leading-snug text-text-4">
            A cold box can take a minute, but this is longer than usual. Here's
            the tail of its startup log — it usually says what went wrong (aura
            not installed on the box, a bad token, or no network).
          </p>
          {setupLog ? (
            <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-[8px] border border-line-soft bg-bg-1 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-text-3">
              {setupLog}
            </pre>
          ) : (
            <Row spinner text="Fetching the startup log…" />
          )}
          <Button variant="accentSoft" onClick={onStart} className="w-full">
            <Cloud size={14} />
            Try starting again
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="accentSoft"
            onClick={onStart}
            disabled={starting}
            className="w-full"
          >
            {starting ? <AsciiSpinner /> : <Cloud size={14} />}
            Start the runner
          </Button>
          {starting && (
            <Row
              spinner
              text="Starting your machine — waiting for your board to see it…"
            />
          )}
        </>
      )}
    </>
  );
}

// ── Small shared bits ───────────────────────────────────────────────────────
function Header({
  icon,
  title,
  sub,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[8px] bg-accent-soft text-accent">
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold text-text-1">{title}</h2>
        <p className="mt-1 text-[12px] leading-snug text-text-4">{sub}</p>
      </div>
    </div>
  );
}

function Row({
  ok,
  spinner,
  alert,
  text,
}: {
  ok?: boolean;
  spinner?: boolean;
  alert?: boolean;
  text: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 text-[12.5px] ${
        alert ? "text-amber" : "text-text-3"
      }`}
    >
      {spinner ? (
        <AsciiSpinner />
      ) : ok ? (
        <CircleCheck size={14} className="text-accent-green" />
      ) : alert ? (
        <CircleAlert size={14} className="shrink-0 text-amber" />
      ) : null}
      {text}
    </div>
  );
}
