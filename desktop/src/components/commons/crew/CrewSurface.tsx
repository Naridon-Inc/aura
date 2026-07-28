// Crew — the dedicated home for Aura's autonomous work loop. You hand your crew
// a stack of tasks and they work it on their own, in dependency order: nothing
// starts until what it needs is done, and each finished piece is tied to the
// commit — and the proof — that delivered it.
//
// This file is the SHELL only: it owns the surface state (which main view, the
// selected task, the focused project), loads the one unified `ready_view` + the
// proof ledger, and exposes the real verbs in the footer (Add to queue, Run
// crew, and a one-click hand-off to your cloud machine). You only ever hand the
// crew WORK — there is no "add an agent" step: Run crew puts an agent on each
// ready task on its own. The body is `CrewWorkspace`: ONE persistent sidebar
// (a `Tasks | Goals` segment — goals carry the Start/Pause/Resume controls that
// used to be a separate "Runs" tab) beside a main area that swaps between the
// dependency **Graph** and the Kanban **Board** via a floating capsule. Each
// piece is its own module so none grows into a mammoth file.
// The project switcher lives in the footer; cloud + automations moved to
// Settings. Mission Control always shows exactly the one project you opened it
// from — no all-projects aggregate.
//
// It reads the SAME `ready_view` the CLI's `aura loop run` and the chat's
// `/loop` read, so what you see here, what the runner dispatches, and what chat
// reports can never drift. No mock state anywhere — every number is the engine.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cloud,
  GitBranch,
  ListTree,
  Play,
  Plus,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import { AsciiSpinner } from "../../ui/ascii-spinner";

import { api } from "../../../lib/api";
import { trackFeature } from "../../../lib/track";
import type {
  CrewRow,
  GoalSummary,
  LoopTask,
  LoopTaskFlag,
  MissionRun,
  ReadyViewDto,
  RunRecord,
} from "../../../lib/api";
import { CREW_CROSS_PROJECT } from "../../../lib/featureFlags";
import { FullscreenOverlay } from "../../FullscreenOverlay";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { loadCrewProof, type CrewProof } from "./crewProof";
import { CrewWorkspace, type CrewMainView } from "./CrewWorkspace";
import { CrewComposeWizard } from "./CrewComposeWizard";
import { CrewReviewBanner } from "./CrewReviewBanner";
import { CloudRunnerPanel } from "./CloudRunnerPanel";
import {
  knownCrewProjectRoots,
  loadCrewProjects,
  type CrewProjectSummary,
} from "./crewProjects";
// The body is `CrewWorkspace` — one persistent sidebar (Tasks | Goals) beside a
// main area that swaps between the dependency Graph and the Kanban Board, all
// fed by the same `ready_view` via the adapter, so every view is only ever a
// different drawing of one live truth.
import { readyViewToMission } from "../mission/missionFromCrew";

export function CrewSurface({
  repoRoot,
  onClose,
}: {
  repoRoot: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<ReadyViewDto | null>(null);
  const [proof, setProof] = useState<Map<string, CrewProof[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<null | "sync" | "run" | "order">(null);
  const [note, setNote] = useState<string | null>(null);
  const [lens, setLens] = useState<CrewMainView>("graph");
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
  // W-C: the crews on this board + which one the surface is scoped to. `null`
  // = all crews (whole graph) — the everyday case where there's only "main".
  const [crews, setCrews] = useState<CrewRow[]>([]);
  const [activeCrew, setActiveCrew] = useState<string | null>(null);
  // W-B: the run ledger (newest first) — what the goal cards' run history reads.
  const [runs, setRuns] = useState<RunRecord[]>([]);
  // The goal slug currently being Run/Paused/Resumed, so only its card spins.
  const [acting, setActing] = useState<string | null>(null);
  // How many tasks to let the crew take this pass. Empty = drain all ready.
  const [cap, setCap] = useState<string>("");
  // Reality check — tasks the engine thinks aren't worth running as-is (already
  // done / duplicate / empty). Loaded with the queue; `dismissed` lets "Keep
  // all" hide it without a passive poll re-popping it.
  const [reviewFlags, setReviewFlags] = useState<LoopTaskFlag[]>([]);
  const [reviewDismissed, setReviewDismissed] = useState(false);

  // ─── Cross-project (CREW_CROSS_PROJECT) ────────────────────────────────
  // The footer's project switcher points the whole surface at any known
  // project. `projectTab` is "" (the open `repoRoot`, the default) or another
  // project's root. There is no "all projects" aggregate any more — Mission
  // Control always shows exactly one project, the one you opened it from.
  const [projects, setProjects] = useState<CrewProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  // "" = the open project (the default); any other value = that project's root.
  const [projectTab, setProjectTab] = useState<string>("");

  // The project the board (board/graph/runs + every verb) is scoped to. With
  // the flag off — or on the default "" — this is always the open repo.
  const boardRoot =
    CREW_CROSS_PROJECT && projectTab ? projectTab : repoRoot;

  // Load the switcher's project list: enumerate known roots, then read each
  // one's ready-view in parallel (resilient — a project with no crew shows
  // zeros, never an error). Only runs when the flag is on. The board itself
  // stays on the open project until you pick another from the footer.
  const refreshProjects = useCallback(async () => {
    if (!CREW_CROSS_PROJECT) return;
    setProjectsLoading(true);
    try {
      const roots = await knownCrewProjectRoots(repoRoot);
      const agg = await loadCrewProjects(roots);
      setProjects(agg.projects);
    } catch {
      // Discovery itself failed — keep whatever we had; the open project's own
      // board (boardRoot === repoRoot) still works independently of this.
    } finally {
      setProjectsLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (!CREW_CROSS_PROJECT) return;
    // Populate the footer switcher, but DON'T move the board — it stays on the
    // project you opened Mission Control from (`projectTab` "" = the open repo).
    void refreshProjects();
  }, [refreshProjects]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Queue + proof + reality-check + crews + run ledger load together so a
      // done node's pill is never a frame behind its card, the guard is current
      // before Run, and the Runs lens's crews/goals/runs match the board.
      const [v, p, flags, c, r] = await Promise.all([
        api.loopReadyView(boardRoot),
        loadCrewProof(boardRoot),
        api.loopReview(boardRoot).catch(() => [] as LoopTaskFlag[]),
        api.loopCrews(boardRoot).catch(() => [] as CrewRow[]),
        api.loopRuns(boardRoot, 50).catch(() => [] as RunRecord[]),
      ]);
      setView(v);
      setProof(p);
      setReviewFlags(flags);
      setCrews(c);
      setRuns(r);
      setNow(Date.now());
      // An explicit reload re-surfaces the guard; only "Keep all" silences it.
      setReviewDismissed(false);
    } catch (e) {
      setNote(`Couldn't read the work queue: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [boardRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A quiet re-read — same data as `refresh` but it never flips the big loading
  // flag, so the auto-poll below doesn't spin the Refresh icon or flash the
  // "Reading…" screen. Used only to keep a RUNNING board live.
  const pollRefresh = useCallback(async () => {
    try {
      const [v, p, flags, c, r] = await Promise.all([
        api.loopReadyView(boardRoot),
        loadCrewProof(boardRoot),
        api.loopReview(boardRoot).catch(() => [] as LoopTaskFlag[]),
        api.loopCrews(boardRoot).catch(() => [] as CrewRow[]),
        api.loopRuns(boardRoot, 50).catch(() => [] as RunRecord[]),
      ]);
      setView(v);
      setProof(p);
      setCrews(c);
      setRuns(r);
      setNow(Date.now());
      // Keep the flag set current as work lands, but DON'T reset `dismissed` —
      // a passive tick must never re-pop a banner the user chose to keep.
      setReviewFlags(flags);
    } catch {
      // A transient read failure mid-run is not worth a banner — the next tick
      // (or a manual Refresh) recovers. Never clobber the surface over a blip.
    }
  }, [boardRoot]);

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
      const r = await api.loopSyncBoard(boardRoot);
      setNote(
        `Pulled in ${r.synced} task${r.synced === 1 ? "" : "s"} from your board (${r.created} new, ${r.updated} updated) and wired ${r.edges} "waiting on" link${r.edges === 1 ? "" : "s"}.`,
      );
      await refresh();
    } catch (e) {
      setNote(`Couldn't sync from the board: ${String(e)}`);
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
      const r = await api.loopPlanOrder(boardRoot);
      if (r.edges === 0) {
        setNote(
          `Looked at ${r.considered} unordered task${r.considered === 1 ? "" : "s"} — they're already independent, so none needed an order.`,
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
        setNote(
          `Ordered ${r.connected} of ${r.considered} task${r.considered === 1 ? "" : "s"} into ${goalsPart}${objectivePart} with ${r.edges} “waiting on” link${r.edges === 1 ? "" : "s"} — drawn on the board.${deferredPart}`,
        );
      }
      await refresh();
    } catch (e) {
      setNote(`Couldn't plan an order: ${String(e)}`);
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
      // Scope the run to the crew the surface is focused on (null = whole graph).
      const r = await api.loopRunNative(
        boardRoot,
        max,
        undefined,
        activeCrew ?? undefined,
      );
      setNote(
        r.dispatched.length === 0
          ? "Nothing ready to start — add some work, or Sync from your board first to fill the queue."
          : `Your crew is on ${r.dispatched.length} task${r.dispatched.length === 1 ? "" : "s"} — an agent on each${r.ready_remaining > 0 ? ` · ${r.ready_remaining} more ready and waiting` : ""}. Watch the board.`,
      );
      // The crew just put an agent on each — the Board is where you watch the
      // cards move as they land, so snap to it.
      setLens("board");
      await refresh();
    } catch (e) {
      setNote(`Couldn't start the crew: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ─── W-B: per-goal run controls. Each scopes to the goal (and the active
  //     crew, so the same goal name in two crews never crosses over). `acting`
  //     spins only the card in play; a refresh after every verb keeps the
  //     counts honest. ───────────────────────────────────────────────────
  const onRunGoal = useCallback(
    async (goal: GoalSummary) => {
      if (acting) return;
      setActing(goal.goal);
      setNote(null);
      try {
        const max = cap.trim() ? Math.max(1, parseInt(cap, 10) || 0) : undefined;
        const r = await api.loopRunNative(
          boardRoot,
          max,
          goal.goal,
          activeCrew ?? undefined,
        );
        setNote(
          r.dispatched.length === 0
            ? `Nothing ready in “${goal.goal}” right now.`
            : `Started ${r.dispatched.length} task${r.dispatched.length === 1 ? "" : "s"} in “${goal.goal}”. Watch the board.`,
        );
        if (r.dispatched.length > 0) {
          setLens("board");
        }
        await refresh();
      } catch (e) {
        setNote(`Couldn't run that goal: ${String(e)}`);
      } finally {
        setActing(null);
      }
    },
    [acting, cap, boardRoot, activeCrew, refresh],
  );

  const onPauseGoal = useCallback(
    async (goal: GoalSummary) => {
      if (acting) return;
      setActing(goal.goal);
      setNote(null);
      try {
        const paused = await api.loopPause(boardRoot, {
          goal: goal.goal,
          crew: activeCrew ?? undefined,
        });
        setNote(
          paused.length === 0
            ? `Nothing to pause in “${goal.goal}”.`
            : `Paused ${paused.length} task${paused.length === 1 ? "" : "s"} in “${goal.goal}”. They'll stay out of the queue until you Resume.`,
        );
        await refresh();
      } catch (e) {
        setNote(`Couldn't pause that goal: ${String(e)}`);
      } finally {
        setActing(null);
      }
    },
    [acting, boardRoot, activeCrew, refresh],
  );

  const onResumeGoal = useCallback(
    async (goal: GoalSummary) => {
      if (acting) return;
      setActing(goal.goal);
      setNote(null);
      try {
        const resumed = await api.loopResume(boardRoot, {
          goal: goal.goal,
          crew: activeCrew ?? undefined,
        });
        setNote(
          resumed.length === 0
            ? `Nothing paused in “${goal.goal}”.`
            : `Resumed ${resumed.length} task${resumed.length === 1 ? "" : "s"} in “${goal.goal}” — back in the ready queue.`,
        );
        await refresh();
      } catch (e) {
        setNote(`Couldn't resume that goal: ${String(e)}`);
      } finally {
        setActing(null);
      }
    },
    [acting, boardRoot, activeCrew, refresh],
  );

  // ─── W-C: spawn a second crew and focus it so its Run drains only its own
  //     tasks. The compose flow can then move work onto it. ────────────────
  const onSpawnCrew = useCallback(
    async (title: string) => {
      setNote(null);
      try {
        const row = await api.loopCrewSpawn(boardRoot, title);
        setActiveCrew(row.meta.id);
        setNote(
          `Added “${row.meta.title}”. Hand it tasks from Add to queue, then Run — it works alongside your other crews, an agent on each task.`,
        );
        await refresh();
      } catch (e) {
        setNote(`Couldn't spawn that crew: ${String(e)}`);
      }
    },
    [boardRoot, refresh],
  );

  // Re-arm a failed (or stuck) node into the ready set, then re-read.
  const onSetStatus = useCallback(
    async (nodeId: string, status: string) => {
      try {
        await api.loopSetStatus(boardRoot, nodeId, status);
        await refresh();
      } catch (e) {
        setNote(`Couldn't update that task: ${String(e)}`);
      }
    },
    [boardRoot, refresh],
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
          await api.loopSetStatus(boardRoot, id, "submitted");
        }
        // 2. Re-read the engine so we know which re-armed tasks are truly ready
        //    vs. still waiting on an upstream that hasn't finished.
        const fresh = await api.loopReadyView(boardRoot);
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
        //    (scoped to the focused crew) — no separate "Run crew" click.
        let dispatched = 0;
        if (nowReady.length > 0) {
          const max = cap.trim()
            ? Math.max(1, parseInt(cap, 10) || 0)
            : undefined;
          const r = await api.loopRunNative(
            boardRoot,
            max,
            undefined,
            activeCrew ?? undefined,
          );
          dispatched = r.dispatched.length;
        }
        await refresh();

        // 4. One honest read of what happened — running, queued, or waiting.
        const parts: string[] = [];
        if (dispatched > 0) {
          parts.push(
            `Retried — your crew is on ${dispatched} task${dispatched === 1 ? "" : "s"}, an agent on each. Watch the list.`,
          );
        } else if (nowReady.length > 0) {
          parts.push(
            `Re-queued ${nowReady.length} task${nowReady.length === 1 ? "" : "s"} — the next free agent picks them up.`,
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
        setNote(
          parts.length > 0
            ? parts.join(" ")
            : ids.length === 1
              ? "Re-queued that task."
              : `Re-queued ${ids.length} tasks.`,
        );
        if (dispatched > 0) {
          setLens("board");
        }
      } catch (e) {
        setNote(`Couldn't retry: ${String(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [busy, boardRoot, cap, activeCrew, refresh],
  );

  // Thin adapter for the Mission board/activity Retry buttons (they hand us
  // runs, not bare ids).
  const onRetryRuns = useCallback(
    (runs: MissionRun[]) => void retryNodes(runs.map((r) => r.nodeId ?? "")),
    [retryNodes],
  );

  const counts = view?.counts;
  // Paused counts toward "has work" — a board whose only remaining tasks are
  // parked must NOT fall through to the "nothing queued yet" empty state; the
  // Queue's Paused section (and Control's Resume) are how you get them back.
  const total = counts
    ? counts.ready +
      counts.blocked +
      counts.working +
      counts.done +
      counts.paused +
      counts.other
    : 0;
  const empty = !!view && total === 0;
  const readyCount = counts?.ready ?? 0;
  const workingCount = counts?.working ?? 0;

  // Every node, flattened, so the drawer can resolve "waiting on / unblocks"
  // ids → real titles and the popover can offer them as dependencies. Paused
  // nodes belong here too — without them, clicking a paused task in the sidebar
  // resolves to nothing (its detail never opens), a paused dependency can't show
  // its title in Connections, and Add to queue can't make a task wait on it.
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

  // The crew the surface is scoped to (null = all crews), for the header chip.
  const activeCrewRow = useMemo(
    () => (activeCrew ? crews.find((c) => c.meta.id === activeCrew) ?? null : null),
    [activeCrew, crews],
  );

  // The same engine, in the Mission kit's shape — so the Activity overview and
  // the Kanban Board draw the live queue without a second data layer.
  const projectName = useMemo(() => {
    const parts = boardRoot.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || boardRoot;
  }, [boardRoot]);
  const mission = useMemo(
    () =>
      view ? readyViewToMission(view, proof, boardRoot, projectName) : null,
    [view, proof, boardRoot, projectName],
  );

  // Selecting a task (a canvas node, a worklist row, a board card) opens its
  // full detail in the persistent sidebar — reachable from both the Graph and
  // the Board without a competing drawer.
  const openDetail = useCallback((id: string) => setSelectedId(id), []);

  return (
    <FullscreenOverlay
      onClose={onClose}
      footer={
        <div className="flex w-full items-center gap-2">
          {/* Project switcher — the bottom control that scopes the WHOLE
              surface. Default is the project you opened Mission Control from;
              pick another to point every lens + verb at it. Lives here, at the
              bottom-left, so the lenses get the top of the pane. */}
          {CREW_CROSS_PROJECT ? (
            <div className="flex min-w-0 max-w-[42%] items-center border-r border-line-soft pr-2">
              <CrewProjectStrip
                inline
                projects={projects}
                loading={projectsLoading}
                active={projectTab || repoRoot}
                openRoot={repoRoot}
                onSelect={(id) => {
                  setProjectTab(id === repoRoot ? "" : id);
                  setSelectedId(null);
                  setActiveCrew(null);
                }}
                onRefresh={() => void refreshProjects()}
              />
            </div>
          ) : null}
          {/* When the surface is scoped to one crew, show which — so Run's
              scope is always visible, with a one-click way back to all. */}
          {activeCrewRow ? (
            <button
              type="button"
              onClick={() => setActiveCrew(null)}
              className="inline-flex items-center gap-1.5 rounded-full border border-line-soft px-2.5 py-1 text-[11.5px] font-medium text-text-3 hover:bg-bg-2"
              title="This crew is in focus — Run works only its tasks. Click to widen back to all crews."
            >
              <Users size={11} />
              {activeCrewRow.meta.title}
              <X size={11} className="opacity-60" />
            </button>
          ) : null}
          {/* Live status — the one-glance "is my crew busy?" read. */}
          <StatusPill
            working={workingCount}
            ready={readyCount}
            loading={loading}
          />
          {/* Status/focus stay left; controls + actions push to the right edge
              of the bottom bar. */}
          <div className="flex-1" />
          {/* Cloud is linked to THIS view — one click hands the current work to
              your always-on machine. Connecting/managing the machine lives in
              Settings → Cloud machine, which this opens. */}
          <Button
            variant="subtle"
            size="icon-sm"
            onClick={() => setCloudOpen(true)}
            title="Run on your always-on cloud machine — send work off and bring results back."
            aria-label="Cloud machine"
          >
            <Cloud size={13} />
          </Button>
          <Button
            variant="subtle"
            size="icon-sm"
            onClick={() => void refresh()}
            disabled={busy !== null}
            title="Re-read the queue"
            aria-label="Refresh"
          >
            <RefreshCw
              size={13}
              className={loading ? "animate-spin" : undefined}
            />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setComposeOpen(true)}
            disabled={busy !== null}
            className="gap-1.5"
            title="Hand the crew a job — plan a goal into connected tasks, or drop in a single task. The crew runs an agent on it for you."
          >
            <Plus size={13} />
            Add to queue
          </Button>
          <label
            className="flex items-center gap-1.5 text-[11.5px] text-text-4"
            title="Cap how many tasks the crew takes this pass. Leave blank to work the whole ready queue."
          >
            up to
            <Input
              type="number"
              min={1}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="all"
              className="h-7 w-14 text-[12px]"
            />
          </label>
          <Button
            variant="accentSoft"
            size="sm"
            onClick={onRun}
            disabled={busy !== null || readyCount === 0}
            className="gap-1.5"
            title="Set the crew going — it runs an agent on each ready task on its own, in order. Watch them land on the Board."
          >
            {busy === "run" ? (
              <AsciiSpinner className="text-[12px]" />
            ) : (
              <Play size={13} />
            )}
            Run crew
          </Button>
        </div>
      }
    >
      {/* The body is CrewWorkspace — the persistent sidebar + the Graph/Board
          main area. The project switcher + run controls live in the footer. */}
      <div className="relative flex h-full min-h-0 flex-col">
        {/* Reality check sits at the very top, above any action note — the one
            thing to glance at before you Run. Auto-loaded; quiet when clean. */}
        {!reviewDismissed ? (
          <CrewReviewBanner
            flags={reviewFlags}
            onMarkDone={(id) => void onSetStatus(id, "completed")}
            onOpen={(id) => setSelectedId(id)}
            onDismiss={() => setReviewDismissed(true)}
          />
        ) : null}

        {/* Action results ride as a slim banner across the top so the
            workspace keeps every pixel below it. */}
        {note ? (
          <div className="shrink-0 border-b border-line-soft bg-bg-1/60 px-6 py-2.5 text-[12px] leading-relaxed text-text-2">
            {note}
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1">
          {loading && !view ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-text-4">
              <AsciiSpinner />
              Reading the work queue…
            </div>
          ) : empty ? (
            <div className="h-full overflow-y-auto">
              <div className="mx-auto max-w-5xl px-8 py-6">
                <EmptyState busy={busy} onSync={onSync} />
              </div>
            </div>
          ) : view ? (
            <CrewWorkspace
              view={view}
              mission={mission}
              now={now}
              lens={lens}
              onLens={setLens}
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
              onSync={onSync}
              syncing={busy === "sync"}
              onRetryRuns={onRetryRuns}
              crews={crews}
              activeCrew={activeCrew}
              onSelectCrew={setActiveCrew}
              runs={runs}
              acting={acting}
              onSpawnCrew={onSpawnCrew}
              onRunGoal={onRunGoal}
              onPauseGoal={onPauseGoal}
              onResumeGoal={onResumeGoal}
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
                  repoRoot={boardRoot}
                  queue={allTasks}
                  inline
                  onClose={() => setComposeOpen(false)}
                  onAdded={async () => {
                    setComposeOpen(false);
                    await refresh();
                  }}
                  onPlanned={async (r) => {
                    setComposeOpen(false);
                    setNote(
                      `Planned “${r.goal}” into ${r.created} task${r.created === 1 ? "" : "s"} with ${r.edges} “waiting on” link${r.edges === 1 ? "" : "s"} — drawn on the board below, ready to Run.`,
                    );
                    await refresh();
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
                    className="grid h-6 w-6 place-items-center rounded text-text-4 transition-colors hover:bg-bg-2 hover:text-text-1"
                    title="Close (Esc)"
                    aria-label="Close"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <CloudRunnerPanel repoRoot={boardRoot} />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </FullscreenOverlay>
  );
}

/** The header's "is my crew busy?" glance. Amber spinner when an agent is on
 *  something, arctic-blue when work is ready and waiting, muted when idle. */
function StatusPill({
  working,
  ready,
  loading,
}: {
  working: number;
  ready: number;
  loading: boolean;
}) {
  if (working > 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium"
        style={{
          background: "color-mix(in srgb, var(--color-amber) 16%, transparent)",
          color: "var(--color-amber)",
        }}
      >
        <AsciiSpinner className="text-[11px]" />
        {working} working
        <span className="opacity-70">· live</span>
      </span>
    );
  }
  if (ready > 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
          color: "var(--color-accent)",
        }}
      >
        {ready} ready
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium text-text-4">
      {loading ? "…" : "Idle"}
    </span>
  );
}

function EmptyState({
  busy,
  onSync,
}: {
  busy: null | "sync" | "run" | "order";
  onSync: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-soft px-6 py-16 text-center">
      <div className="text-text-4">
        <ListTree size={26} />
      </div>
      <div className="text-[13.5px] font-medium text-text-2">
        Your crew has nothing queued yet
      </div>
      <p className="max-w-md text-[12px] leading-relaxed text-text-4">
        <strong className="text-text-3">Sync from board</strong> to pull your
        tasks in — anything with a "waiting on" link gets ordered automatically
        — or hit <strong className="text-text-3">Add to queue</strong> to plan a
        goal into connected steps or drop in a single task. Then{" "}
        <strong className="text-text-3">Run crew</strong> and it puts an agent on
        each, in order, without you. The same loop runs from chat with{" "}
        <code className="rounded bg-bg-2 px-1 py-0.5 text-[11px]">/loop</code>.
      </p>
      <Button
        variant="subtle"
        size="sm"
        onClick={onSync}
        disabled={busy !== null}
        className="mt-1 gap-1.5"
      >
        {busy === "sync" ? (
          <AsciiSpinner className="text-[12px]" />
        ) : (
          <RefreshCw size={13} />
        )}
        Sync from board
      </Button>
    </div>
  );
}

// ─── Cross-project (CREW_CROSS_PROJECT) ──────────────────────────────────────
// Renders only when the flag is on: the footer's project switcher strip (one
// chip per project that has crew work, plus the open project). Picking one
// points the whole surface at it. No all-projects aggregate any more.

/** A short "{done}/{total} done" + live/ready line for a project, in plain
 *  language. Amber dot when an agent is working, green when everything's done,
 *  arctic-blue when there's ready work waiting, muted when there's nothing. */
function projectStatusLine(p: CrewProjectSummary): {
  text: string;
  tone: "working" | "done" | "ready" | "idle";
} {
  const g = p.progress;
  if (g.total === 0) return { text: "No crew work", tone: "idle" };
  if (g.working > 0)
    return {
      text: `${g.working} in progress · ${g.done}/${g.total} done`,
      tone: "working",
    };
  if (g.done >= g.total) return { text: `${g.total} done`, tone: "done" };
  if (g.ready > 0)
    return {
      text: `${g.ready} ready · ${g.done}/${g.total} done`,
      tone: "ready",
    };
  return { text: `${g.done}/${g.total} done`, tone: "idle" };
}

const TONE_COLOR: Record<string, string> = {
  working: "var(--color-amber)", // amber — agent on something
  done: "var(--color-accent-green)", // green — finished, status only
  ready: "var(--color-accent)", // arctic-blue — work waiting
  idle: "var(--color-text-4)",
};

/** The footer project switcher — one chip per project that actually has crew
 *  work (plus the open project, always), so quiet projects don't clutter the
 *  strip. Reuses the same chip shape as the focused-crew chip so the surface
 *  reads consistently. */
function CrewProjectStrip({
  projects,
  loading,
  active,
  openRoot,
  onSelect,
  onRefresh,
  inline = false,
}: {
  projects: CrewProjectSummary[];
  loading: boolean;
  active: string;
  openRoot: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  /** Render bare (no row chrome) for hosting inline in the footer's left
   *  cluster, so the switcher sits on one row with the run controls. */
  inline?: boolean;
}) {
  // Only projects with crew work get their own chip; quiet ones stay off the
  // strip. The open project always gets a chip so you can always get back to
  // the board you came from.
  const tabbed = projects.filter(
    (p) => p.progress.total > 0 || p.root === openRoot,
  );

  const chip = (
    selected: boolean,
    onClick: () => void,
    key: string,
    label: string,
    status: { text: string; tone: "working" | "done" | "ready" | "idle" },
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      title={`${label} — ${status.text}`}
      className={[
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors",
        selected
          ? "border-accent text-accent"
          : "border-line-soft text-text-3 hover:bg-bg-2",
      ].join(" ")}
      style={
        selected
          ? { background: "color-mix(in srgb, var(--color-accent) 12%, transparent)" }
          : undefined
      }
    >
      {/* Always a plain git icon — a project is a git repo, so the icon names
          the kind of thing, never its status. Status rides a quiet trailing dot
          instead, so the icon stays legible and consistent. */}
      <GitBranch size={12} className="shrink-0 opacity-70" />
      <span className="truncate">{label}</span>
      {status.tone !== "idle" ? (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: TONE_COLOR[status.tone] }}
          aria-hidden
        />
      ) : null}
    </button>
  );

  const inner = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {tabbed.map((p) =>
          chip(
            active === p.root,
            () => onSelect(p.root),
            p.root,
            p.name,
            projectStatusLine(p),
          ),
        )}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        title="Re-scan every project's crew"
        aria-label="Refresh projects"
        className="shrink-0 rounded-md p-1 text-text-4 hover:bg-bg-2 hover:text-text-2 disabled:opacity-50"
      >
        <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
      </button>
    </>
  );

  // Inline: bare row for the overlay top bar (the header supplies the flex-1
  // slot between the close chip and the actions). Standalone: its own bordered
  // band below the header.
  if (inline) {
    return (
      <div className="flex w-full min-w-0 items-center gap-2 pl-1 pr-2">
        {inner}
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-1/40 px-6 py-2">
      {inner}
    </div>
  );
}
