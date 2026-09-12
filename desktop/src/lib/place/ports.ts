// Ports on a place, as this Mac sees them.
//
// Work on a box starts a dev server the way work here does, and something is
// listening on port 3000 — over there. This file is how a surface asks what
// is listening, brings one of those ports to `localhost` on this Mac, and lets
// it go again. Nothing here opens a connection itself: every call goes to the
// backend's `place_ports` family, which reaches the place the way every other
// place verb does, and holds the forward as a child it can stop.
//
// Mirrors `manager::brain::place_ports` field for field. A port is a `number`
// on both sides; a `machineId` is the book's key, and `null` means this laptop,
// whose ports were never anywhere else.

import { invoke } from "@tauri-apps/api/core";

/** One port on a place, with where it is on this Mac if it has been brought
 *  over. `local_port` and `url` are null until then. */
export type PortRow = {
  port: number;
  pid: number | null;
  /** The process listening, as the place named it — `node`, `python3`. Null
   *  when the place could not say (another login's process). */
  process: string | null;
  /** The address it is bound to over there, as the place spelled it. */
  address: string;
  local_port: number | null;
  url: string | null;
};

/** A port on a place, answering on this Mac. */
export type Forwarded = {
  place: string;
  machine_id: string | null;
  remote_port: number;
  local_port: number;
  /** What to open: `http://localhost:<local_port>`. */
  url: string;
  pid: number | null;
};

/** Everything the Ports surface draws, in one round trip. */
export type PortsReport = {
  /** The place, in words for a person — "this laptop", or the box's name. */
  place: string;
  machine_id: string | null;
  ports: PortRow[];
  /** Every forward held for this place, including ones whose port has since
   *  stopped listening over there — a row a member opened is theirs to close. */
  forwarded: Forwarded[];
  auto_forward: boolean;
  /** Ports this call forwarded on its own because `auto_forward` is on. */
  auto_forwarded: number[];
};

/** Whether a place gets its new ports brought over without being asked. */
export type PortsPolicy = {
  auto_forward: boolean;
};

/** What is listening on a place, and what of it is already on this Mac.
 *
 *  Applies the place's auto-forward setting on the way, so a surface that
 *  refreshes this every few seconds is how "forward new ports automatically"
 *  happens — there is no second timer anywhere. */
export function placePortsList(
  machineId: string | null,
  repoRoot?: string | null,
): Promise<PortsReport> {
  return invoke<PortsReport>("place_ports_list", {
    root: repoRoot ?? null,
    machineId,
  });
}

/** Bring one port on the place to `localhost` on this Mac.
 *
 *  The same number when it is free here, else the next free one above it.
 *  Asking twice for the same port answers with the forward already held. */
export function placePortForward(
  machineId: string,
  remotePort: number,
  localPort?: number,
): Promise<Forwarded> {
  return invoke<Forwarded>("place_port_forward", {
    machineId,
    remotePort,
    localPort: localPort ?? null,
  });
}

/** Let one forward go. Answers with what is still held for the place. */
export function placePortRelease(
  machineId: string,
  remotePort: number,
): Promise<Forwarded[]> {
  return invoke<Forwarded[]>("place_port_release", { machineId, remotePort });
}

/** Every forward held for a place right now. */
export function placePortsForwarded(machineId: string): Promise<Forwarded[]> {
  return invoke<Forwarded[]>("place_ports_forwarded", { machineId });
}

/** Does this place get its new ports forwarded without being asked? */
export function placePortsPolicy(machineId: string): Promise<PortsPolicy> {
  return invoke<PortsPolicy>("place_ports_policy", { machineId });
}

/** Turn automatic forwarding on or off for one place. */
export function placePortsPolicySet(
  machineId: string,
  autoForward: boolean,
): Promise<PortsPolicy> {
  return invoke<PortsPolicy>("place_ports_policy_set", { machineId, autoForward });
}

/** The first `http://localhost:<port>` (or 127.0.0.1 / 0.0.0.0) in a run of
 *  terminal output, as the port number. Null when there is none.
 *
 *  What a dev server prints when it comes up, in the shapes the common ones
 *  use — `Local: http://localhost:5173/`, `listening on http://0.0.0.0:3000`,
 *  `http://127.0.0.1:8000`. A bare `localhost:3000` without a scheme is left
 *  alone: too many things print `host:port` pairs that are not a page. */
export function localUrlPort(text: string): number | null {
  const m = LOCAL_URL.exec(text);
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port <= 65535 ? port : null;
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})/i;
