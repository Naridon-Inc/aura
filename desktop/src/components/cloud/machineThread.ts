// Which conversation belongs to which box.
//
// Entering a machine should land you back in the conversation you were having
// with it, the way re-opening a project does — not in a blank thread with the
// history one level down in a list. That is a decision with three moving parts
// (what was remembered, whether it still exists, what to start instead), and
// while it lived inside a `useCallback` in `MachineChat` none of them could be
// asserted: the failure mode is a surface that spins forever on a session
// nobody can load, which is exactly the shape of thing a test should catch.
//
// It lives here rather than in `lib/place` because it is not about reaching a
// place at all — the brain runs on this laptop either way. It is about where
// the *record* of the conversation is kept, which is what lets the chat outlive
// the box being stopped, imaged or thrown away.

/** The slice of `localStorage` this needs — small enough to hand a fake. */
export type ThreadStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type ThreadDeps = {
  store: ThreadStore;
  /** Whether a remembered session can still be loaded. */
  alive(sessionId: string): Promise<boolean>;
  /** Start a fresh conversation about this machine; resolves to its id. */
  start(repoRoot: string, objective: string, machineId: string): Promise<string>;
};

export type Machine = {
  id: string;
  name: string;
  /** The local checkout this conversation is filed under. */
  repoRoot: string;
};

export type Thread = {
  sessionId: string;
  /** True when the remembered conversation was picked up where it left off. */
  resumed: boolean;
};

/** Keyed by machine, so two boxes keep two conversations rather than trading
 *  one back and forth. */
export function rememberedKey(machineId: string): string {
  return `aura.machineChat.${machineId}`;
}

/** What the session calls itself in lists.
 *
 *  Naming the machine is the one thing that reads well a week later:
 *  "aura-runner" tells you which body of code it was about, where "New
 *  conversation" tells you nothing. */
export function objectiveFor(machineName: string): string {
  return `Working on ${machineName}`;
}

/**
 * Open this machine's conversation — the remembered one if it is still there.
 *
 * `fresh` skips the remembered thread entirely: it is what "New thread" and
 * "Try again" mean, and looking first would resume the very conversation the
 * user just asked to leave.
 *
 * A remembered id that no longer resolves is *forgotten*, not merely ignored.
 * Left in the store it would be re-checked, and re-fail, on every visit for as
 * long as the machine exists.
 */
export async function openThread(
  machine: Machine,
  fresh: boolean,
  deps: ThreadDeps,
): Promise<Thread> {
  const key = rememberedKey(machine.id);

  if (!fresh) {
    const saved = deps.store.getItem(key);
    if (saved) {
      if (await deps.alive(saved)) return { sessionId: saved, resumed: true };
      deps.store.removeItem(key);
    }
  }

  const sessionId = await deps.start(
    machine.repoRoot,
    objectiveFor(machine.name),
    machine.id,
  );
  // Remembered only once it exists. Writing the id before the call would leave
  // a failed start behind as a thread the next visit tries to resume.
  deps.store.setItem(key, sessionId);
  return { sessionId, resumed: false };
}
