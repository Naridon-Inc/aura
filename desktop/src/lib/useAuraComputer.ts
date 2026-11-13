// The team's Aura computer, read once and shared by every screen showing it.
//
// The setup page, the settings page and the wizard all show the same
// computer. Each used to read it on its own timer, and the setup page read it
// every fifteen seconds whether or not anything was changing — dozens of
// reads of a computer that was simply ready. Now there is one read for all of
// them: when the first screen opens, when the window comes back into focus or
// the organization changes, and on a timer only while something is actually
// moving — a boot, a wake, a payment page open in the browser.

import { useEffect, useSyncExternalStore } from "react";

import { auraComputerStatus, moving, type AuraComputerStatus } from "./auraComputer";
import { onOrgChanged } from "./cloudOrgs";

export type AuraComputerRead = {
  /** Null until the first read lands. */
  status: AuraComputerStatus | null;
  /** The last read failed, in a sentence. `status` is still the one before it. */
  problem: string;
};

/** Someone is watching it move: the steps tick over as they happen. */
export const WATCHING_MS = 4_000;
/** A page that shows it among other things. */
export const GLANCING_MS = 15_000;
/** A screen that opens right after a read is given that read. */
const FRESH_MS = 3_000;

const EMPTY: AuraComputerRead = { status: null, problem: "" };
let current: AuraComputerRead = EMPTY;
let readAt = 0;
let inflight: Promise<AuraComputerStatus | null> | null = null;
// Bumped by an organization change, so a read sent for the old one is dropped.
let generation = 0;
const listeners = new Set<() => void>();
let unhook: (() => void) | null = null;

function publish(next: AuraComputerRead): void {
  current = next;
  for (const l of listeners) l();
}

/** Read it now, sharing a read already on its way. */
export function readAuraComputer(): Promise<AuraComputerStatus | null> {
  if (inflight) return inflight;
  const mine = generation;
  const p: Promise<AuraComputerStatus | null> = auraComputerStatus()
    .then(
      (status) => {
        if (mine !== generation) return current.status;
        readAt = Date.now();
        publish({ status, problem: "" });
        return status;
      },
      (e) => {
        if (mine !== generation) return current.status;
        readAt = Date.now();
        publish({ status: current.status, problem: String(e) });
        return current.status;
      },
    )
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** What an action — wake, retry, start, a new size — answered with: the
 *  computer as it is now, for every screen at once. */
export function putAuraComputer(status: AuraComputerStatus): void {
  readAt = Date.now();
  publish({ status, problem: "" });
}

/** How often to read it again: only while it is moving, or while somebody is
 *  paying in the browser; quicker when they are watching it. Null: don't. */
export function pollEvery(status: AuraComputerStatus | null, waiting: boolean, watching: boolean): number | null {
  if (!waiting && !moving(status?.computer)) return null;
  return watching ? WATCHING_MS : GLANCING_MS;
}

function forgetOrg(): void {
  generation += 1;
  inflight = null;
  readAt = 0;
  publish(EMPTY);
  void readAuraComputer();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!unhook && typeof window !== "undefined") {
    const again = () => void readAuraComputer();
    window.addEventListener("focus", again);
    const off = onOrgChanged(forgetOrg);
    unhook = () => {
      window.removeEventListener("focus", again);
      off();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unhook) {
      unhook();
      unhook = null;
    }
  };
}

const snapshot = () => current;

/** The computer, read on open and kept current while it moves.
 *  `watching`: a screen about the computer itself, which ticks quicker.
 *  `waiting`: keep reading although nothing is moving yet — a payment page
 *  is open in the browser and the computer appears once it goes through. */
export function useAuraComputer({ watching = false, waiting = false }: { watching?: boolean; waiting?: boolean } = {}): AuraComputerRead & {
  reload: () => Promise<AuraComputerStatus | null>;
} {
  const read = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (Date.now() - readAt > FRESH_MS) void readAuraComputer();
  }, []);
  const every = pollEvery(read.status, waiting, watching);
  useEffect(() => {
    if (every === null) return;
    const t = setInterval(() => void readAuraComputer(), every);
    return () => clearInterval(t);
  }, [every]);
  return { ...read, reload: readAuraComputer };
}
