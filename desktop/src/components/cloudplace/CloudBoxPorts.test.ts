import { describe, expect, test } from "bun:test";

import type { PortsReport } from "../../lib/place/ports";
import { forwardedPorts, forwardingOn } from "./CloudBoxPorts";

const report = (over: Partial<PortsReport> = {}): PortsReport => ({
  place: "box",
  machine_id: "m1",
  ports: [],
  forwarded: [],
  auto_forward: false,
  auto_forwarded: [],
  ...over,
});

const fwd = (remote: number, local: number) => ({
  place: "box",
  machine_id: "m1",
  remote_port: remote,
  local_port: local,
  url: `http://localhost:${local}`,
  pid: null,
});

const listening = (port: number, process: string | null) => ({
  port,
  pid: 1,
  process,
  address: "0.0.0.0",
  local_port: null,
  url: null,
});

describe("forwardedPorts", () => {
  test("nothing read yet is no rows", () => {
    expect(forwardedPorts(null)).toEqual([]);
  });

  test("a forward is named by what listens behind it, in port order", () => {
    const rows = forwardedPorts(
      report({
        ports: [listening(5173, "node"), listening(8000, null)],
        forwarded: [fwd(8000, 8001), fwd(5173, 5173)],
      }),
    );
    expect(rows).toEqual([
      { remote: 5173, local: 5173, process: "node" },
      { remote: 8000, local: 8001, process: "" },
    ]);
  });

  test("a forward whose port went quiet says so", () => {
    expect(forwardedPorts(report({ forwarded: [fwd(3000, 3000)] }))).toEqual([
      { remote: 3000, local: 3000, process: "not listening" },
    ]);
  });

  test("a listening port nobody forwarded is not a row", () => {
    expect(forwardedPorts(report({ ports: [listening(3000, "node")] }))).toEqual([]);
  });
});

describe("forwardingOn", () => {
  test("off until read", () => {
    expect(forwardingOn(null)).toBe(false);
  });
  test("on while new ports come over on their own", () => {
    expect(forwardingOn(report({ auto_forward: true }))).toBe(true);
  });
  test("on while a forward is held, even with auto off", () => {
    expect(forwardingOn(report({ forwarded: [fwd(3000, 3000)] }))).toBe(true);
  });
  test("off with neither", () => {
    expect(forwardingOn(report())).toBe(false);
  });
});
