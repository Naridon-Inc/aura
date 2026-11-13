// Adding a computer: one screen, three ways, no title.
//
//   Get one from Aura         → the existing get-a-computer flow takes over
//   Use a computer you have   → one line to paste on it, then "Connected ✓"
//   Use this computer         → a plain yes, then this computer joins itself
//
// Whichever way it came, a connected computer reads the same here and is the
// same row in the list afterwards. Nothing is typed but the one pasted line,
// and the code inside that line is single-use and gone in ten minutes; for
// this computer the code never reaches the page at all (cmd_pair_computer.rs).

import { useCallback, useEffect, useRef, useState } from "react";

import { CircleCheck, Cloud, Laptop, Server } from "lucide-react";

import {
  computerLine,
  joinedNotes,
  minutesLeft,
  pairComputerCancel,
  pairComputerStart,
  pairComputerStatus,
  pairThisComputer,
  settled,
  waitingLine,
  type JoinReport,
  type PairedComputer,
  type PairIssued,
  type PairScope,
  type PairStatus,
} from "../../../lib/pairComputer";
import { writeClipboardText } from "../../../lib/clipboard";
import { FullscreenOverlay } from "../../FullscreenOverlay";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { ErrorState, LoadingState } from "../../ui/state";
import "../../ui/cloud-onboarding.css";
import "../../ui/make-place.css";
import "../../ui/add-computer.css";

/** How often a waiting code is asked about. A person is watching. */
const WATCH_MS = 2_000;
/** After this long with no word from this computer, say so. */
const SLOW_MS = 90_000;

export type AddComputerWay = "aura" | "own" | "this";

export function AddComputer({
  onClose,
  onGetOne,
  onConnected,
  onSsh,
  initial = null,
}: {
  onClose: () => void;
  /** "Get one from Aura": hand over to the get-a-computer flow. */
  onGetOne: () => void;
  /** A computer is connected; the list behind this reloads. */
  onConnected: () => void;
  initial?: Exclude<AddComputerWay, "aura"> | null;
  /** The older way for a computer you have: its address and key, over SSH.
   *  Offered under the pasted line for whoever needs it. */
  onSsh?: () => void;
}) {
  const [way, setWay] = useState<Exclude<AddComputerWay, "aura"> | null>(initial);
  const pick = (next: AddComputerWay) => (next === "aura" ? onGetOne() : setWay(next));
  return (
    <FullscreenOverlay onClose={onClose}>
      <div className="ui-make-place">
        <div className="ui-cloud-setup-page ui-add-computer">
          <Ways way={way} onPick={pick} />
          {way === "own" && <OwnComputer onConnected={onConnected} />}
          {way === "own" && onSsh && (
            <Button variant="link" size="sm" onClick={onSsh}>
              Set it up over SSH instead
            </Button>
          )}
          {way === "this" && <ThisComputer onConnected={onConnected} />}
        </div>
      </div>
    </FullscreenOverlay>
  );
}

const WAYS: { id: AddComputerWay; icon: typeof Cloud; label: string; hint: string }[] = [
  { id: "aura", icon: Cloud, label: "Get one from Aura", hint: "We set up a computer in the cloud for you." },
  {
    id: "own",
    icon: Server,
    label: "Use a computer you have",
    hint: "A server or another computer. You paste one line on it.",
  },
  {
    id: "this",
    icon: Laptop,
    label: "Use this computer",
    hint: "Aura keeps running here in the background while it's on.",
  },
];

/** The three ways, as one list of rows. */
export function Ways({ way, onPick }: { way: AddComputerWay | null; onPick: (way: AddComputerWay) => void }) {
  return (
    <div className="ui-make-place-sizes" role="radiogroup" aria-label="How to add a computer">
      {WAYS.map(({ id, icon: Icon, label, hint }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={way === id}
          className="ui-make-place-size"
          onClick={() => onPick(id)}
        >
          <Icon aria-hidden />
          <span>
            <strong>{label}</strong>
            <small>{hint}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

/** "Connected ✓ build-box · 24 cores · 188 GB" — the same for every way in. */
export function Connected({ computer }: { computer: Pick<PairedComputer, "name" | "cpus" | "memory_gb"> }) {
  return (
    <div className="ui-add-computer-done" role="status">
      <CircleCheck aria-hidden />
      <span>
        Connected <span aria-hidden>✓</span> {computerLine(computer)}
      </span>
    </div>
  );
}

/** Asks about one code until it settles, and says once when it connected. */
function useWatch(id: string | null, onConnected: () => void) {
  const [status, setStatus] = useState<PairStatus | null>(null);
  const told = useRef(false);
  // Read through a ref, so a parent that re-renders with a new function does
  // not restart the watch.
  const tell = useRef(onConnected);
  tell.current = onConnected;
  useEffect(() => {
    setStatus(null);
    if (!id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      pairComputerStatus(id)
        .then((next) => {
          if (!live) return;
          setStatus(next);
          if (next.state === "connected" && !told.current) {
            told.current = true;
            tell.current();
          }
          if (!settled(next.state)) timer = setTimeout(ask, WATCH_MS);
        })
        // A missed answer is asked again; the screen keeps saying it waits.
        .catch(() => {
          if (live) timer = setTimeout(ask, WATCH_MS);
        });
    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);
  return status;
}

function OwnComputer({ onConnected }: { onConnected: () => void }) {
  const [scope, setScope] = useState<PairScope>("personal");
  const [issued, setIssued] = useState<PairIssued | null>(null);
  const [failed, setFailed] = useState("");
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [round, setRound] = useState(0);
  const status = useWatch(issued?.id ?? null, onConnected);
  // The code on screen. Replacing it (a new line, or the other kind) throws
  // it away; closing the screen does not, since the line may already be on
  // its way to the computer.
  const shown = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setIssued(null);
    setFailed("");
    setCopied(null);
    pairComputerStart(scope)
      .then((next) => {
        if (!live) {
          // Asked for by a screen that has moved on: nobody saw it.
          void pairComputerCancel(next.id).catch(() => undefined);
          return;
        }
        shown.current = next.id;
        setIssued(next);
      })
      .catch((e) => live && setFailed(String(e)));
    return () => {
      live = false;
    };
  }, [scope, round]);

  const replace = (then: () => void) => {
    const old = shown.current;
    shown.current = null;
    if (old) void pairComputerCancel(old).catch(() => undefined);
    then();
  };

  const copy = useCallback(async () => {
    if (!issued) return;
    setCopied((await writeClipboardText(issued.install)) ? "yes" : "no");
  }, [issued]);

  return (
    <OwnComputerView
      issued={issued}
      status={status}
      failed={failed}
      copied={copied}
      scope={scope}
      onCopy={() => void copy()}
      onScope={(next) => replace(() => setScope(next))}
      onAgain={() => replace(() => setRound((n) => n + 1))}
    />
  );
}

/** The pasted line and what became of it. Pure, so it can be pinned. */
export function OwnComputerView({
  issued,
  status,
  failed,
  copied,
  scope,
  onCopy,
  onScope,
  onAgain,
  now = Date.now(),
}: {
  issued: PairIssued | null;
  status: PairStatus | null;
  failed: string;
  copied: "yes" | "no" | null;
  scope: PairScope;
  onCopy: () => void;
  onScope: (scope: PairScope) => void;
  onAgain: () => void;
  now?: number;
}) {
  const share = (
    <label className="ui-add-computer-share">
      <Checkbox
        checked={scope === "team"}
        onCheckedChange={(on) => onScope(on === true ? "team" : "personal")}
        disabled={status?.state === "connected"}
      />
      <span>Everyone in the team can use it</span>
    </label>
  );
  if (!issued) {
    return failed ? (
      <>
        <ErrorState size="sm" title="Aura couldn't make the line" message={failed} onRetry={onAgain} />
        {scope === "team" && share}
      </>
    ) : (
      <LoadingState label="Making your line…" size="sm" />
    );
  }
  const state = status?.state ?? "waiting";
  if (state === "connected" && status?.computer) {
    return (
      <div className="ui-add-computer-step">
        <Connected computer={status.computer} />
        <small>
          {status.scope === "team"
            ? "Everyone in the team can use it now."
            : "It's yours to use now. Nobody else in the team can."}{" "}
          To take it off, run <code>aura leave</code> on it.
        </small>
      </div>
    );
  }
  const minutes = minutesLeft(issued.expires_at, now);
  return (
    <div className="ui-add-computer-step">
      <p>Paste this on the computer and press Enter.</p>
      <div className="ui-add-computer-line">
        <code>{issued.install}</code>
        <Button size="sm" variant="secondary" onClick={onCopy}>
          {copied === "yes" ? "Copied" : "Copy"}
        </Button>
      </div>
      {copied === "no" && <small data-tone="error">Couldn't copy. Select the line and copy it yourself.</small>}
      <small>
        Works on a Mac or Linux computer. The line works once
        {minutes > 0 ? `, in the next ${minutes} ${minutes === 1 ? "minute" : "minutes"}` : ""}.
      </small>
      <div className="ui-add-computer-wait" role="status">
        {settled(state) ? null : <AsciiSpinner />}
        <span>{waitingLine(state)}</span>
        {settled(state) && (
          <Button size="sm" variant="ghost" onClick={onAgain}>
            Make a new line
          </Button>
        )}
      </div>
      {share}
    </div>
  );
}

type ThisPhase =
  | { at: "ask" }
  | { at: "joining" }
  | { at: "joined"; report: JoinReport }
  | { at: "failed"; message: string };

function ThisComputer({ onConnected }: { onConnected: () => void }) {
  const [phase, setPhase] = useState<ThisPhase>({ at: "ask" });
  const [slow, setSlow] = useState(false);
  const report = phase.at === "joined" ? phase.report : null;
  // A computer that was already connected spent no code; there is nothing to
  // watch, and it is already in the list.
  const watching = report && report.state === "connected" ? report.pair_id : null;
  const status = useWatch(watching, onConnected);

  useEffect(() => {
    if (!watching) return;
    setSlow(false);
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [watching]);

  const go = () => {
    setPhase({ at: "joining" });
    pairThisComputer()
      .then((r) => {
        setPhase(r.ok ? { at: "joined", report: r } : { at: "failed", message: r.message });
        if (r.ok && r.state === "already_connected") onConnected();
      })
      .catch((e) => setPhase({ at: "failed", message: String(e) }));
  };

  return <ThisComputerView phase={phase} status={status} slow={slow} onGo={go} />;
}

/** Asking first, then what happened. Pure, so it can be pinned. */
export function ThisComputerView({
  phase,
  status,
  slow,
  onGo,
}: {
  phase: ThisPhase;
  status: PairStatus | null;
  slow: boolean;
  onGo: () => void;
}) {
  if (phase.at === "ask") {
    return (
      <div className="ui-add-computer-step">
        <p>
          Aura will keep running on this computer in the background, so your chats can use it while it's on. It only
          reaches out to Aura — nothing can connect in — and only you can use it.
        </p>
        <small>You can take it off any time by running aura leave.</small>
        <div>
          <Button onClick={onGo}>Connect this computer</Button>
        </div>
      </div>
    );
  }
  if (phase.at === "joining") {
    return (
      <div className="ui-add-computer-wait" role="status">
        <AsciiSpinner />
        <span>Connecting this computer…</span>
      </div>
    );
  }
  if (phase.at === "failed") {
    return <ErrorState size="sm" title="This computer isn't connected" message={phase.message} onRetry={onGo} />;
  }
  const { report } = phase;
  const notes = joinedNotes(report);
  const computer =
    status?.state === "connected" && status.computer
      ? status.computer
      : report.state === "already_connected"
        ? { name: report.name ?? "This computer", cpus: null, memory_gb: null }
        : null;
  return (
    <div className="ui-add-computer-step">
      {computer ? (
        <Connected computer={computer} />
      ) : (
        <div className="ui-add-computer-wait" role="status">
          <AsciiSpinner />
          <span>
            {slow ? "It's taking longer than usual. Check that this computer is online." : "Starting Aura here…"}
          </span>
        </div>
      )}
      {report.state === "already_connected" && <small>{report.message}</small>}
      {notes.length > 0 && (
        <ul className="ui-add-computer-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
