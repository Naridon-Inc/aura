// Crew — the dedicated home for Aura's autonomous work loop. You hand your crew
// a stack of tasks and they work it on their own, in dependency order: nothing
// starts until what it needs is done, and each finished piece is tied to the
// commit — and the proof — that delivered it.
//
// This file is the SHELL only: it owns the surface state (the selected task),
// loads the one unified `ready_view` + the proof ledger,
// and draws the page's ONE bar of chrome — the lens tabs on the left, verbs on
// the right (Add to queue and Run). You only ever hand the crew WORK — there is
// no "add an agent" step: Run puts an agent on each ready task on its own. The
// body is `CrewWorkspace`: the work, drawn, with a task's detail as a docked
// sheet. Each piece is its own module so none grows into a mammoth file. Cloud
// + automations moved to Settings.
//
// WHICH PROJECT is the place rail's, not this surface's. It used to draw a
// strip of project chips of its own across the top of the body — a second
// picker for a question the rail beside it was already asking — and the two
// disagreed: the rail's pick moved List and Board and left this where it was.
// One picker, in the rail; `repoRoot` is its answer. See tasks/TasksPlace.
//
// WHICH GOAL and WHICH CREW are not this surface's state any more. This page is
// reached from the Tasks place's rail, and the place has one rail: it lists the
// goals and the crews beside the sprints and the workstreams, carries the
// per-goal Start / Pause / Resume, and writes the pick into
// `lib/tasksFilterStore`. This surface reads that pick and narrows to it — so
// the same choice narrows the task list too, and it survives coming here and
// going back instead of being re-made in whichever panel happened to be mounted.
//
// WHICH DRAWING is the place's, and this page is one cell of it: Graph. The
// strip in this header is the SAME element the task board renders — same three
// cells, same order, same widths — so picking List or Board here is a
// navigation back to the board rather than a second control that happens to
// look like the first. That is also the way out: a page whose only exit is Esc
// is a trap, and the strip you used to get here is the door you leave by.
//
// It carries no layout switch of its own. It briefly did — three drawings of
// the run under the place's own strip — and a switcher stacked on a switcher is
// two rows of chrome asking two questions before the page shows you anything.
// This cell draws the map, which is what the strip's Graph promises.
//
// It reads the SAME `ready_view` the CLI's `aura loop run` and the chat's
// `/loop` read, so what you see here, what the runner dispatches, and what chat
// reports can never drift. No mock state anywhere — every number is the engine.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cloud,
  ListTree,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import { AsciiSpinner } from "../../ui/ascii-spinner";

import { api } from "../../../lib/api";
import { peekCache, writeCache } from "../../../lib/resourceCache";
import { trackFeature } from "../../../lib/track";
import type {
  LoopTask,
  LoopTaskFlag,
  MissionRun,
  ReadyViewDto,
  Task,
  TaskStep,
} from "../../../lib/api";
import { fetchReadyView } from "../../../lib/loopCache";
import { fetchTasks } from "../../../lib/tasksCache";
import { FullscreenOverlay } from "../../FullscreenOverlay";
import { PageFrame } from "../../ui/PageFrame";
import { EmptyState } from "../../ui/state";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Input } from "../../ui/input";
import { loadCrewProof, type CrewProof } from "./crewProof";
import { scopeViewToCrew, scopeViewToGoal } from "./crewControl";
import { CrewWorkspace, type CrewMainView } from "./CrewWorkspace";
import { WorkLensTabs } from "../../tasks/WorkLensTabs";
import { notifyCrewMutated } from "../../tasks/WorkRailGroups";
import {
  clearTasksSharedFilters,
  useTasksSharedFilters,
} from "../../../lib/tasksFilterStore";
import { isAllProjects, useProjectScope } from "../../../lib/projectRoots";
import { goToWork, type WorkLens } from "../../../lib/workRoute";
import { CrewComposeWizard } from "./CrewComposeWizard";
import { CrewReviewBanner } from "./CrewReviewBanner";
import { CloudRunnerPanel } from "./CloudRunnerPanel";
// The body is `CrewWorkspace` — one persistent sidebar (Tasks | Goals) beside a
// main area that swaps between the dependency Graph and the Kanban Board, all
// fed by the same `ready_view` via the adapter, so every view is only ever a
// different drawing of one live truth.
import { readyViewToMission } from "../mission/missionFromCrew";
import { MissionSituation } from "../mission/MissionSituation";

/** The last board we managed to read, kept for the next visit.
 *
 *  Deliberately just the two reads that draw the work. The review flags are
 *  left out: they drive a banner that asks you to look at something, and a
 *  remembered one would re-appear on a surface that hasn't checked yet. */
type CrewBoard = { view: ReadyViewDto; proof: Map<string, CrewProof[]> };

/** Index the board rows that carry a plan by their id, so the graph can join a
 *  working node (which knows its `board_task_id`) to the plan it should narrate.
 *  Rows with no steps are left out — they have nothing to say and the graph
 *  falls back to its generic sentence for them. */
function boardStepsFromTasks(rows: Task[]): Map<string, TaskStep[]> {
  const m = new Map<string, TaskStep[]>();
  for (const t of rows) {
    if (t.steps && t.steps.length > 0) m.set(t.id, t.steps);
  }
  return m;
}

export function CrewSurface({
  repoRoot,
  onClose,
  asPage = false,
  lens: lensProp,
  onLens,
}: {
  repoRoot: string;
  /** Leave — back to the work list you came from. Also on Esc. */
  onClose: () => void;
  /** The lens the host is showing, when the host owns it. The Tasks
   *  destination does — this surface is one of its three lenses, not a page of
   *  its own. See lib/workRoute. */
  lens?: WorkLens;
  onLens?: (next: WorkLens) => void;
  /** Render in-flow in the content area (no backdrop, no floating panel, no
   *  esc chip) rather than as a modal above the shell. Mission Control is a
   *  place you watch work happen, so the shell mounts it as a page. */
  asPage?: boolean;
}) {
  // Mission Control is a place you come back to, and it used to re-read the
  // whole board from disk every time — so the work you were watching a moment
  // ago went back to "Reading…" on the way in. Seed from the last read and
  // revalidate behind it; the board paints straight away and corrects itself.
  const boardKey = `crew:${repoRoot}`;
  const cachedBoard = peekCache<CrewBoard>(boardKey);
  const [view, setView] = useState<ReadyViewDto | null>(
    () => cachedBoard?.view ?? null,
  );
  const [proof, setProof] = useState<Map<string, CrewProof[]>>(
    () => cachedBoard?.proof ?? new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<null | "sync" | "run" | "order">(null);
  // Board-plan steps keyed by `board_task_id` — the join that lets a working
  // node in the graph say its real step ("Step 3 of 7 — wire the picker")
  // rather than the generic "an agent is building this now". Loaded alongside
  // the queue and refreshed on every poll so a ticked step shows up live.
  const [boardSteps, setBoardSteps] = useState<Map<string, TaskStep[]>>(
    () => new Map(),
  );
  // What just happened, as one line above the work.
  //
  // It used to be a bare string that only ever cleared when you started the
  // NEXT action — so "Started 6 agents" stayed pinned across the top of the
  // page for the rest of the session, forty pixels of the work pushed down by
  // a sentence that stopped being true a minute in. A result and a warning are
  // not the same thing and shouldn't age the same way: a result says its piece
  // and goes; a failure is the one you have to read, so it stays until you
  // dismiss it or act again.
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const say = useCallback((text: string) => setNote({ text, bad: false }), []);
  const warn = useCallback((text: string) => setNote({ text, bad: true }), []);
  useEffect(() => {
    if (!note || note.bad) return;
    const id = window.setTimeout(() => setNote(null), 8000);
    return () => window.clearTimeout(id);
  }, [note]);
  // The strip on this page, and what picking a cell does. Graph is this
  // surface; List and Board are the board's, so choosing one hands the place
  // its new lens — or, with no host owning it (nothing mounts this that way
  // today, but the board's own header has the same fallback), asks the app for
  // the work.
  const workLens: WorkLens = lensProp ?? "graph";
  const chooseLens = (next: WorkLens) => {
    if (onLens) {
      onLens(next);
      return;
    }
    goToWork(next);
  };
  // The one drawing this cell makes: the dependency map. `CrewWorkspace` can
  // also draw the run as a list or as lanes, and both are one strip-cell away
  // as the BOARD's list and lanes — same records, joined by `board_task_id`.
  const lens: CrewMainView = "graph";
  // Which goal and which crew this page is narrowed to — the place's rail owns
  // both, so the answer is the same one List and Board are using and it doesn't
  // reset when you change lens.
  const shared = useTasksSharedFilters();
  const activeCrew = shared.crew?.id ?? null;
  const activeGoal = shared.goal?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `now` drives the Board's elapsed labels; refreshed on every poll (no
  // separate ticker — the queue re-reads often enough).
  const [now, setNow] = useState(() => Date.now());
  const [composeOpen, setComposeOpen] = useState(false);
  // Cloud machine — docked as a right-side board sheet, NOT the global Settings
  // dialog. Mission Control is a fullscreen overlay (z-50); Settings opens at
  // z-40, so routing there would bury it behind the wizard. Keeping the panel
  // in-surface means one click actually shows it.
  const [cloudOpen, setCloudOpen] = useState(false);
  // How many tasks to let the crew take this pass. Empty = drain all ready.
  const [cap, setCap] = useState<string>("");
  // Reality check — tasks the engine thinks aren't worth running as-is (already
  // done / duplicate / empty). Loaded with the queue; `dismissed` lets "Keep
  // all" hide it without a passive poll re-popping it.
  const [reviewFlags, setReviewFlags] = useState<LoopTaskFlag[]>([]);
  const [reviewDismissed, setReviewDismissed] = useState(false);

  // WHICH PROJECT is not this surface's state.
  //
  // It was: a `projectTab` beside a list of every project with crew work, drawn
  // as a strip of chips across the top of the body. The place's rail already
  // carries a project picker — the one Pages and Team draw — so Tasks asked the
  // same question twice, in two controls that did not agree: picking in the
  // rail moved List and Board and left this surface where it was, and picking
  // here moved this surface and left the rail's counts behind. `repoRoot` is
  // the rail's answer now (TasksPlace resolves it), and there is one picker.
  //
  // Under "All projects" the rail counts every root while a dependency graph is
  // a single project's — so this says which one it is rather than quietly
  // drawing one project under a rail that claims eight.
  const placeScope = useProjectScope();
  const allProjects = isAllProjects(placeScope);

  const refresh = useCallback(async () => {
    // Only take over the surface with "Reading…" when there is nothing to
    // read instead. With a seeded board, a reload is a correction, not a wait.
    setLoading(peekCache<CrewBoard>(boardKey) === undefined);
    try {
      // Queue + proof + reality-check load together so a done node's pill is
      // never a frame behind its card and the guard is current before Run.
      // Crews and the run ledger are the rail's read now, not this surface's.
      const [v, p, flags, rows] = await Promise.all([
        fetchReadyView(repoRoot),
        loadCrewProof(repoRoot),
        api.loopReview(repoRoot).catch(() => [] as LoopTaskFlag[]),
        fetchTasks(repoRoot).catch(() => []),
      ]);
      setView(v);
      setProof(p);
      setReviewFlags(flags);
      setBoardSteps(boardStepsFromTasks(rows));
      writeCache<CrewBoard>(boardKey, { view: v, proof: p });
      setNow(Date.now());
      // An explicit reload re-surfaces the guard; only "Keep all" silences it.
      setReviewDismissed(false);
    } catch (e) {
      // The board on screen stays: it is what we last actually read, which is
      // a truer answer than an empty queue. The line below says it's not
      // current.
      warn(`Couldn't read the work queue: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [repoRoot, boardKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A quiet re-read — same data as `refresh` but it never flips the big loading
  // flag, so the auto-poll below doesn't spin the Refresh icon or flash the
  // "Reading…" screen. Used only to keep a RUNNING board live.
  const pollRefresh = useCallback(async () => {
    try {
      const [v, p, flags, rows] = await Promise.all([
        fetchReadyView(repoRoot),
        loadCrewProof(repoRoot),
        api.loopReview(repoRoot).catch(() => [] as LoopTaskFlag[]),
        fetchTasks(repoRoot).catch(() => []),
      ]);
      setView(v);
      setProof(p);
      setBoardSteps(boardStepsFromTasks(rows));
      writeCache<CrewBoard>(boardKey, { view: v, proof: p });
      setNow(Date.now());
      // Keep the flag set current as work lands, but DON'T reset `dismissed` —
      // a passive tick must never re-pop a banner the user chose to keep.
      setReviewFlags(flags);
    } catch {
      // A transient read failure mid-run is not worth a banner — the next tick
      // (or a manual Refresh) recovers. Never clobber the surface over a blip.
    }
  }, [repoRoot, boardKey]);

  // Live progress: while an agent is on something, the board has to move on its
  // own — a vibecoder shouldn't hit Refresh to watch their crew work. Poll every
  // 4s ONLY while work is in flight, pause during an explicit verb (sync/run so
  // we don't double-read), and stop the instant the crew goes idle.
  const liveWorking = view?.counts?.working ?? 0;
  useEffect(() => {
    if (liveWorking <= 0) return;
    const id = setInterval(() => {
      if (busy === null) void pollRefresh();
    }, 4000);
    return () => clearInterval(id);
  }, [liveWorking, busy, pollRefresh]);

  // Cross-agent awareness: even when nothing is running here, another agent —
  // Claude Code, Cursor, the `aura loop` CLI — can mint crew tasks straight
  // into `.aura/a2a/`. The board reads that directory live, so poll on a gentle
  // idle cadence and those tasks land on their own; a vibecoder shouldn't have
  // to hit Refresh to discover work a teammate (or another agent) just queued.
  useEffect(() => {
    if (liveWorking > 0) return; // the fast in-flight poll above already covers this
    const id = setInterval(() => {
      if (busy === null) void pollRefresh();
    }, 12000);
    return () => clearInterval(id);
  }, [liveWorking, busy, pollRefresh]);

  const onSync = async () => {
    if (busy) return;
    setBusy("sync");
    setNote(null);
    try {
      const r = await api.loopSyncBoard(repoRoot);
      say(
        `Pulled in ${r.synced} task${r.synced === 1 ? "" : "s"} from your board (${r.created} new, ${r.updated} updated) and wired ${r.edges} "waiting on" link${r.edges === 1 ? "" : "s"}.`,
      );
      await refresh();
      // New goals may have appeared — the rail lists them, so tell it.
      notifyCrewMutated();
    } catch (e) {
      warn(`Couldn't sync from the board: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // Take the orderless pile and let the active brain work out the real
  // dependencies between those existing tasks — they reorganise into a
  // connected flow in place (no new tasks minted).
  const onPlanOrder = async () => {
    if (busy) return;
    setBusy("order");
    setNote(null);
    try {
      const r = await api.loopPlanOrder(repoRoot);
      if (r.edges === 0) {
        say(
          `Looked at ${r.considered} unordered task${r.considered === 1 ? "" : "s"}. They're already independent, so none needed an order.`,
        );
      } else {
        // Coverage line so a big board reads as wholly handled, not skimmed.
        const goalsPart =
          r.groups > 1
            ? `${r.groups} goals`
            : r.goal
              ? `“${r.goal}”`
              : "a connected flow";
        const objectivePart =
          r.objectives > 0
            ? ` under ${r.objectives} bigger objective${r.objectives === 1 ? "" : "s"}`
            : "";
        const deferredPart =
          r.deferred > 0
            ? ` ${r.deferred} smaller group${r.deferred === 1 ? "" : "s"} left for the next pass.`
            : "";
        say(
          `Ordered ${r.connected} of ${r.considered} task${r.considered === 1 ? "" : "s"} into ${goalsPart}${objectivePart} with ${r.edges} “waiting on” link${r.edges === 1 ? "" : "s"}. Drawn on the board.${deferredPart}`,
        );
      }
      await refresh();
      notifyCrewMutated();
    } catch (e) {
      warn(`Couldn't plan an order: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onRun = async () => {
    if (busy) return;
    setBusy("run");
    setNote(null);
    trackFeature("crew_run");
    try {
      const max = cap.trim() ? Math.max(1, parseInt(cap, 10) || 0) : undefined;
      // Scope the run to whatever the rail is narrowed to — the goal AND the
      // crew, both nullable (null = the whole graph). Run used to pass only the
      // crew, so with a goal in focus the page showed one goal's work and the
      // button quietly started every other goal's as well.
      const r = await api.loopRunNative(
        repoRoot,
        max,
        activeGoal ?? undefined,
        activeCrew ?? undefined,
      );
      say(
        r.dispatched.length === 0
          ? "Nothing ready to start. Add some work, or Sync from your board first to fill the queue."
          : `Your crew is on ${r.dispatched.length} task${r.dispatched.length === 1 ? "" : "s"}. An agent on each${r.ready_remaining > 0 ? ` · ${r.ready_remaining} more ready and waiting` : ""}. Watch the board.`,
      );
      // The crew just put an agent on each — the work list is where you watch
      // those tasks move as they land, so snap back to it. The cards the agents
      // are moving ARE the rows on it, joined by `board_task_id`.
      goToWork("list");
      await refresh();
      notifyCrewMutated();
    } catch (e) {
      warn(`Couldn't start the crew: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // The per-goal Start / Pause / Resume that used to live here — three
  // near-identical handlers feeding three near-identical buttons in the plan
  // sidebar — moved to the rail's Goals group with the goals themselves. An
  // act on ONE goal belongs on that goal's row, not on a page-wide panel that
  // had to carry a `acting` slug just to know which of its cards to spin.

  // Re-arm a failed (or stuck) node into the ready set, then re-read.
  const onSetStatus = useCallback(
    async (nodeId: string, status: string) => {
      try {
        await api.loopSetStatus(repoRoot, nodeId, status);
        await refresh();
        notifyCrewMutated();
      } catch (e) {
        warn(`Couldn't update that task: ${String(e)}`);
      }
    },
    [repoRoot, refresh],
  );

  // Retry MEANS run — one click, not two. Re-arm every failed/stuck node back
  // into the ready set, re-read the engine to see which can ACTUALLY start now
  // (a whole failed chain comes back together — the ones that depended on a
  // sibling that also failed land in "waiting on", not "ready"), then put an
  // agent on each that's ready right away. The note is a plain-language read of
  // exactly what happened: what's running, and which can't start yet + why.
  // Powers the board's per-card "Retry", the Failed column's "Retry all", and
  // the detail drawer's Retry — all funnel here. Skips runs with no node.
  const retryNodes = useCallback(
    async (rawIds: string[]) => {
      const ids = rawIds.filter((id): id is string => !!id);
      if (ids.length === 0 || busy) return;
      setBusy("run");
      setNote(null);
      trackFeature("crew_retry");
      try {
        // 1. Re-arm each node into the ready set.
        for (const id of ids) {
          await api.loopSetStatus(repoRoot, id, "submitted");
        }
        // 2. Re-read the engine so we know which re-armed tasks are truly ready
        //    vs. still waiting on an upstream that hasn't finished.
        const fresh = await fetchReadyView(repoRoot);
        const title = new Map<string, string>();
        for (const t of [
          ...fresh.ready,
          ...fresh.working,
          ...fresh.done,
          ...fresh.paused,
          ...fresh.other,
          ...fresh.blocked.map((b) => b.task),
        ]) {
          title.set(t.id, t.title);
        }
        const retried = new Set(ids);
        const nowReady = fresh.ready.filter((t) => retried.has(t.id));
        const stillBlocked = fresh.blocked.filter((b) =>
          retried.has(b.task.id),
        );

        // 3. Retry = run: if anything we re-armed is ready, dispatch now
        //    (scoped exactly as Run is — the rail's goal and crew) — no
        //    separate "Run crew" click.
        let dispatched = 0;
        if (nowReady.length > 0) {
          const max = cap.trim()
            ? Math.max(1, parseInt(cap, 10) || 0)
            : undefined;
          const r = await api.loopRunNative(
            repoRoot,
            max,
            activeGoal ?? undefined,
            activeCrew ?? undefined,
          );
          dispatched = r.dispatched.length;
        }
        await refresh();
        notifyCrewMutated();

        // 4. One honest read of what happened — running, queued, or waiting.
        const parts: string[] = [];
        if (dispatched > 0) {
          parts.push(
            `Retried. Your crew is on ${dispatched} task${dispatched === 1 ? "" : "s"}, an agent on each. Watch the list.`,
          );
        } else if (nowReady.length > 0) {
          parts.push(
            `Re-queued ${nowReady.length} task${nowReady.length === 1 ? "" : "s"}. The next free agent picks them up.`,
          );
        }
        if (stillBlocked.length > 0) {
          const waits = stillBlocked
            .slice(0, 3)
            .map((b) => {
              const names = b.unmet
                .map((d) => title.get(d) || d)
                .slice(0, 2)
                .join(", ");
              return `“${title.get(b.task.id) || b.task.id}”${names ? ` (waiting on ${names})` : ""}`;
            })
            .join("; ");
          parts.push(
            `${stillBlocked.length} can't start yet: ${waits}${stillBlocked.length > 3 ? " …" : ""}. Fix what they're waiting on first.`,
          );
        }
        say(
          parts.length > 0
            ? parts.join(" ")
            : ids.length === 1
              ? "Re-queued that task."
              : `Re-queued ${ids.length} tasks.`,
        );
        if (dispatched > 0) {
          goToWork("list");
        }
      } catch (e) {
        warn(`Couldn't retry: ${String(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [busy, repoRoot, cap, activeGoal, activeCrew, refresh],
  );

  // Thin adapter for the Mission board/activity Retry buttons (they hand us
  // runs, not bare ids).
  const onRetryRuns = useCallback(
    (runs: MissionRun[]) => void retryNodes(runs.map((r) => r.nodeId ?? "")),
    [retryNodes],
  );

  // THE queue, as everything on this page sees it: narrowed to whatever the
  // rail is pointing at — the crew, then the goal, in series, exactly the pair
  // Run passes. Focusing a slice used to move two things on a page of ten — a
  // goal list and what Run picked up — while the situation line, the Board and
  // the Graph carried on showing every crew's work. One scope, applied once,
  // here, so nothing on the page can disagree with the button.
  const scoped = useMemo(
    () =>
      view ? scopeViewToGoal(scopeViewToCrew(view, activeCrew), activeGoal) : null,
    [view, activeCrew, activeGoal],
  );

  const counts = scoped?.counts;
  // Paused counts toward "has work" — a board whose only remaining tasks are
  // parked must NOT fall through to the "nothing queued yet" empty state; the
  // Queue's Paused section (and the rail's Resume) are how you get them back.
  const total = counts
    ? counts.ready +
      counts.blocked +
      counts.working +
      counts.done +
      counts.paused +
      counts.other
    : 0;
  const empty = !!view && total === 0;
  // Empty because of what you PICKED, not because the project is empty — "you
  // have nothing queued" and "the slice you're pointing at has nothing in it,
  // the rest is busy" are opposite things to be told, and the same blank page
  // was telling you the first when it meant the second.
  const emptyBecausePick =
    empty &&
    (activeCrew !== null || activeGoal !== null) &&
    (view?.ready.length ?? 0) +
      (view?.blocked.length ?? 0) +
      (view?.working.length ?? 0) +
      (view?.done.length ?? 0) +
      (view?.paused.length ?? 0) +
      (view?.other.length ?? 0) >
      0;
  // The number beside Run counts what Run will take — the same scope, so the
  // footer can't offer "up to 4 of 24 ready" and then pick up three.
  const readyCount = counts?.ready ?? 0;

  // Every node, flattened, so the drawer can resolve "waiting on / unblocks"
  // ids → real titles and the popover can offer them as dependencies. Paused
  // nodes belong here too — without them, clicking a paused task in the sidebar
  // resolves to nothing (its detail never opens), a paused dependency can't show
  // its title in Connections, and Add to queue can't make a task wait on it.
  //
  // Deliberately the WHOLE queue, not the crew in focus: a task can wait on one
  // in another crew, and "waiting on <id>" instead of a title would be the crew
  // filter leaking into a place it has no business being.
  const allTasks = useMemo<LoopTask[]>(() => {
    if (!view) return [];
    return [
      ...view.working,
      ...view.ready,
      ...view.blocked.map((b) => b.task),
      ...view.paused,
      ...view.done,
      ...view.other,
    ];
  }, [view]);

  const selectedTask = useMemo(
    () => allTasks.find((t) => t.id === selectedId) ?? null,
    [allTasks, selectedId],
  );

  // The same engine, in the Mission kit's shape — so the Activity overview and
  // the Kanban Board draw the live queue without a second data layer.
  const projectName = useMemo(() => {
    const parts = repoRoot.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || repoRoot;
  }, [repoRoot]);
  const mission = useMemo(
    () =>
      scoped ? readyViewToMission(scoped, proof, repoRoot, projectName) : null,
    [scoped, proof, repoRoot, projectName],
  );

  // Selecting a task (a canvas node, a worklist row, a board card) opens its
  // full detail as a docked sheet over the work — reachable from both lenses
  // without a competing drawer, and without a column of its own beside the
  // place's rail.
  const openDetail = useCallback((id: string) => setSelectedId(id), []);

  // Page or modal — same header + body, different frame.
  const Frame = asPage ? PageFrame : FullscreenOverlay;

  // What Run is about to do, said on Run itself. The cap and the ready count
  // used to be a sentence of their own beside the button — "up to [ ] of 24
  // ready" — which is the button's own subject printed twice, once as a label
  // and once as a verb that didn't mention it.
  const capNum = Number.parseInt(cap, 10);
  const cappedRun =
    Number.isFinite(capNum) && capNum > 0 && capNum < readyCount;

  return (
    <Frame
      onClose={onClose}
      /* ONE bar, at the top, split the way the work is: scope on the left,
         verbs on the right.
         This page used to carry a second forty-pixel strip pinned to the bottom
         of the window — nine hundred pixels below the work it acted on — with a
         project switcher, a crew chip, two unlabelled icons, three buttons and a
         number spinner all in one undivided row. Nothing in it said which
         controls changed what you were looking at and which ones set agents
         running, and the one control that chose the drawing on screen wasn't
         even in it: that floated over the canvas, on top of the last run. */
      /* The lens leads, exactly as it does on the board: that surface never
         prints a title either, and the strip reading as the heading — with its
         siblings as quiet alternatives — says where you are with one fewer word
         on screen. Both pages carry the same furniture in the same places now:
         lens top-left, verbs top-right, what you're scoped to in a thin strip
         underneath.
         It is the app's common tab strip — the SAME element the List and Board
         lenses render, labelled cells and all — so it doesn't move, change
         width or change vocabulary at the moment you press it. That makes it
         the way out as well: this page is one cell of a three-cell switch, not
         a room you have to find the door of. */
      tabs={<WorkLensTabs lens={workLens} onLens={chooseLens} />}
      actions={
        <>
          {/* Look again, and the cloud machine. Both are about the page rather
              than about the work on it, so they sit behind one glyph instead of
              spending two of the header's five slots — the same trim Workspaces
              made when it got down to a lens and a single button.
              One refresh, not two: there used to be a pair of identical
              circling arrows four hundred pixels apart ("Re-scan every
              project's crew" and "Re-read the queue") with no way to tell from
              the screen which was which. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="subtle"
                size="icon-sm"
                title="More"
                aria-label="More"
              >
                {loading ? (
                  <RefreshCw size={13} className="animate-spin" />
                ) : (
                  <MoreHorizontal size={13} />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                disabled={busy !== null}
                onSelect={() => void refresh()}
              >
                <RefreshCw size={13} className="text-text-4" />
                Look again
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setCloudOpen(true)}>
                <Cloud size={13} className="text-text-4" />
                Cloud machine
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setComposeOpen(true)}
            disabled={busy !== null}
            className="gap-1.5"
            title="Hand the crew a job. Plan a goal into connected tasks, or drop in a single task. The crew runs an agent on it for you."
          >
            <Plus size={13} />
            Add to queue
          </Button>
          {/* The cap, only when capping is a real choice — one ready task can't
              be trimmed to fewer. It sits against Run because Run is the only
              thing it changes, and it no longer repeats the ready count: the
              button says that. */}
          {readyCount > 1 ? (
            <label
              className="flex items-center gap-1.5 text-sm text-text-4"
              title="Cap how many tasks the crew takes this pass. Leave it blank to work the whole ready queue."
            >
              up to
              <Input
                type="number"
                min={1}
                max={readyCount}
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                placeholder="all"
                className="h-7 w-12 px-1 text-center text-sm"
              />
            </label>
          ) : null}
          {/* Says what pressing it does, in the numbers on screen. "Run crew"
              was a name for the machine, not a description of the act. */}
          <Button
            variant="accentSoft"
            size="sm"
            onClick={onRun}
            disabled={busy !== null || readyCount === 0}
            className="gap-1.5"
            title="Set the crew going. It runs an agent on each ready task on its own, in order. Watch them land on the Board."
          >
            {busy === "run" ? (
              <AsciiSpinner className="text-sm" />
            ) : (
              <Play size={13} />
            )}
            {readyCount === 0
              ? "Run crew"
              : cappedRun
                ? `Run ${capNum} of ${readyCount}`
                : `Run all ${readyCount}`}
          </Button>
        </>
      }
    >
      {/* The body is CrewWorkspace — the work, drawn, with a task's detail as
          a sheet over it. Scope and verbs both live in the header above;
          nothing floats over the work. */}
      <div className="relative flex h-full min-h-0 flex-col">
        {/* Under "All projects" the rail is counting more than this can draw.
            A dependency graph belongs to one project — there is no aggregate to
            show — so this names the one on screen instead of leaving the rail's
            "All projects · 32" standing over a single project's work. */}
        {allProjects ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-4 py-1.5 text-xs text-text-4">
            <ListTree size={12} className="shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              The crew's run is one project at a time, this is{" "}
              <span className="text-text-2">{projectName}</span>. Pick a project
              in the rail to change it.
            </span>
          </div>
        ) : null}
        {/* The situation, in one sentence, across the whole page — is the crew
            running, and does it need me. It leads, always: it is the question
            this page exists to answer, so nothing gets to sit above it.

            It used to be third. Above it went a pre-flight advisory about queue
            hygiene, and above that whatever the last button had just done —
            three full-width strips, two of them washed the same 7% amber,
            stacked one hairline apart. So "an agent is stopped and nothing
            moves until you act" arrived underneath "two of these tasks look
            like duplicates", in the same colour, at the same width, and read as
            the second half of it. The amber wash is this line's alone now, and
            it only wears it when something really is stopped on you.

            Full width because it is the page's thesis, not a property of one
            column: the plan on the left and the lanes on the right are both
            answers to it.

            This is also the fact the footer used to carry as twelve grey pixels
            ("Nothing running") nine hundred pixels from the board, and the one
            the "Needs you" lane could only tell you by collapsing to a sideways
            forty-pixel strip when it was empty. */}
        {mission && !empty ? (
          <MissionSituation
            state={mission}
            now={now}
            loading={loading}
            onOpen={(run) => openDetail(run.id)}
          />
        ) : null}

        {/* What just happened, as one slim strip across the top. A result
            clears itself after a few seconds; a failure keeps its place, in
            red, with a way to put it away — so the page never carries a stale
            sentence, and never silently swallows one you needed. */}
        {note ? (
          <div
            role={note.bad ? "alert" : "status"}
            className={`flex shrink-0 items-start gap-3 border-b border-line-soft px-6 py-2.5 text-sm leading-relaxed ${
              note.bad ? "text-red" : "bg-bg-1/60 text-text-2"
            }`}
            style={
              note.bad
                ? { background: "color-mix(in srgb, var(--color-red) 8%, transparent)" }
                : undefined
            }
          >
            <span className="min-w-0 flex-1">{note.text}</span>
            {note.bad ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setNote(null)}
                title="Dismiss"
                aria-label="Dismiss"
                className="-my-1 shrink-0 text-text-4 hover:text-text-1"
              >
                <X size={12} />
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Reality check — the pre-flight advisory: which queued tasks aren't
            worth handing an agent as-is (already done, duplicated, an empty
            stub). It sits last of the three because it is about work that has
            not started, which is the least urgent thing this page can tell you,
            and because it is the one you can read at your leisure. Auto-loaded;
            renders nothing at all when the queue is clean. */}
        {!reviewDismissed ? (
          <CrewReviewBanner
            flags={reviewFlags}
            onMarkDone={(id) => void onSetStatus(id, "completed")}
            onOpen={(id) => setSelectedId(id)}
            onDismiss={() => setReviewDismissed(true)}
          />
        ) : null}

        <div className="relative min-h-0 flex-1">
          {loading && !view ? (
            <div className="flex h-full items-center justify-center gap-2 text-base text-text-4">
              <AsciiSpinner />
              Reading the work queue…
            </div>
          ) : empty ? (
            <div className="h-full overflow-y-auto">
              <div className="mx-auto max-w-5xl px-8 py-6">
                <CrewEmpty
                  busy={busy}
                  onSync={onSync}
                  narrowed={emptyBecausePick}
                  onWiden={clearTasksSharedFilters}
                />
              </div>
            </div>
          ) : scoped ? (
            <CrewWorkspace
              view={scoped}
              mission={mission}
              now={now}
              lens={lens}
              selectedId={selectedId}
              selectedTask={selectedTask}
              allTasks={allTasks}
              proof={proof}
              onSelect={openDetail}
              onDeselect={() => setSelectedId(null)}
              onSetStatus={onSetStatus}
              onRetryNode={(id) => void retryNodes([id])}
              onPlanOrder={onPlanOrder}
              ordering={busy === "order"}
              onRetryRuns={onRetryRuns}
              boardSteps={boardSteps}
            />
          ) : null}

          {/* Add to queue — the single door onto the queue: plan a goal into a
              connected build, or drop one task. Docked in-flow as a right-side
              board sheet (not a fullscreen popover), so your queue stays visible
              behind it. A light scrim over the board catches stray clicks; Esc
              or Cancel is the exit — the wizard holds unsaved input, so there's
              deliberately no click-away-to-close. The scrim's onKeyDown stops
              Esc from also closing Mission Control underneath. */}
          {composeOpen ? (
            <div
              className="absolute inset-0 z-20"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setComposeOpen(false);
                }
              }}
            >
              <div className="absolute inset-0 bg-black/25" aria-hidden />
              <div className="absolute inset-y-0 right-0 flex w-full max-w-[420px] flex-col overflow-hidden border-l border-line bg-bg-content shadow-[var(--shadow-modal)]">
                <CrewComposeWizard
                  repoRoot={repoRoot}
                  queue={allTasks}
                  crew={activeCrew}
                  inline
                  onClose={() => setComposeOpen(false)}
                  onAdded={async () => {
                    setComposeOpen(false);
                    await refresh();
                    notifyCrewMutated();
                  }}
                  onPlanned={async (r) => {
                    setComposeOpen(false);
                    say(
                      `Planned “${r.goal}” into ${r.created} task${r.created === 1 ? "" : "s"} with ${r.edges} “waiting on” link${r.edges === 1 ? "" : "s"}. Drawn on the board below, ready to Run.`,
                    );
                    await refresh();
                    // A brand-new goal — the rail lists them, so it re-reads
                    // rather than showing a plan that isn't there for 30s.
                    notifyCrewMutated();
                  }}
                />
              </div>
            </div>
          ) : null}

          {/* Cloud machine — same right-side board sheet, in-surface so it never
              opens behind the wizard. No unsaved input here, so the scrim closes
              it; Esc too (stopped from also closing Mission Control). */}
          {cloudOpen ? (
            <div
              className="absolute inset-0 z-20"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setCloudOpen(false);
                }
              }}
            >
              <div
                className="absolute inset-0 bg-black/25"
                aria-hidden
                onClick={() => setCloudOpen(false)}
              />
              <div className="absolute inset-y-0 right-0 flex w-full max-w-[480px] flex-col overflow-hidden border-l border-line bg-bg-content shadow-[var(--shadow-modal)]">
                <div className="flex shrink-0 items-center justify-end border-b border-line px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => setCloudOpen(false)}
                    className="grid h-6 w-6 place-items-center rounded text-text-4 transition-colors hover:bg-state-hover hover:text-text-1"
                    title="Close (Esc)"
                    aria-label="Close"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <CloudRunnerPanel repoRoot={repoRoot} />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Frame>
  );
}

/** The footer's "is my crew busy?" glance — one question, one answer.
 *
 *  It used to answer a second one too, flipping to "24 ready" whenever nothing
 *  was running. That number is the Run button's business, and it now sits
 *  beside Run; three copies of it on one screen was two too many. */
/** Nothing queued. The one action is Sync from board — everything else the
 *  crew can do needs work to exist first, so the copy explains the loop and
 *  the button starts it. */
function CrewEmpty({
  busy,
  onSync,
  narrowed,
  onWiden,
}: {
  busy: null | "sync" | "run" | "order";
  onSync: () => void;
  /** Set when the PROJECT has work but the goal / crew you picked in the rail
   *  has none. "You have nothing queued" and "the slice you're pointing at has
   *  nothing in it, the rest is busy" are opposite things to be told, and the
   *  same blank board was telling you the first when it meant the second. */
  narrowed: boolean;
  onWiden: () => void;
}) {
  if (narrowed) {
    return (
      <EmptyState
        icon={Users}
        title="Nothing in what you've picked"
        body="The rest of this project's work is under other goals and crews. Widen back to all of it from the rail, or hand this one a job with Add to queue."
        action={{
          label: "Show all the work",
          onClick: onWiden,
          icon: Users,
        }}
      />
    );
  }
  return (
    <EmptyState
      icon={ListTree}
      title="Your crew has nothing queued yet"
      body="Pull your tasks in and the crew orders them by what waits on what, then puts an agent on each in turn, without you sitting over it."
      action={{
        label: busy === "sync" ? "Syncing…" : "Sync from board",
        onClick: onSync,
        icon: RefreshCw,
        disabled: busy !== null,
      }}
      footnote={
        <>
          Or <strong className="text-text-4">Add to queue</strong> to plan a goal
          into steps. The same loop runs from chat with{" "}
          <code className="rounded bg-bg-2 px-1 py-0.5">/loop</code>.
        </>
      }
    />
  );
}
