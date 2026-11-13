// The Run panel beside a workspace on one of the org's machines: the
// project's own command, started on that machine in the workspace's
// worktree, and read back from there while it runs.
//
// The command comes from the detection the laptop's Run uses
// (`place_run_detect` — package.json, the Makefile and the rest, read on the
// box). It runs in a tmux session on the box like every other shell there,
// so a dev server keeps running when this window closes; the panel finds it
// again by name, reads what it printed with `capture-pane`, and Stop ends the
// session. This window keeps nothing but the session's name, and a name the
// box no longer lists is forgotten.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type BoxSession, type RunSuggestion } from "../../lib/api";
import { openRemoteWorkspace } from "../../lib/editorStore";
import type { WorkAt } from "../../lib/place/placeWork";
import { wantSessionAt } from "../../lib/remotePlaces";
import type { CloudRunControl, CloudRunState } from "../ui/cloud-run-panel";
import { readRunMemory, runActions, runMemoryKey, type RunMemory } from "./boxRun";
import { textOf } from "./useBoxWork";

/** How often a running command's output is read again. */
const READ_EVERY_MS = 4000;
/** How far back the panel shows. */
const LINES = 400;

function recall(key: string): RunMemory | null {
  try {
    return readRunMemory(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function keep(key: string, memory: RunMemory | null) {
  try {
    if (memory) localStorage.setItem(key, JSON.stringify(memory));
    else localStorage.removeItem(key);
  } catch {
    /* not remembered across windows; the box still holds the session */
  }
}

export function useBoxRun(at: WorkAt | null, machine: string): { available: boolean; run: CloudRunControl } {
  const root = at ? (at.remoteRoot ?? at.repoRoot) : null;
  const key = at && root ? runMemoryKey(at.machineId, root) : null;
  const [found, setFound] = useState<RunSuggestion | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [live, setLive] = useState<BoxSession | null>(null);
  const [state, setState] = useState<CloudRunState>("idle");
  const [output, setOutput] = useState("");
  const [note, setNote] = useState<string | undefined>(undefined);
  const busy = useRef(false);

  // What the box's copy says runs it.
  useEffect(() => {
    if (!at) return;
    let on = true;
    setDetecting(true);
    api
      .placeRunDetect(at.machineId, at.repoRoot, at.remoteRoot ?? null)
      .then(
        (s) => on && setFound(s),
        () => on && setFound(null),
      )
      .finally(() => on && setDetecting(false));
    return () => {
      on = false;
    };
  }, [at]);

  // A run this window started before, if the box still has it.
  useEffect(() => {
    if (!at || !key) return;
    const memory = recall(key);
    if (!memory) return;
    let on = true;
    api.boxSessions(at.machineId).then(
      (sessions) => {
        if (!on) return;
        const s = sessions.find((x) => x.name === memory.session) ?? null;
        if (s) {
          setLive(s);
          setState("running");
        } else keep(key, null);
      },
      () => {},
    );
    return () => {
      on = false;
    };
  }, [at, key]);

  // While it runs, what it printed.
  const session = live?.name ?? null;
  useEffect(() => {
    if (!at || !session || state !== "running") return;
    let on = true;
    const read = () => {
      if (document.visibilityState === "hidden") return;
      api.placeSessionCapture(at.machineId, session, LINES).then(
        (c) => on && setOutput(c.text.replace(/\s+$/, "")),
        (e) => {
          if (!on) return;
          // The session is gone: someone ended it there, or the box restarted.
          setLive(null);
          setState("idle");
          setOutput("");
          setNote(`The run on ${machine} ended: ${textOf(e)}`);
          if (key) keep(key, null);
        },
      );
    };
    read();
    const t = window.setInterval(read, READ_EVERY_MS);
    return () => {
      on = false;
      window.clearInterval(t);
    };
  }, [at, session, state, machine, key]);

  const actions = useMemo(() => runActions(found), [found]);
  const selected = actions.find((a) => a.name === chosen) ?? actions[0] ?? null;

  const start = useCallback(async () => {
    if (!at || !root || !key || !selected || busy.current) return;
    busy.current = true;
    setState("starting");
    setNote(undefined);
    setOutput("");
    try {
      // One Run per worktree: the last one ends before the next starts.
      if (live) await api.boxStop(at.machineId, live.name).catch(() => {});
      const s = await api.boxStart(at.machineId, {
        project: root,
        kind: "shell",
        agent: null,
        branch: null,
        title: `Run · ${selected.name}`,
        prompt: null,
        run: selected.command,
      });
      keep(key, { session: s.name, command: selected.command });
      setLive(s);
      setState("running");
    } catch (e) {
      setLive(null);
      setState("failed");
      setNote(`Couldn’t start ${selected.command} on ${machine}: ${textOf(e)}`);
    } finally {
      busy.current = false;
    }
  }, [at, root, key, selected, live, machine]);

  const stop = useCallback(async () => {
    if (!at || !live || busy.current) return;
    busy.current = true;
    try {
      await api.boxStop(at.machineId, live.name);
      if (key) keep(key, null);
      setLive(null);
      setState("idle");
      setOutput("");
      setNote(undefined);
    } catch (e) {
      setNote(`Couldn’t stop the run on ${machine}: ${textOf(e)}`);
    } finally {
      busy.current = false;
    }
  }, [at, live, key, machine]);

  const open = useCallback(() => {
    if (!at || !live) return;
    const entry = { machineId: at.machineId, repoRoot: at.repoRoot, remoteRoot: at.remoteRoot ?? undefined };
    wantSessionAt(entry, live);
    openRemoteWorkspace(entry);
  }, [at, live]);

  const why = !at
    ? `This computer isn’t connected to ${machine}, so it can’t run commands there.`
    : detecting && !found
      ? `Reading how ${machine}’s copy of the project runs…`
      : !selected
        ? `Nothing in ${machine}’s copy of the project says how to run it — no dev script, Makefile target or Procfile.`
        : undefined;

  return {
    available: !!at && !!selected,
    run: {
      actions,
      selected: selected?.name ?? null,
      onSelect: setChosen,
      state,
      output,
      note: note ?? why ?? (selected ? `Runs ${selected.command} on ${machine}, in this workspace’s folder.` : undefined),
      onStart: () => void start(),
      onStop: () => void stop(),
      onOpen: live ? open : undefined,
    },
  };
}
