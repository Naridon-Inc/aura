// What to call a machine on screen, from the id a record carries.
//
// Sessions, tasks and radar events store a machine as `user@host:/repo` — the
// key, which is stable and unambiguous and reads like a connection string. No
// surface should print that. People named their box, and the name is what they
// recognise; the address is a detail for the one control that is *about* the
// machine.
//
// The book is small and changes only when someone connects or forgets a
// machine, so it is read once and shared. A name that isn't in the book yet
// resolves to null rather than to the raw id — a caller that has nothing true
// to show should say nothing, not leak an address into a sentence.

import { useEffect, useState } from "react";

import { api, type Machine } from "./api";

let cache: Machine[] | null = null;
let inFlight: Promise<Machine[]> | null = null;

function load(): Promise<Machine[]> {
  if (cache) return Promise.resolve(cache);
  inFlight ??= api
    .machinesList()
    .then((list) => {
      cache = list;
      inFlight = null;
      return list;
    })
    .catch(() => {
      // A failed read is not an empty book — leaving the cache unset means the
      // next caller tries again rather than inheriting a permanent "no
      // machines" from one bad moment.
      inFlight = null;
      return [];
    });
  return inFlight;
}

/** Forget the cached book. Call after connecting or removing a machine so the
 *  next read reflects it. */
export function forgetMachineNames() {
  cache = null;
}

/** The display name for a machine id, or null while loading / when the book no
 *  longer holds it. */
export function useMachineName(machineId?: string | null): string | null {
  const [name, setName] = useState<string | null>(
    () => cache?.find((m) => m.id === machineId)?.name ?? null,
  );

  useEffect(() => {
    if (!machineId) {
      setName(null);
      return;
    }
    let alive = true;
    void load().then((list) => {
      if (alive) setName(list.find((m) => m.id === machineId)?.name ?? null);
    });
    return () => {
      alive = false;
    };
  }, [machineId]);

  return name;
}
