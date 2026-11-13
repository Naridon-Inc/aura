// The ports block under a running command in a box workspace's Run panel:
// what that machine is forwarding to this laptop, and the switch that turns
// forwarding on.
//
// It is the same `place_ports` family the place view's Ports popover uses —
// nothing here opens a connection itself. "Forward ports" on means the
// machine's new listening ports are brought over as they appear (the
// backend applies that on each read, so this block's timer is what carries
// it); off lets every forward go. A port can also be added by number.
//
// It is only mounted while the command runs, so it only asks the machine
// then, and only while the window is in front.

import { useCallback, useEffect, useRef, useState } from "react";

import { openExternal } from "../../lib/openExternal";
import {
  placePortForward,
  placePortRelease,
  placePortsList,
  placePortsPolicySet,
  type PortsReport,
} from "../../lib/place/ports";
import type { WorkAt } from "../../lib/place/placeWork";
import { CloudPortForwarding, type ForwardedPort } from "../ui/cloud-workspace";

/** How often the machine is asked again while the command runs. */
const READ_EVERY_MS = 5000;

/** The forwards held for the machine, named by what listens behind them. */
export function forwardedPorts(report: PortsReport | null): ForwardedPort[] {
  if (!report) return [];
  const names = new Map(report.ports.map((p) => [p.port, p.process]));
  return report.forwarded
    .map((f) => ({
      remote: f.remote_port,
      local: f.local_port,
      process: names.has(f.remote_port)
        ? (names.get(f.remote_port) ?? "")
        : "not listening",
    }))
    .sort((a, b) => a.remote - b.remote);
}

/** On while the machine brings new ports over, or while any are held. */
export function forwardingOn(report: PortsReport | null): boolean {
  return !!report && (report.auto_forward || report.forwarded.length > 0);
}

export function CloudBoxPorts({ at }: { at: WorkAt }) {
  const [report, setReport] = useState<PortsReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const { machineId, repoRoot } = at;
  const refresh = useCallback(async () => {
    try {
      const next = await placePortsList(machineId, repoRoot);
      if (!alive.current) return;
      setReport(next);
      setProblem(null);
    } catch (e) {
      if (alive.current) setProblem(e instanceof Error ? e.message : String(e));
    }
  }, [machineId, repoRoot]);

  useEffect(() => {
    setReport(null);
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, READ_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      setProblem(null);
      try {
        await work();
      } catch (e) {
        if (alive.current) setProblem(e instanceof Error ? e.message : String(e));
      }
      await refresh();
    },
    [refresh],
  );

  const onEnabledChange = (on: boolean) => {
    if (report) setReport({ ...report, auto_forward: on, forwarded: on ? report.forwarded : [] });
    void act(async () => {
      await placePortsPolicySet(machineId, on);
      if (!on && report) {
        await Promise.all(report.forwarded.map((f) => placePortRelease(machineId, f.remote_port)));
      }
    });
  };

  const urlOf = (port: ForwardedPort) =>
    report?.forwarded.find((f) => f.remote_port === port.remote)?.url ??
    `http://localhost:${port.local}`;

  return (
    <>
      <CloudPortForwarding
        ports={forwardedPorts(report)}
        enabled={forwardingOn(report)}
        onEnabledChange={onEnabledChange}
        onAdd={(port) => void act(() => placePortForward(machineId, port))}
        onRemove={(port) => void act(() => placePortRelease(machineId, port))}
        onOpen={(port) => void openExternal(urlOf(port)).catch((e) => setProblem(String(e)))}
      />
      {problem && <p className="ui-cloud-error">{problem}</p>}
    </>
  );
}
