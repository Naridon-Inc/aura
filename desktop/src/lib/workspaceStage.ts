// A workspace's stage on the Dashboard when you moved it there yourself.
//
// Left alone, a workspace's stage follows its pull request (see `copyStage`):
// no PR is In progress, an open one In review, a merged one Done, a closed one
// Canceled. Dragging a card to another column pins it there, and the pin holds
// only while the pull request still says what it said when you moved the card.
// Park a workspace in Backlog, open a PR on it, and it goes to In review; merge
// it and it goes to Done. Your move never hides news from git.
//
// Kept on this device, keyed by checkout path, like the rest of a workspace's
// own settings (see workspaceCustomization).

import { useSyncExternalStore } from "react";

import type { WorkspaceStage } from "../components/ui/workspace-preview-card";

const KEY = "aura.workspace.stage.v1";

/** A pinned stage, and the stage git gave the workspace when it was pinned. */
export type StagePin = { stage: WorkspaceStage; derived: WorkspaceStage };
export type StagePins = Record<string, StagePin>;

/** The stage a card shows: the pin while git still says what it said when
 *  the card was moved, otherwise what git says now. */
export function effectiveStage(pin: StagePin | undefined, derived: WorkspaceStage): WorkspaceStage {
  return pin && pin.derived === derived ? pin.stage : derived;
}

/** The pins after moving `path` to `stage` while git says `derived`. Moving a
 *  card back to the stage git gives it drops the pin rather than keeping one
 *  that says nothing. */
export function withPin(
  pins: StagePins,
  path: string,
  stage: WorkspaceStage,
  derived: WorkspaceStage,
): StagePins {
  const next = { ...pins };
  if (stage === derived) delete next[path];
  else next[path] = { stage, derived };
  return next;
}

const STAGES: ReadonlySet<string> = new Set([
  "backlog",
  "in-progress",
  "in-review",
  "done",
  "canceled",
]);

/** Pins read back from storage, keeping only well-formed entries. */
export function parsePins(raw: string | null): StagePins {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const pins: StagePins = {};
    for (const [path, pin] of Object.entries(parsed as Record<string, unknown>)) {
      const p = pin as Partial<StagePin> | null;
      if (p && STAGES.has(String(p.stage)) && STAGES.has(String(p.derived)))
        pins[path] = { stage: p.stage!, derived: p.derived! };
    }
    return pins;
  } catch {
    return {};
  }
}

let cache: StagePins | null = null;
const subs = new Set<() => void>();

function pins(): StagePins {
  if (cache === null) {
    try {
      cache = parsePins(localStorage.getItem(KEY));
    } catch {
      cache = {};
    }
  }
  return cache;
}

/** Pin a workspace to a stage. */
export function setWorkspaceStage(path: string, stage: WorkspaceStage, derived: WorkspaceStage): void {
  cache = withPin(pins(), path, stage, derived);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage full or unavailable: the pin lasts for this run */
  }
  for (const fn of subs) fn();
}

export function useWorkspaceStagePins(): StagePins {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    pins,
    () => ({}),
  );
}
