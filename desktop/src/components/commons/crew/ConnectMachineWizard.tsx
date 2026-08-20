// ConnectMachineWizard — the "bring a machine and turn it into your always-on
// cloud runner" flow. It exists because setting a runner box up by hand meant
// three separate SSH sessions and copy-pasted tokens. Here you point at a Linux
// box, and Aura walks the whole thing in one embedded terminal:
//
//   1. Machine        — where is it + which SSH key opens it (the key never
//                        leaves your Mac).
//   2. Set up & sign in — Aura waits for the box's shell to actually answer
//                        (see `remoteShell` — a pty opens long before ssh is
//                        through), then joins it to your cloud board and runs
//                        `claude setup-token`. That
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
import { Terminal, releaseTerminalSession } from "../../Terminal";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { SegmentedControl } from "../../ui/segmented";
import { useWizard, WizardStepTabs, type WizardStepMeta } from "../../ui/wizard";
import { api, type Machine, type MemberAccount } from "../../../lib/api";
import { openExternal } from "../../../lib/openExternal";
import { trackFeature } from "../../../lib/track";
import {
  askBootAt,
  askTeamBase,
  baseWarning,
  baseWasBuilt,
  isDialableAddress,
  openShell,
  placeOfMachine,
  warmSentence,
  warmShortfall,
  warmStart,
  type BaseBuild,
  type PlaceAddress,
} from "../../../lib/place";
import {
  PROBE_EVERY_MS,
  READY_TIMEOUT_MS,
  readyProbe,
  sawReady,
  shQuote,
} from "./remoteShell";
import { becomeMember, sawWho, whoProbe, writeRunnerEnv } from "./memberAccount";
import {
  afterSaving,
  boardName,
  installCommand,
  keepTail,
  loginUrlIn,
  seenOnBoard,
  setupLogIn,
  tailLogCommand,
  type BoxKind,
} from "./connectMachine";

const STEPS: WizardStepMeta[] = [
  { id: "machine", label: "Machine" },
  { id: "setup", label: "Set up & sign in" },
  { id: "start", label: "Start" },
];

/** A single interactive SSH session — the box's shell, hosted in xterm. We keep
 *  one for the whole wizard so the token we export and the login we run all live
 *  in the same shell the runner is finally started in.
 *
 *  It is released when the wizard closes. Terminal sessions are cached by id and
 *  outlive their component, so a fixed id meant re-opening the wizard reattached
 *  to the PREVIOUS run's shell — already logged in, possibly to a different box,
 *  and carrying none of the wizard state (`prepared`, `loginUrl`) that had been
 *  reset alongside it. Tying the shell's life to the wizard's keeps the two
 *  honest: a new wizard is a new shell, which is what every step here assumes. */
const TERM_INSTANCE = "connect-machine-terminal";

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
  // Having a pty is NOT having the machine. `ssh` is still handshaking, and
  // anything written during that window is swallowed with no error — the setup
  // runs into a void and the step waits forever for a sign-in link that was
  // never going to come. So this tracks the far shell, not the local pipe, and
  // nothing is typed at the box until it has answered us. See `remoteShell`.
  const [shellPhase, setShellPhase] = useState<
    "connecting" | "ready" | "unreachable"
  >("connecting");

  // Who else uses this machine — which decides the shape of everything that
  // follows, not just a label. On a box of your own, one runner drains
  // everything under the login you connected as. On a box your team shares,
  // Aura makes you a Unix account of your own first, and your sign-in, your
  // token and your runner all live in it. Nothing about the two is
  // interchangeable, so it's a question we ask before anything is written
  // rather than one we infer.
  const [boxKind, setBoxKind] = useState<BoxKind>("mine");

  // ── Step 2: your own account, then the board + Claude ───────────────────
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  // The account this member owns on the box, as the box reported it. Null on a
  // machine of your own, where the login you connected as is already yours.
  const [account, setAccount] = useState<MemberAccount | null>(null);
  // What it cost this member to join — the install they paid for, or the one
  // somebody else already paid and they started from. Null on a machine of
  // your own, and null when the join told us nothing worth saying.
  const [warm, setWarm] = useState<BaseBuild | null>(null);
  // Why there was no warm start, when there wasn't. Kept apart from `error`
  // because none of these stop the wizard: a member who can't be started from
  // the team's environment gets an empty home, which is what they got before
  // this existed.
  const [warmProblem, setWarmProblem] = useState<string | null>(null);
  // What the copy is doing while it does it. The first member through waits on
  // the project's whole declared install, and a silent spinner for that long
  // reads as a hang.
  const [warmNote, setWarmNote] = useState<string | null>(null);
  // The login this session is running as once the handover has happened. Until
  // then everything is the shared login the box came with, and writing a
  // member's token there would put it in a home directory everybody reads.
  const [memberLogin, setMemberLogin] = useState<string | null>(null);
  const [machine, setMachine] = useState<Machine | null>(null);

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

  // The runner's board name — see `boardName`.
  const [name, setName] = useState("");
  const effectiveName = useMemo(() => boardName(name, host), [name, host]);

  // The box, as somewhere to open a terminal, before the machine book has heard
  // of it. That order is the point — the shell answering is what proves the
  // address works, so a mistyped host leaves no row behind.
  const address = useMemo<PlaceAddress>(
    () => ({
      user: user.trim(),
      host: host.trim(),
      key_path: keyPath.trim(),
      kind: boxKind,
    }),
    [user, host, keyPath, boxKind],
  );

  // The same rule the backend applies before it dials anything — see
  // `dialable.cases.json`, which pins the two to each other. Kept locally only
  // because a form validates as you type, and a round trip per keystroke to
  // answer "is that a hostname" would be absurd.
  const canConnect = isDialableAddress(address);

  // Write a line into the box's shell exactly as if the user typed it. All the
  // "magic" the wizard does is just this — real commands, visible in the
  // terminal, nothing behind their back.
  //
  // Returns whether the bytes were actually accepted. Every command this wizard
  // sends is a step the UI then waits on, so a write that failed must be able to
  // say so — the alternative is the screen we shipped, which waited forever for
  // an answer to a question that was never asked.
  const runInTerminal = useCallback(
    async (line: string): Promise<boolean> => {
      if (!ptyId) return false;
      const text = line.endsWith("\n") ? line : `${line}\n`;
      // `pty_write` takes BYTES — `data: Vec<u8>` on the Rust side. Passing the
      // string rejects at serde, before the shell is ever reached, and the old
      // `.catch(() => {})` turned that rejection into silence: the wizard's
      // token export, its `claude setup-token` and its readiness knock were all
      // dropped at the IPC boundary with nothing on screen to say so.
      const data = Array.from(new TextEncoder().encode(text));
      try {
        await invoke("pty_write", { id: ptyId, data });
        return true;
      } catch (e) {
        setError(
          `Couldn't type into the machine's terminal: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return false;
      }
    },
    [ptyId],
  );

  // The line this terminal boots with, asked of the place rather than built
  // here. It used to be assembled from these three fields in TypeScript, which
  // meant the wizard dialled a box down one transport and every workspace
  // afterwards dialled the same box down another — same address, different
  // connection settings, different quoting, and only one of the two would ever
  // learn anything new. Fetched once, on Connect, so the terminal below has a
  // string to boot with the moment it mounts.
  const [bootCommand, setBootCommand] = useState<string | null>(null);

  // Remember the box the moment it answers.
  //
  // Connecting used to be a one-shot event: these three fields lived in this
  // component and died with it, so the app could install a runner on a machine
  // and then had no way back to it — a board row names a runner, it doesn't
  // carry an address. Saving here (not at the end) is deliberate: the shell
  // answering is the proof the address WORKS, and a wizard abandoned at step 2
  // still leaves you a machine you can open.
  // Anything the user changes afterwards — its board name, who else uses it —
  // is still theirs to change, so this re-saves rather than writing once: the
  // entry is keyed by `user@host`, so a second write updates it in place.
  //
  // It is saved under the login this session is actually running as, which on a
  // shared box changes mid-flow: we arrive as whatever login the image came
  // with, and become the member once they have an account. The shared login is
  // then forgotten — see `rememberMachine`.
  const sessionUser = memberLogin ?? user.trim();
  // The `user@host` we bootstrapped through, held so it can be dropped once the
  // member is reaching the box as themselves.
  const bootstrapId = useRef<string | null>(null);
  const rememberMachine = useCallback(async (): Promise<Machine | null> => {
    try {
      const m = await api.machineSave({
        name: effectiveName,
        host: host.trim(),
        user: sessionUser,
        key_path: keyPath.trim(),
        box_kind: boxKind,
      });
      setMachine(m);
      // Whether the login everybody shares is still a way in that Aura offers
      // — see `afterSaving`.
      const next = afterSaving(bootstrapId.current, memberLogin, m.id);
      bootstrapId.current = next.hold;
      if (next.forget) {
        await api
          .machineForget(next.forget)
          .catch((e) => console.error("forgetting the shared login failed:", e));
      }
      return m;
    } catch (e) {
      console.error("machine save failed:", e);
      return null;
    }
  }, [effectiveName, host, sessionUser, keyPath, boxKind, memberLogin]);

  useEffect(() => {
    if (shellPhase !== "ready") return;
    void rememberMachine();
  }, [shellPhase, rememberMachine]);

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
  // And once more for the knock that tells us the far shell is live.
  const awaitingReady = useRef(true);
  const readyScrollback = useRef("");
  // And last, for "who is this shell, really". A handover turns that from
  // trivia into the thing every command after it depends on: the same
  // `claude setup-token` typed one login too early signs the whole team in as
  // one person.
  const whoWaiter = useRef<((login: string) => void) | null>(null);
  const whoScrollback = useRef("");
  useEffect(() => {
    if (!ptyId) return;
    let unlisten: UnlistenFn | undefined;
    const decoder = new TextDecoder();
    (async () => {
      unlisten = await listen<number[]>(`pty:${ptyId}`, (e) => {
        if (
          !awaitingReady.current &&
          !awaitingUrl.current &&
          !awaitingLog.current &&
          !whoWaiter.current
        ) {
          return;
        }
        const chunk = decoder.decode(new Uint8Array(e.payload));
        if (whoWaiter.current) {
          whoScrollback.current += chunk;
          if (whoScrollback.current.length > 8000) {
            whoScrollback.current = whoScrollback.current.slice(-8000);
          }
          const who = sawWho(whoScrollback.current);
          if (who) {
            const answer = whoWaiter.current;
            whoWaiter.current = null;
            answer(who);
          }
        }
        if (awaitingReady.current) {
          readyScrollback.current += chunk;
          if (readyScrollback.current.length > 8000) {
            readyScrollback.current = readyScrollback.current.slice(-8000);
          }
          if (sawReady(readyScrollback.current)) {
            awaitingReady.current = false;
            setShellPhase("ready");
          }
        }
        if (awaitingUrl.current) {
          scrollback.current = keepTail(scrollback.current + chunk, 8000);
          const url = loginUrlIn(scrollback.current);
          if (url) {
            awaitingUrl.current = false;
            setLoginUrl(url);
          }
        }
        if (awaitingLog.current) {
          logScrollback.current = keepTail(logScrollback.current + chunk, 16000);
          const log = setupLogIn(logScrollback.current);
          if (log !== null) {
            awaitingLog.current = false;
            setSetupLog(log);
          }
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [ptyId]);

  // ── The shell dies with the wizard ──────────────────────────────────────
  // Terminal sessions are cached by instance id and deliberately outlive their
  // component so a tab you flick away from keeps running. That is wrong here:
  // closing this wizard resets every piece of state that describes the shell
  // (`prepared`, `loginUrl`, `shellPhase`), so a reattached shell arrives with
  // a history the UI can no longer account for. Dropping it on close means
  // "open the wizard" always means the same thing.
  useEffect(() => {
    return () => releaseTerminalSession(TERM_INSTANCE);
  }, []);

  // ── Wait for the machine, not for the pipe ──────────────────────────────
  // Knock until the box answers. A knock sent mid-handshake is lost in silence,
  // so repeating it is the only reliable way to learn the far shell is reading
  // us — and that first answer is what makes every command after it safe to
  // send. Stops on the answer, or gives up loudly rather than spinning.
  useEffect(() => {
    if (!ptyId || shellPhase !== "connecting") return;
    awaitingReady.current = true;
    readyScrollback.current = "";
    let alive = true;
    let timer: number | undefined;
    const startedAt = Date.now();
    const knock = async () => {
      if (!alive) return;
      if (Date.now() - startedAt > READY_TIMEOUT_MS) {
        awaitingReady.current = false;
        setShellPhase("unreachable");
        return;
      }
      const sent = await runInTerminal(readyProbe());
      if (!alive) return;
      // A knock that couldn't even be SENT is not a machine being slow — it is
      // this end being broken, and repeating it 30 more times just spends the
      // timeout to reach the same wrong answer. `runInTerminal` has already put
      // the reason on screen.
      if (!sent) {
        awaitingReady.current = false;
        setShellPhase("unreachable");
        return;
      }
      timer = window.setTimeout(() => void knock(), PROBE_EVERY_MS);
    };
    void knock();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [ptyId, shellPhase, runInTerminal]);

  const onConnect = useCallback(async () => {
    setError(null);
    // Ask for the line before the terminal exists, so it has one to boot with
    // the moment it does. An address the backend refuses stops here, on the
    // step where the fields are — not as a shell that opens onto nothing.
    let line: string;
    try {
      line = await askBootAt(address, openShell());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBootCommand(line);
    setLaunched(true);
    // Coming back after a machine that never answered: knock again rather than
    // leaving the step stuck on the last verdict.
    setShellPhase("connecting");
    trackFeature("connect_machine_open");
    wiz.next();
  }, [address, wiz]);

  // Who is this shell? Asked, not assumed — the form field says who we DIALLED,
  // and after a handover that is the wrong answer. Knocks on the same rhythm as
  // the readiness probe and for the same reason: a `sudo -i` shell starts a
  // moment after the line that asked for it, and a question typed into the gap
  // is answered by whichever shell was reading, which is the one we're leaving.
  const askWho = useCallback(
    (timeoutMs = 15_000): Promise<string | null> =>
      new Promise((resolve) => {
        whoScrollback.current = "";
        let settled = false;
        const finish = (login: string | null) => {
          if (settled) return;
          settled = true;
          whoWaiter.current = null;
          resolve(login);
        };
        whoWaiter.current = finish;
        const until = Date.now() + timeoutMs;
        const knock = async () => {
          if (settled) return;
          if (Date.now() > until) return finish(null);
          if (!(await runInTerminal(whoProbe()))) return finish(null);
          window.setTimeout(() => void knock(), PROBE_EVERY_MS);
        };
        void knock();
      }),
    [runInTerminal],
  );

  // Make sure the member owns an account here, and that this session is IN it.
  //
  // The account itself is made by the backend over the one ssh door, so a place
  // Aura provisions gets exactly this and not a second implementation of it.
  // What can only happen here is the handover: the wizard's terminal is already
  // signed in as somebody — on a fresh shared box, as the login the image came
  // with — and every command from here on writes something of the member's.
  //
  // Answers with the machine as well as the account, because the caller needs
  // both and asking for the machine a second time would mean saving it twice.
  const ownAccount = useCallback(async (): Promise<{
    acct: MemberAccount;
    m: Machine;
  } | null> => {
    const m = machine ?? (await rememberMachine());
    if (!m) {
      setError(
        "Aura couldn't record this machine's address, so it has nowhere to make your account.",
      );
      return null;
    }
    const acct = await api.placeMemberAccount(m.id);
    setAccount(acct);
    if (acct.is_you) return { acct, m };
    if (!(await runInTerminal(becomeMember(acct.login)))) return null;
    const who = await askWho();
    if (who === acct.login) return { acct, m };
    setError(
      who === null
        ? `Aura made your account (${acct.login}) on this machine, but the terminal never answered after switching to it. Connect again as ${acct.login} — the key you're using is already installed there.`
        : `Aura made your account (${acct.login}) on this machine, but ${who} isn't allowed to become it without a password, so this session is still ${who}. Connect again as ${acct.login} — the key you're using is already installed there.`,
    );
    return null;
  }, [machine, rememberMachine, runInTerminal, askWho]);

  // Start this member from what the team already installed here.
  //
  // The account they just got is empty by design — `place_toolchain` points
  // their crate cache, their rustup and their npm prefix at their own home, so
  // that a teammate's `npm install -g` can't land in it. The cost is that the
  // second person to join a box would download the same gigabytes the first
  // one already has, on the same machine. So the project's declared spec is
  // built once in an account that belongs to nobody, and this copies what it
  // holds into the member's home. What never crosses is anybody's credential;
  // the backend re-checks for one in the moment before a byte moves and
  // refuses out loud if it finds it.
  //
  // Nothing here is allowed to fail the wizard. A member Aura couldn't start
  // warm gets a cold home, which is exactly what they got before this existed
  // — so it is said, in a line of its own, and the sign-in carries on.
  const startFromTeamBase = useCallback(
    async (m: Machine, login: string): Promise<void> => {
      const place = placeOfMachine(m);
      setWarm(null);
      setWarmProblem(null);
      try {
        const base = await askTeamBase(place);
        const wrong = baseWarning(base);
        if (wrong) {
          setWarmProblem(wrong);
          return;
        }
        setWarmNote(
          baseWasBuilt(base)
            ? "Copying the team's environment into your home — nothing to install."
            : "Building the team's environment here. You're first, so this is the install nobody after you waits for.",
        );
        setWarm(await warmStart(place, login));
      } catch (e) {
        setWarmProblem(String(e));
      } finally {
        setWarmNote(null);
      }
    },
    [],
  );

  // Step 2: own an account on the box, mint the runner token on the signed-in
  // Aura account, export it into that account's shell, then kick off the
  // browser sign-in.
  const onPrepare = useCallback(async () => {
    // Never before the box has answered — that is how these commands got lost.
    if (!ptyId || preparing || shellPhase !== "ready") return;
    setPreparing(true);
    setError(null);
    try {
      // On a shared box, everything below belongs to ONE member: a runner token
      // that checks work in as them, a Claude sign-in billed to them, a home
      // directory holding both. So the member gets their own Unix account, and
      // this session becomes it, before any of that is written. Doing it the
      // other way round is what made "a runner per user" mean "a runner per
      // box" — the per-user unit was real, the users were not.
      if (boxKind === "shared") {
        const owned = await ownAccount();
        if (!owned) return; // `ownAccount` has already said why.
        setMemberLogin(owned.acct.login);
        // Now that the home exists and is theirs, fill it from the team's —
        // before the token and the sign-in, because those are seconds and this
        // is the part that would otherwise be minutes of downloading something
        // the machine already has.
        await startFromTeamBase(owned.m, owned.acct.login);
      }
      const prov = await api.runnerProvision(effectiveName);
      // Join the board: export the token in THIS shell (so the runner we start
      // later inherits it) and persist it for a service to pick up — readable
      // by its owner and nobody else, which on a machine with several members
      // is the difference between a token and a shared password.
      await runInTerminal(`export AURA_RUNNER_TOKEN=${shQuote(prov.token)}`);
      await runInTerminal(writeRunnerEnv());
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
  }, [
    ptyId,
    preparing,
    shellPhase,
    boxKind,
    ownAccount,
    startFromTeamBase,
    effectiveName,
    runInTerminal,
  ]);

  // Pull the last of `~/aura-runner.log` off the box and into the panel, so a
  // start that never checks in isn't a silent spinner. Reuses the terminal
  // scrape (see the pty listener above).
  const tailSetupLog = useCallback(async () => {
    awaitingLog.current = true;
    logScrollback.current = "";
    await runInTerminal(tailLogCommand());
  }, [runInTerminal]);

  // Step 3: install the runner as a service, then wait for the board to see it.
  //
  // What the command is, and why it differs on a box you share, lives in
  // `installCommand`. It also closes the token gap: `install` points the unit's
  // `EnvironmentFile` at whichever runner.env it finds — and step 2 has just
  // written `~/.config/aura/runner.env`, which is the first place it looks.
  // Without this the token we minted reached a shell and nothing else: a box
  // whose unit was provisioned by hand keeps its old root-owned env file and
  // never sees the new token at all.
  //
  // We do NOT clear the phase after writing the command — it stays "starting"
  // until the poll below sees the box online or times out, so the UI is honest
  // about the fact that booting takes a moment.
  const onStart = useCallback(async () => {
    if (!ptyId || startPhase === "starting") return;
    setStartPhase("starting");
    setOnline(false);
    setSetupLog(null);
    setError(null);
    startedAtRef.current = Date.now();
    const sent = await runInTerminal(installCommand(effectiveName, boxKind));
    if (!sent) {
      setStartPhase("idle");
      return;
    }
    trackFeature("connect_machine_started");
  }, [ptyId, startPhase, effectiveName, boxKind, runInTerminal]);

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
      // The cloud registry is the only witness that works for the case this
      // wizard exists for — a box somewhere else. And it must be THIS box; see
      // `seenOnBoard` for why the match is exact.
      try {
        const board = await api.cloudRunners();
        if (alive && seenOnBoard(board, effectiveName)) {
          setOnline(true);
          onOnline?.();
          return;
        }
      } catch {
        /* signed out or cloud unreachable — keep polling */
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
  }, [startPhase, prepared, online, effectiveName, onOnline, tailSetupLog]);

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
    <FullscreenOverlay onClose={onClose} tabs={tabs}>
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
                boxKind={boxKind}
                setBoxKind={setBoxKind}
                canConnect={canConnect}
                onConnect={onConnect}
              />
            )}
            {wiz.index === 1 && (
              <StepSetup
                phase={shellPhase}
                preparing={preparing}
                prepared={prepared}
                loginUrl={loginUrl}
                boxKind={boxKind}
                account={account}
                warm={warm}
                warmProblem={warmProblem}
                warmNote={warmNote}
                onPrepare={onPrepare}
                onNext={wiz.next}
              />
            )}
            {wiz.index === 2 && (
              <StepStart
                startPhase={startPhase}
                online={online}
                setupLog={setupLog}
                boxKind={boxKind}
                memberLogin={memberLogin}
                onStart={onStart}
                onDone={onClose}
              />
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-[8px] border border-red/40 bg-red/5 px-3.5 py-2.5 text-sm leading-snug text-red">
                <CircleAlert size={14} className="mt-0.5 shrink-0" />
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Right — the live terminal on the box (persists across steps). */}
        <div className="flex min-w-0 flex-1 flex-col bg-bg-1">
          <div className="flex items-center gap-2 border-b border-line-soft/60 px-4 py-2 text-sm text-text-4">
            <TerminalSquare size={13} />
            {launched ? (
              <span className="truncate">
                {/* The login we are, not the one we dialled — after a handover
                    on a shared box those are two different accounts, and the
                    header is the only place on screen that says which. */}
                {sessionUser}@{host} ·{" "}
                {shellPhase === "ready"
                  ? "connected"
                  : shellPhase === "unreachable"
                    ? "no answer"
                    : "connecting…"}
              </span>
            ) : (
              <span>The machine's terminal opens here once you connect.</span>
            )}
          </div>
          <div className="min-h-0 flex-1">
            {launched && bootCommand ? (
              <Terminal
                instanceId={TERM_INSTANCE}
                repoRoot={repoRoot}
                cwd={repoRoot}
                bootCommand={bootCommand}
                onOpened={(id) => setPtyId(id)}
              />
            ) : (
              <div className="grid h-full place-items-center px-8 text-center text-base text-text-5">
                <div className="flex max-w-[280px] flex-col items-center gap-3">
                  <Cloud size={26} className="text-text-4" />
                  Fill in your machine on the left and press{" "}
                  <span className="text-text-3">Connect</span>. Aura opens a real
                  SSH session here. You'll see everything it runs.
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
      <Header
        icon={<Cloud size={17} />}
        title="Bring a machine"
        sub="Any Linux box you can reach. A cloud VM or a spare server. Aura connects over SSH; your key stays on your Mac and is never uploaded."
      />
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-2">Address</span>
        <Input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="e.g. 203.0.113.10 or box.example.com"
          className="text-base"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-2">
          Sign-in user
        </span>
        <Input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="ubuntu"
          className="text-base"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-2">
          SSH key file
        </span>
        <Input
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
          placeholder="~/.ssh/id_ed25519"
          className="text-base font-mono"
        />
        <span className="text-xs text-text-5">
          The private key that opens this box. Stays local.
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-2">
          Name on your board{" "}
          <span className="font-normal text-text-5">(optional)</span>
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={namePlaceholder}
          className="text-base"
        />
        <span className="text-xs text-text-5">
          What this machine is called on your board. Defaults to its address.
        </span>
      </label>
      {/* Asked here, before anything is done to the box, because it decides
          what the next step DOES — not just how the last one is labelled. On a
          shared machine, step 2 makes you a Unix account of your own and moves
          this session into it before it writes a single credential. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-2">
          Who uses this machine
        </span>
        <SegmentedControl
          value={boxKind}
          onChange={setBoxKind}
          ariaLabel="Who uses this machine"
          options={[
            { value: "mine", label: "Just me" },
            { value: "shared", label: "My team" },
          ]}
        />
        <span className="text-xs leading-snug text-text-5">
          {boxKind === "mine"
            ? "One runner on this machine, draining everything you send it, under the login above."
            : "Aura gives you your own account on it — your own home, your own sign-in, your own runner — so nobody has to share a login with the rest of the team. The login above is only used to set it up."}
        </span>
      </div>
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
      <Header
        icon={<KeyRound size={17} />}
        title="Set up & sign in"
        sub={
          shared
            ? "Aura gives you your own account on this machine, joins it to your cloud board and signs Claude in. The sign-in opens in your browser. You approve with your own account, so the box never sees a password."
            : "Aura joins this machine to your cloud board and signs Claude in. The sign-in opens in your browser. You approve with your own account, so the box never sees a password."
        }
      />
      {phase === "unreachable" ? (
        <>
          <Row alert text="The machine never answered." />
          <p className="text-sm leading-snug text-text-4">
            Aura opened a connection but nothing on the other end replied. That
            is usually the address, the sign-in user, or a key this box won't
            accept. Go back a step, check them, and connect again.
          </p>
        </>
      ) : phase !== "ready" ? (
        <Row spinner text="Waiting for the machine to answer…" />
      ) : !prepared ? (
        <>
          <Row ok text="Connected to the machine." />
          <p className="text-sm leading-snug text-text-4">
            {shared ? (
              <>
                Next, Aura makes you a user of your own on this machine, moves
                this terminal into it, then mints a runner token on your account
                and runs <code className="text-text-3">claude setup-token</code>{" "}
                there. Your teammates get their own the same way — nobody shares
                a login.
              </>
            ) : (
              <>
                Next, Aura mints a runner token on your account, exports it on
                the box, and runs{" "}
                <code className="text-text-3">claude setup-token</code> for you.
              </>
            )}
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
          {warmNote && <Row spinner text={warmNote} />}
        </>
      ) : (
        <>
          {account && <AccountRows account={account} />}
          <WarmRows warm={warm} problem={warmProblem} />
          <Row ok text="Machine joined to your board." />
          {loginUrl ? (
            <>
              <p className="text-sm leading-snug text-text-4">
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
            I've pasted the code. Continue
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
      <Header
        icon={<Cloud size={17} />}
        title="Start your machine"
        sub="Turn the runner on as a service, so it comes back on its own after a restart. It stays awake once you close your Mac and drains every project you send it."
      />
      {online ? (
        <>
          <Row ok text="Your machine is online." />
          <p className="text-sm leading-snug text-text-4">
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
          <p className="text-sm leading-snug text-text-4">
            A cold box can take a minute, but this is longer than usual. Here's
            the tail of its startup log. It usually says what went wrong (aura
            not installed on the box, a bad token, or no network).
          </p>
          {setupLog ? (
            <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-[8px] border border-line-soft bg-bg-1 px-3 py-2.5 font-mono text-xs leading-relaxed text-text-3">
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
          {/* What gets installed follows from who uses the machine, which was
              answered in step 1 and acted on in step 2. Saying it again here is
              the last chance to notice it's wrong before a service exists. */}
          <p className="text-xs leading-snug text-text-4">
            {boxKind === "mine" ? (
              "One runner on this machine, draining everything you send it."
            ) : memberLogin ? (
              <>
                Your runner is installed under{" "}
                <code className="text-text-3">{memberLogin}</code>, the account
                Aura made for you here, and starts on its own after a reboot
                without anyone logged in. It keeps its own sign-in, its own
                files and its own spending. Your teammates connect the same way
                and get their own.
              </>
            ) : (
              <>
                Your runner is installed under the account you're signed in as
                on this machine. Go back to <em>Set up &amp; sign in</em> first
                if you haven't — that's the step that gives you an account of
                your own.
              </>
            )}
          </p>
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
              text="Starting your machine. Waiting for your board to see it…"
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * What the box said about this member's own account.
 *
 * Every line is read back off the machine rather than inferred from what we
 * asked for. "Your home is closed to everyone else" because a `chmod` was sent
 * is not the same claim as because the box then said `drwx------`, and on this
 * screen only the second one is worth making — the whole promise is that a
 * teammate cannot read your credentials, and a promise nobody checked is how
 * that stops being true quietly.
 */
function AccountRows({ account }: { account: MemberAccount }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Row
        ok
        text={
          account.created
            ? `Made you an account of your own here: ${account.login}.`
            : `You already had an account here: ${account.login}.`
        }
      />
      {account.private ? (
        <Row ok text="Your home directory is closed to everyone else on this machine." />
      ) : (
        <Row
          alert
          text={`Aura couldn't close ${account.home} to the other people on this machine. Anything it holds may be readable by them.`}
        />
      )}
      {!account.umask && (
        <Row
          alert
          text="Files you create here later may be readable by the others — Aura couldn't set a umask in your profile."
        />
      )}
      {account.linger === "off" && (
        <Row
          alert
          text="Your runner won't come back on its own after a reboot until someone with root on this machine turns lingering on for you."
        />
      )}
      {account.linger === "unavailable" && (
        <Row
          alert
          text="This machine has no systemd user services, so your runner can only run while you're logged in."
        />
      )}
      {account.key === "absent" && (
        <Row
          alert
          text={`Nothing was installed to let you in as ${account.login} directly, so you'll keep arriving through the login you connected with.`}
        />
      )}
      {account.swap === "added" && (
        <Row
          ok
          text="Added swap to this machine, so a build that runs out of memory slows down instead of taking the box with it."
        />
      )}
      {account.swap === "none" && (
        <Row
          alert
          text="This machine has no swap and Aura couldn't add any. Your runner still has a memory limit, but a build that reaches it will be killed rather than slowed."
        />
      )}
    </div>
  );
}

/** What joining this place cost — the install this member paid, or the one
 *  somebody already paid for them.
 *
 *  Quiet when there is nothing to report. A machine the team has never built an
 *  environment on has no news here, and a row saying so would be a line about
 *  something not happening on every first connection anybody ever makes. The
 *  shortfall is a row of its own because it fails apart from the good news: a
 *  home that looks warm and is short otherwise announces itself in the middle of
 *  a build. */
function WarmRows({
  warm,
  problem,
}: {
  warm: BaseBuild | null;
  problem: string | null;
}) {
  if (problem) {
    return <Row alert text={problem} />;
  }
  if (!warm) return null;
  // Nothing built, nothing copied, nobody waiting — the first person on a box
  // whose project declares no environment. True, and not worth a line.
  if (!warm.start.warm && warm.already_built && !warm.start.refused) return null;
  const short = warmShortfall(warm.start);
  return (
    <>
      <Row
        ok={!warm.start.refused}
        alert={!!warm.start.refused}
        text={warmSentence(warm)}
      />
      {short && <Row alert text={short} />}
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
        <h2 className="text-md font-semibold text-text-1">{title}</h2>
        <p className="mt-1 text-sm leading-snug text-text-4">{sub}</p>
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
      className={`flex items-center gap-2 text-base ${
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
