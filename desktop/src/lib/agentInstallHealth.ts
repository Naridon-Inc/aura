// Why the agent CLI in your terminal keeps asking to be updated.
//
// `agents_installs_get` already finds every copy of every agent binary on this
// machine and works out which one PATH actually reaches. The problem was never
// the detection — it was that the answer only existed in Settings → Agents, a
// pane nobody opens, while the nag it explains is printed in a terminal three
// panes away. So the verdict moves here, where both surfaces can read the same
// one, and the pane that shows the nag can show the reason beside it.
//
// Two situations are worth a row, and they are not the same situation:
//
//  - **A newer copy is on disk but PATH runs an older one.** The CLI's own
//    updater works perfectly, writes the new version, and the next run still
//    starts the old one. The update appears to fail forever, and nothing on
//    screen connects that to a folder order.
//  - **The only copy is somewhere PATH never looks.** Here the agent simply
//    cannot be launched, and the row above it says "not found" — which sends
//    somebody off to install a copy that is already sitting on their disk.
//
// Everything else is silence. An agent installed once, reachable, and current
// is the ordinary case, and it gets no row.

import { useEffect, useSyncExternalStore } from "react";
import { api, type AgentInstall, type AgentInstallHealth } from "./api";

/** `/Users/someone/.bun/bin/codex` → `~/.bun/bin/codex`. Only the home prefix,
 *  because the rest of the path is the whole point of showing it. */
export function tildePath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
}

/** The folder a binary sits in, for "put this ahead of that in your PATH". */
export function parentDir(p: string): string {
  return p.slice(0, p.lastIndexOf("/")) || "/";
}

export type InstallTrouble =
  /** PATH reaches an older copy than the newest one on disk. */
  | "shadowed-newer"
  /** Installed, but only outside every folder PATH searches. */
  | "off-path-only";

export type InstallNudge = {
  agentId: string;
  bin: string;
  trouble: InstallTrouble;
  /** One row's worth of plain words — the whole fact, no link required. */
  line: string;
  /** The copy that runs, when one does. */
  running: AgentInstall | null;
  /** The copy that should be running instead. */
  other: AgentInstall;
  /** This exact situation, named precisely enough that dismissing it dismisses
   *  only it. When the next version lands the signature changes and the row
   *  comes back, which is correct: it is a new fact, and the nag has resumed
   *  with new numbers. */
  signature: string;
};

/** The one definition of "this install needs something said about it".
 *
 *  `stale` alone is not that definition, and reading it as one hides the
 *  second case entirely: when no copy is on PATH there is no running version
 *  to compare against, so `stale` is false by construction — the install is
 *  not out of date, it is unreachable. Both are worth a row. */
export function installNudge(health: AgentInstallHealth): InstallNudge | null {
  const newer = health.newest_version
    ? health.shadowed.find((s) => s.version === health.newest_version)
    : undefined;

  if (health.stale && health.running && newer) {
    const running = health.running;
    const where = newer.on_path
      ? "further down the folders your shell searches"
      : "in a folder your shell never searches";
    return {
      agentId: health.agent_id,
      bin: health.bin,
      trouble: "shadowed-newer",
      line:
        `This runs ${health.bin} ${running.version ?? "of unknown version"}, but ` +
        `${newer.version} is already installed ${where}. That is why ${health.bin} ` +
        `keeps asking you to update and the update never sticks.`,
      running,
      other: newer,
      signature: `stale:${running.path}@${running.version ?? "?"}>${newer.path}@${newer.version ?? "?"}`,
    };
  }

  if (!health.running && health.shadowed.length > 0) {
    const found = health.shadowed[0];
    return {
      agentId: health.agent_id,
      bin: health.bin,
      trouble: "off-path-only",
      line:
        `${health.bin} is installed at ${tildePath(found.path)}, but your shell ` +
        `never searches that folder, so nothing here can run it.`,
      running: null,
      other: found,
      signature: `off-path:${found.path}@${found.version ?? "?"}`,
    };
  }

  return null;
}

// ── Dismissal ────────────────────────────────────────────────────────────────
// A misconfiguration the app cannot fix for you is still a row that must be
// closable, or it becomes chrome on every terminal forever. It is remembered by
// signature rather than by agent, so "I know, I'll live with it" survives a
// restart and does not also swallow the next version's nag.

const DISMISS_KEY = "aura.agentInstall.dismissed";
/** Enough to cover every agent on a machine a few versions over, and bounded
 *  so a long-lived install never grows an unbounded list. */
const DISMISS_KEEP = 24;

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function isDismissed(signature: string): boolean {
  return state.dismissed.includes(signature);
}

export function dismissNudge(signature: string): void {
  const next = [signature, ...state.dismissed.filter((s) => s !== signature)].slice(
    0,
    DISMISS_KEEP,
  );
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
  } catch {
    /* private mode — the row comes back next launch, which is survivable */
  }
  // The list also lives in the shared state, and this is the reason: a
  // dismissal that only reached storage left the row on screen in the pane
  // the user had just clicked it in. `useSyncExternalStore` compares the
  // snapshot by identity, so a change nobody can see in that object is a
  // change React is entitled to ignore — and did.
  publish({ ...state, dismissed: next });
}

// ── One probe, shared ────────────────────────────────────────────────────────
// The probe spawns a process per copy of every agent binary it finds, so it
// cannot run once per agent pane. It runs at most once per window per interval,
// whoever asks first, and every caller reads the same answer.

const TTL_MS = 10 * 60 * 1000;

/** Both halves of what a row depends on, in one object. They are kept
 *  together because they are read together: a snapshot that changes only when
 *  the probe returns would never tell React that a row was dismissed. */
type InstallState = {
  rows: AgentInstallHealth[];
  dismissed: string[];
};

const listeners = new Set<() => void>();
let state: InstallState = { rows: [], dismissed: readDismissed() };
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;

function snapshot(): InstallState {
  return state;
}

function publish(next: InstallState): void {
  state = next;
  for (const l of listeners) l();
}

/** Subscribe to the shared verdict. Exported so a test can watch the thing
 *  React watches, rather than a side effect that happens to agree with it. */
export function subscribeInstallHealth(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function subscribe(cb: () => void): () => void {
  return subscribeInstallHealth(cb);
}

/** Probe unless a fresh answer is already in hand. Concurrent callers share
 *  one probe; a failure leaves the previous answer alone rather than blanking
 *  a row that was telling the truth a minute ago. */
export function loadInstallHealth(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (!force && fetchedAt > 0 && Date.now() - fetchedAt < TTL_MS) return Promise.resolve();
  inFlight = api
    .agentsInstallsGet()
    .then((rows) => {
      fetchedAt = Date.now();
      publish({ ...state, rows });
    })
    .catch(() => {
      // Probing failed. Say nothing new rather than claiming all is well.
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Every install worth a row, for a surface that shows all agents at once. */
export function useInstallNudges(): InstallNudge[] {
  const { rows, dismissed } = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    void loadInstallHealth();
  }, []);
  return rows
    .map(installNudge)
    .filter((n): n is InstallNudge => n !== null)
    .filter((n) => !dismissed.includes(n.signature));
}

/** The row for one agent, or null — which is the usual answer. */
export function useInstallNudge(agentId: string): InstallNudge | null {
  return useInstallNudges().find((n) => n.agentId === agentId) ?? null;
}
