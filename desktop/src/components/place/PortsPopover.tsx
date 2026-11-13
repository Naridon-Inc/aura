// The Ports popover — what a place is serving, and the way to open it here.
//
// It hangs off a TopBar button and is only mounted when the workspace on
// screen runs on a place other than this laptop: on this laptop the ports are
// already here, and a button that said "bring them over" would be a lie.
//
// Two rhythms. While the popover is open it asks the place every five seconds,
// so a dev server that comes up while you watch appears without a click. While
// it is closed but the workspace is active it asks every thirty, which is what
// keeps the badge honest and what carries "forward new ports automatically" —
// the backend applies that setting on each ask, so there is no second timer.
//
// The trigger is handed in rather than drawn here so the header decides what
// the button looks like; this file owns only what opens under it.
//
// What opens is the library's cloud details popover holding its port
// forwarding block — the same rows, switch row and notes the machine details
// use — anchored to that handed-in trigger. The trigger keeps its own click
// (it toggles), so a press on it is not also read as a click outside.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Network } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Switch } from "../ui/switch";
import { openExternal } from "../../lib/openExternal";
import {
  getSessionLive,
  liveSessionIds,
  openSessionTunnel,
} from "../../lib/sessionLiveStore";
import {
  placePortForward,
  placePortRelease,
  placePortsList,
  placePortsPolicySet,
  type PortsReport,
} from "../../lib/place/ports";
import { PortRow, type PortLine } from "./PortRow";
import "../ui/cloud-patterns.css";
import "../ui/ports.css";

/** Ask the place this often while the popover is open. */
const OPEN_EVERY_MS = 5_000;
/** And this often while it is closed but the workspace is on screen. */
const CLOSED_EVERY_MS = 30_000;

type Props = {
  machineId: string;
  repoRoot?: string | null;
  /** The TopBar button. `badge` is how many forwards are live right now. */
  trigger: (t: {
    active: boolean;
    onClick: () => void;
    badge: number;
    title: string;
  }) => ReactNode;
};

/** Listening ports and held forwards, folded into one list: a port that is
 *  both listening and forwarded is one row, and a forward whose port has gone
 *  quiet over there is still a row, because the member opened it. */
function linesOf(report: PortsReport): PortLine[] {
  const auto = new Set(report.auto_forwarded);
  const lines: PortLine[] = report.ports.map((p) => ({
    port: p.port,
    process: p.process,
    localPort: p.local_port,
    url: p.url,
    listening: true,
    auto: auto.has(p.port),
  }));
  const seen = new Set(lines.map((l) => l.port));
  for (const f of report.forwarded) {
    if (seen.has(f.remote_port)) continue;
    lines.push({
      port: f.remote_port,
      process: null,
      localPort: f.local_port,
      url: f.url,
      listening: false,
      auto: false,
    });
  }
  return lines.sort((a, b) => a.port - b.port);
}

/** The session this app is hosting live, if there is exactly one to share
 *  into. A tunnel is offered to a room; with no room open there is nowhere to
 *  offer it. */
function hostedSessionId(): string | null {
  const hosting = liveSessionIds().filter((id) => getSessionLive(id).role === "host");
  return hosting.length === 1 ? hosting[0] : null;
}

export function PortsPopover({ machineId, repoRoot, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<PortsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ port: number; verb: "open" | "stop" | "share" } | null>(
    null,
  );
  const [shared, setShared] = useState<string | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await placePortsList(machineId, repoRoot);
      if (!alive.current) return;
      setReport(next);
      setProblem(null);
    } catch (e) {
      if (!alive.current) return;
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [machineId, repoRoot]);

  // A new place is a new list; don't show the old one's ports over it.
  useEffect(() => {
    setReport(null);
    setShared(null);
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const every = open ? OPEN_EVERY_MS : CLOSED_EVERY_MS;
    const timer = window.setInterval(() => void refresh(), every);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function onOpen(line: PortLine) {
    setBusy({ port: line.port, verb: "open" });
    setProblem(null);
    try {
      const url = line.url ?? (await placePortForward(machineId, line.port)).url;
      await openExternal(url);
      await refresh();
    } catch (e) {
      if (alive.current) setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function onStop(line: PortLine) {
    setBusy({ port: line.port, verb: "stop" });
    setProblem(null);
    try {
      await placePortRelease(machineId, line.port);
      await refresh();
    } catch (e) {
      if (alive.current) setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function onShare(line: PortLine) {
    if (line.localPort === null) return;
    const sessionId = hostedSessionId();
    if (!sessionId) {
      setShared("Share a session first — a port is shared into the session you're hosting.");
      return;
    }
    setBusy({ port: line.port, verb: "share" });
    setProblem(null);
    try {
      const label = line.process ? `${line.process} :${line.port}` : `:${line.port}`;
      const tunnel = await openSessionTunnel(sessionId, line.localPort, label);
      if (!alive.current) return;
      setShared(
        tunnel
          ? `Shared with your session as ${tunnel.display ?? tunnel.url}.`
          : "The session didn't take the port. Try again once it's connected.",
      );
    } catch (e) {
      if (alive.current) setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function onToggleAuto() {
    if (!report) return;
    const want = !report.auto_forward;
    setReport({ ...report, auto_forward: want });
    try {
      await placePortsPolicySet(machineId, want);
      await refresh();
    } catch (e) {
      if (alive.current) setProblem(e instanceof Error ? e.message : String(e));
    }
  }

  const lines = report ? linesOf(report) : [];
  const live = report ? report.forwarded.length : 0;
  const place = report?.place ?? "the place";
  const title =
    live === 0
      ? "Ports"
      : live === 1
        ? "Ports — 1 open on your Mac"
        : `Ports — ${live} open on your Mac`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span ref={anchorRef} className="ui-ports-anchor">
          {trigger({ active: open, onClick: () => setOpen((v) => !v), badge: live, title })}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        collisionPadding={12}
        className="ui-cloud-details ui-ports"
        onInteractOutside={(e) => {
          // The trigger toggles on its own click; letting this close it too
          // would close and reopen in one press.
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        <header>
          <strong>Listening on {place}</strong>
          {loading && <AsciiSpinner size={11} />}
        </header>
        <div className="ui-cloud-ports">
          {lines.length === 0 && !loading && (
            <p className={problem ? "ui-cloud-error" : undefined}>
              {problem
                ? problem
                : `Nothing is listening on ${place} yet. Start a dev server there and it shows up here.`}
            </p>
          )}
          {lines.length === 0 && loading && (
            <p className="ui-cloud-note">
              <AsciiSpinner size={11} /> Asking {place}…
            </p>
          )}
          {lines.map((line) => (
            <PortRow
              key={line.port}
              line={line}
              busy={busy?.port === line.port ? busy.verb : null}
              onOpen={() => void onOpen(line)}
              onStop={() => void onStop(line)}
              onShare={() => void onShare(line)}
            />
          ))}
          {lines.length > 0 && problem && <p className="ui-cloud-error">{problem}</p>}
          {shared && <p className="ui-cloud-note">{shared}</p>}
        </div>
        <section>
          <div className="ui-cloud-row">
            <Network size={14} />
            <strong>Forward new ports automatically</strong>
            <Switch
              checked={report?.auto_forward ?? false}
              disabled={!report}
              onCheckedChange={() => void onToggleAuto()}
              aria-label="Forward new ports automatically"
            />
          </div>
          <p className="ui-cloud-note">
            Anything that starts listening on {place} opens on your Mac by itself.
          </p>
        </section>
      </PopoverContent>
    </Popover>
  );
}
