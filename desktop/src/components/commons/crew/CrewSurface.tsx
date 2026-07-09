// Crew — the dedicated home for Aura's autonomous work loop. You hand your crew
// a stack of tasks and they work it on their own, in dependency order: nothing
// starts until what it needs is done, and each finished piece is tied to the
// commit — and the proof — that delivered it.
//
// This file is the SHELL only: it owns the cross-tab state (which tab, which
// sub-view, the selected task), loads the one unified `ready_view` + the proof
// ledger, and exposes the three real verbs in the header (Sync from board, Add
// to queue, Run crew). You only ever hand the crew WORK — there is no "add an
// agent" step: Run crew puts an agent on each ready task on its own. The two
// tabs and the detail drawer are their own modules so
// none of them grows into a mammoth file:
//   • Queue tab    → the plan, as a dependency graph (default) or four lanes.
//   • Activity tab → a live feed: working now on top, then done/failed with
//                    proof + Retry.
//   • Detail drawer→ click any task to see its spec, what it's waiting on, its
//                    agent, commit, and proof.
//
// It reads the SAME `ready_view` the CLI's `aura loop run` and the chat's
// `/loop` read, so what you see here, what the runner dispatches, and what chat
// reports can never drift. No mock state anywhere — every number is the engine.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  FolderGit2,
  Layers,
  LayoutGrid,
  ListTree,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Users,
  X,
  Zap,
} from "lucide-react";

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
import { WizardStepTabs } from "../../ui/wizard";
import { SegmentedControl } from "../../ui/segmented";
import { loadCrewProof, type CrewProof } from "./crewProof";
import { CrewQueueTab } from "./CrewQueueTab";
import { CrewControlTab } from "./CrewControlTab";
import { CrewComposeWizard } from "./CrewComposeWizard";
import { CrewReviewBanner } from "./CrewReviewBanner";
import {
  knownCrewProjectRoots,
  loadCrewProjects,
  rollupProgress,
  type CrewProjectSummary,
} from "./crewProjects";
// The unified surface draws the crew's one engine four ways: the Queue graph
// and Control panel (crew-native), plus the status-grouped Activity overview
// and the Kanban Board (the Mission kit), fed by the same ready_view via the
// adapter. Automations folds in as its own tab so triggers live here too.
import { MissionActivity } from "../mission/MissionActivity";
import { MissionBoard } from "../mission/MissionBoard";
import { readyViewToMission, mergeMissions } from "../mission/missionFromCrew";
import { allRuns, type MissionStageId } from "../mission/missionData";
import { AutomationsSurface } from "../../automations/AutomationsSurface";

// Primary navigation = top tabs (the FullscreenOverlay's tab strip). Four
// single-purpose sections, no overlap: Work (the live pipeline, shown as a
// Board or a List), Plan (the dependency graph + the rich per-task detail you
// drill into), Automations (the triggers that feed the loop), and Runner (the
// run controls + ledger). Secondary choices live INSIDE a tab (Work's
// Board/List segmented), never as more top-level tabs.
type CrewTab = "work" | "plan" | "automations" | "control";

/** The two ways to look at the same live work inside the Work tab — a Trello-
 *  style Board (default) or a status-grouped List. A secondary segmented, not a
 *  top tab. */
type WorkView = "board" | "list";

// The cross-project strip's overview tab id — a sentinel that can't collide
// with any real repo root (roots are absolute paths). Only meaningful when
// CREW_CROSS_PROJECT is on.
const ALL_PROJECTS = "__all_projects__";

const TAB_ORDER: CrewTab[] = ["work", "plan", "automations", "control"];

// The top tab strip, in order. Plain labels; `hint` is the one-line tooltip a
// non-engineer reads before clicking.
const TAB_META: Array<{
  id: CrewTab;
  label: string;
  icon: ReactNode;
  hint: string;
}> = [
  {
    id: "work",
    label: "Work",
    icon: <LayoutGrid size={15} />,
    hint: "Everything in flight — what's queued, being worked, and just landed",
  },
  {
    id: "plan",
    label: "Plan",
    icon: <ListTree size={15} />,
    hint: "The dependency map — open any task to see what it's waiting on, who's on it, and its proof",
  },
  {
    id: "automations",
    label: "Automations",
    icon: <Zap size={15} />,
    hint: "Schedules and triggers that hand the crew work on their own",
  },
  {
    id: "control",
    label: "Runner",
    icon: <SlidersHorizontal size={15} />,
    hint: "Set the crew going, pause it, and review past runs",
  },
];

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
  const [tab, setTab] = useState<CrewTab>("work");
  const [workView, setWorkView] = useState<WorkView>("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `now` drives the Mission Activity/Board elapsed labels; refreshed on every
  // poll (no separate ticker — the queue re-reads often enough). `collapsed`
  // owns which Activity stage groups are folded, surviving a re-poll.
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState<Set<MissionStageId>>(new Set());
  const [composeOpen, setComposeOpen] = useState(false);
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
  // When the flag is OFF, `projectTab` stays "" forever and `boardRoot` is
  // always the open `repoRoot` — every board verb below operates on exactly the
  // project it does today. When ON, the project strip can point the board at
  // any known project (its root becomes `boardRoot`) or show the all-projects
  // overview (`projectTab === ALL_PROJECTS`).
  const [projects, setProjects] = useState<CrewProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  // "" = the open project (single-project behavior); ALL_PROJECTS = overview;
  // any other value = that project's root.
  const [projectTab, setProjectTab] = useState<string>("");

  // The project the board (queue/activity/control + every verb) is scoped to.
  // With the flag off this is always the open repo.
  const boardRoot =
    CREW_CROSS_PROJECT && projectTab && projectTab !== ALL_PROJECTS
      ? projectTab
      : repoRoot;
  const showOverview = CREW_CROSS_PROJECT && projectTab === ALL_PROJECTS;

  // Load the cross-project picture: enumerate known roots, then read each
  // one's ready-view in parallel (resilient — a project with no crew shows
  // zeros, never an error). Only runs when the flag is on. Default the strip
  // to the all-projects overview the first time it lands.
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
    // Land on the all-projects overview so the first thing a cross-project
    // user sees is every crew at once.
    setProjectTab(ALL_PROJECTS);
    void refreshProjects();
  }, [refreshProjects]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Queue + proof + reality-check + crews + run ledger load together so a
      // done node's pill is never a frame behind its card, the guard is current
      // before Run, and the Control tab's crews/goals/runs match the board.
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
          : `Your crew is on ${r.dispatched.length} task${r.dispatched.length === 1 ? "" : "s"} — an agent on each${r.ready_remaining > 0 ? ` · ${r.ready_remaining} more ready and waiting` : ""}. Watch the list.`,
      );
      // The crew just put an agent on each — the live List is where you watch it
      // land, so land on Work → List.
      setTab("work");
      setWorkView("list");
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
            : `Started ${r.dispatched.length} task${r.dispatched.length === 1 ? "" : "s"} in “${goal.goal}”. Watch the list.`,
        );
        if (r.dispatched.length > 0) {
          setTab("work");
          setWorkView("list");
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
          setTab("work");
          setWorkView("list");
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

  // The all-projects board (CREW_CROSS_PROJECT overview): every project's own
  // ready-view — already loaded on the cross-project strip — folded into one
  // Conductor-style Kanban of every workspace across every project. Each run
  // carries its project, so a card can say where it lives. Proof pills are
  // absent here (the overview loads counts, not per-project ledgers) — the
  // aggregate is a glance; drill into a project for proof. Only built when the
  // overview is showing, so quiet projects cost nothing the rest of the time.
  const overviewMission = useMemo(() => {
    if (!showOverview) return null;
    const empty = new Map<string, CrewProof[]>();
    const states = projects
      .filter((p) => p.view)
      .map((p) => readyViewToMission(p.view!, empty, p.root, p.name));
    return mergeMissions(states);
  }, [showOverview, projects]);
  const overviewHasRuns =
    !!overviewMission && allRuns(overviewMission).length > 0;
  const overviewRoll = useMemo(
    () => (showOverview ? rollupProgress(projects) : null),
    [showOverview, projects],
  );
  const overviewActive = projects.filter((p) => p.progress.total > 0).length;

  // Open a run from the all-projects board: jump into ITS project (switching the
  // strip + board root), select it, and land on Plan where its full detail is.
  const openAcrossProjects = useCallback((run: MissionRun) => {
    setProjectTab(run.project);
    setActiveCrew(null);
    setSelectedId(run.id);
    setTab("plan");
  }, []);

  // Selecting a run from the Board/List opens its full detail in the Plan tab's
  // master→detail column (the one place a task's spec, deps, agent, commit and
  // proof already live) — no competing drawer.
  const openDetail = useCallback((id: string) => {
    setSelectedId(id);
    setTab("plan");
  }, []);

  const toggleStage = useCallback((stage: MissionStageId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }, []);

  return (
    <FullscreenOverlay
      onClose={onClose}
      tabs={
        CREW_CROSS_PROJECT ? (
          <CrewProjectStrip
            inline
            projects={projects}
            loading={projectsLoading}
            active={projectTab}
            openRoot={repoRoot}
            onSelect={(id) => {
              setProjectTab(id);
              setSelectedId(null);
              setActiveCrew(null);
            }}
            onRefresh={() => void refreshProjects()}
          />
        ) : undefined
      }
      footer={
        <div className="flex w-full items-center gap-2">
          {/* When the surface is scoped to one crew, show which — so Run's
              scope is visible from every tab, with a one-click way back to all. */}
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
          <Button
            variant="ghost"
            size="xs"
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
            variant="subtle"
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
            variant="default"
            size="sm"
            onClick={onRun}
            disabled={busy !== null || readyCount === 0}
            className="gap-1.5"
            title="Set the crew going — it runs an agent on each ready task on its own, in order. Watch them land in Work."
          >
            {busy === "run" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )}
            Run crew
          </Button>
        </div>
      }
    >
      {/* Primary navigation is the top tab strip (Work · Plan · Automations ·
          Runner) in the overlay header; this column is just the active tab's
          body. */}
      <div className="relative flex h-full min-h-0 flex-col">
        {/* The cross-project picker (All projects + per-project tabs) now lives
            in the overlay's TOP bar (see `tabs` above) so it sits on the very
            top row; this body starts straight at the section tabs. */}

        {/* Section tabs (Work · Plan · Automations · Runner) sit BELOW the
            project selection — you pick the project first, then the lens onto
            it. Hidden on the All-projects overview, which has no per-tab body. */}
        {!showOverview ? (
          <div className="flex-shrink-0 border-b border-line bg-bg-content">
            <WizardStepTabs
              variant="tabs"
              steps={TAB_META.map((t) => ({
                id: t.id,
                label: t.label,
                icon: t.icon,
              }))}
              index={TAB_ORDER.indexOf(tab)}
              onJump={(i) => setTab(TAB_ORDER[i])}
            />
          </div>
        ) : null}

        {/* Reality check sits at the very top, above any action note — the one
            thing to glance at before you Run. Auto-loaded; quiet when clean. */}
        {!showOverview && !reviewDismissed ? (
          <CrewReviewBanner
            flags={reviewFlags}
            onMarkDone={(id) => void onSetStatus(id, "completed")}
            onOpen={(id) => {
              setSelectedId(id);
              setTab("plan");
            }}
            onDismiss={() => setReviewDismissed(true)}
          />
        ) : null}

        {/* Action results ride as a slim banner across the top so the Queue's
            full-bleed board keeps every pixel below it. */}
        {note ? (
          <div className="shrink-0 border-b border-line-soft bg-bg-1/60 px-6 py-2.5 text-[12px] leading-relaxed text-text-2">
            {note}
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1">
          {showOverview ? (
            // All-projects dashboard — the Conductor shape: one Kanban of every
            // workspace across every project, per-project tabs up top. When
            // nothing's queued anywhere yet we fall back to the project-card grid
            // (its empty/discovery state), so a fresh install still reads clean.
            overviewHasRuns && overviewMission ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 items-center gap-3 border-b border-line-soft px-6 py-2.5">
                  <span className="text-[13px] font-medium text-text-1">
                    All projects
                  </span>
                  {overviewRoll ? (
                    <span className="text-[11.5px] text-text-4">
                      {overviewRoll.done}/{overviewRoll.total} done across{" "}
                      {overviewActive} active
                      {overviewActive === 1 ? " project" : " projects"}
                      {overviewRoll.working > 0
                        ? ` · ${overviewRoll.working} in progress`
                        : ""}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[11.5px] text-text-5">
                    Every workspace, by stage — click one to open its project
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  {/* No cross-project Retry here: re-arming a run must target its
                      own project's engine, and this board spans many. Opening a
                      failed card drops you into its project, where Retry is live. */}
                  <MissionBoard
                    state={overviewMission}
                    now={now}
                    selectedId={selectedId}
                    showProject
                    onSelect={openAcrossProjects}
                  />
                </div>
              </div>
            ) : (
              <CrewProjectsOverview
                projects={projects}
                loading={projectsLoading}
                onOpen={(root) => {
                  setProjectTab(root);
                  setSelectedId(null);
                  setActiveCrew(null);
                }}
              />
            )
          ) : loading && !view ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-text-4">
              <Loader2 size={14} className="animate-spin" />
              Reading the work queue…
            </div>
          ) : tab === "automations" ? (
            // Triggers live in the unified surface too — the schedules (and
            // soon on-commit / on-PR / @mention launches) that put work on the
            // crew. Independent of the queue, so it shows even with nothing
            // queued yet.
            <div className="h-full overflow-y-auto">
              <AutomationsSurface repoRoot={boardRoot} />
            </div>
          ) : empty ? (
            <div className="h-full overflow-y-auto">
              <div className="mx-auto max-w-5xl px-8 py-6">
                <EmptyState busy={busy} onSync={onSync} />
              </div>
            </div>
          ) : view && tab === "plan" ? (
            // Plan — the dependency map + the rich per-task detail. Full-bleed:
            // the worklist/detail column + dotted canvas fill the whole body.
            // Clicking a task swaps the left column to its detail — master→detail
            // in place, no side-popover. This is where a Board/List card opens.
            <CrewQueueTab
              view={view}
              selectedId={selectedId}
              selectedTask={selectedTask}
              allTasks={allTasks}
              proof={proof}
              onSelect={setSelectedId}
              onDeselect={() => setSelectedId(null)}
              onSetStatus={onSetStatus}
              onRetry={(id) => void retryNodes([id])}
              onPlanOrder={onPlanOrder}
              ordering={busy === "order"}
              onSync={onSync}
              syncing={busy === "sync"}
            />
          ) : view && tab === "control" ? (
            <div className="h-full min-h-0">
              <CrewControlTab
                crews={crews}
                activeCrew={activeCrew}
                onSelectCrew={setActiveCrew}
                goals={view.goals}
                runs={runs}
                working={view.working}
                now={now}
                acting={acting}
                onSpawnCrew={onSpawnCrew}
                onRunGoal={onRunGoal}
                onPauseGoal={onPauseGoal}
                onResumeGoal={onResumeGoal}
                onOpenTask={(id) => {
                  setSelectedId(id);
                  setTab("plan");
                }}
              />
            </div>
          ) : view && tab === "work" && mission ? (
            // Work — everything in flight, looked at two ways: a Board (kanban,
            // default) or a List (the status-grouped feed). A secondary
            // segmented chooses between them; clicking any card/row opens that
            // run's full detail in the Plan tab. One job, two lenses.
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center gap-3 border-b border-line-soft px-6 py-2.5">
                <SegmentedControl
                  value={workView}
                  onChange={setWorkView}
                  options={[
                    { value: "board", label: "Board" },
                    { value: "list", label: "List" },
                  ]}
                />
                <span className="text-[11.5px] text-text-4">
                  {workView === "board"
                    ? "Every job as a card, by stage"
                    : "Every job in one feed, newest first"}
                </span>
              </div>
              <div className="min-h-0 flex-1">
                {workView === "board" ? (
                  <MissionBoard
                    state={mission}
                    now={now}
                    selectedId={selectedId}
                    onSelect={(run) => openDetail(run.id)}
                    onRetry={onRetryRuns}
                  />
                ) : (
                  <div className="h-full overflow-y-auto">
                    <div className="mx-auto max-w-5xl px-8 py-6">
                      <MissionActivity
                        state={mission}
                        now={now}
                        selectedId={selectedId}
                        collapsed={collapsed}
                        onToggle={toggleStage}
                        onSelect={(run) => openDetail(run.id)}
                        onRetry={onRetryRuns}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
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
          background: "color-mix(in srgb, #d99a2b 16%, transparent)",
          color: "#d99a2b",
        }}
      >
        <Loader2 size={11} className="animate-spin" />
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
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <RefreshCw size={13} />
        )}
        Sync from board
      </Button>
    </div>
  );
}

// ─── Cross-project (CREW_CROSS_PROJECT) ──────────────────────────────────────
// These render only when the flag is on. The strip is the top-level project
// switcher (All projects + one tab per project that has crew work); the
// overview is the "All projects" body — every project as a progress card.

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
  working: "#d99a2b", // amber — agent on something
  done: "var(--color-positive, #34b27b)", // green — finished, status only
  ready: "var(--color-accent)", // arctic-blue — work waiting
  idle: "var(--color-text-4)",
};

/** The slim progress bar under a project card — done (green) over the rest. */
function ProjectProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-bg-3">
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${pct}%`,
          background: "var(--color-positive, #34b27b)",
        }}
      />
    </div>
  );
}

/** The top-of-surface project switcher. "All projects" first, then one tab per
 *  project that actually has crew work — quiet projects don't clutter the
 *  strip, but the overview still lists them. Reuses the same chip shape as the
 *  header's crew chip so the surface reads consistently. */
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
  /** Render bare (no row chrome) for hosting in the overlay's top bar, so the
   *  project picker sits on the very top row beside the close chip + actions. */
  inline?: boolean;
}) {
  // Only projects with crew work get their own tab; the rest stay in the
  // overview. The open project always gets a tab so you can always get back to
  // the board you came from.
  const tabbed = projects.filter(
    (p) => p.progress.total > 0 || p.root === openRoot,
  );

  const chip = (
    selected: boolean,
    onClick: () => void,
    key: string,
    icon: React.ReactNode,
    label: string,
    tone?: string,
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
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
      <span style={tone ? { color: tone } : undefined}>{icon}</span>
      {label}
    </button>
  );

  const inner = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {chip(
          active === ALL_PROJECTS,
          () => onSelect(ALL_PROJECTS),
          ALL_PROJECTS,
          <Layers size={12} />,
          "All projects",
        )}
        {tabbed.map((p) => {
          const line = projectStatusLine(p);
          return chip(
            active === p.root,
            () => onSelect(p.root),
            p.root,
            <FolderGit2 size={12} />,
            p.name,
            line.tone === "working"
              ? TONE_COLOR.working
              : line.tone === "ready"
                ? TONE_COLOR.ready
                : undefined,
          );
        })}
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

/** The "All projects" body — every known project as a card with its crew
 *  progress. Click a card to open that project's board. Resilient: a project
 *  with no crew (or one that couldn't be read) shows as a calm zero card, never
 *  an error. */
function CrewProjectsOverview({
  projects,
  loading,
  onOpen,
}: {
  projects: CrewProjectSummary[];
  loading: boolean;
  onOpen: (root: string) => void;
}) {
  const roll = useMemo(() => rollupProgress(projects), [projects]);
  const active = projects.filter((p) => p.progress.total > 0);

  if (loading && projects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-text-4">
        <Loader2 size={14} className="animate-spin" />
        Reading every project's crew…
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-10">
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-soft px-6 py-16 text-center">
            <div className="text-text-4">
              <Layers size={26} />
            </div>
            <div className="text-[13.5px] font-medium text-text-2">
              No projects yet
            </div>
            <p className="max-w-md text-[12px] leading-relaxed text-text-4">
              Open a project to give your crew somewhere to work. Once you've
              opened a few, every one shows up here with its own progress.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-6">
        <div className="mb-4 flex items-baseline justify-between">
          <div className="text-[13.5px] font-medium text-text-1">
            All projects
          </div>
          <div className="text-[12px] text-text-4">
            {roll.done}/{roll.total} done across {active.length} active
            {active.length === 1 ? " project" : " projects"}
            {roll.working > 0 ? ` · ${roll.working} in progress` : ""}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.map((p) => {
            const line = projectStatusLine(p);
            const g = p.progress;
            return (
              <button
                key={p.root}
                type="button"
                onClick={() => onOpen(p.root)}
                className="group flex flex-col gap-2 rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-bg-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-text-4 group-hover:text-text-3">
                    <FolderGit2 size={14} />
                  </span>
                  <span className="truncate text-[13px] font-medium text-text-1">
                    {p.name}
                  </span>
                  <span
                    className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium"
                    style={{ color: TONE_COLOR[line.tone] }}
                  >
                    {line.tone === "working" ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : null}
                    {line.text}
                  </span>
                </div>

                <ProjectProgressBar done={g.done} total={g.total} />

                <div className="flex items-center gap-3 text-[11px] text-text-4">
                  {g.working > 0 ? (
                    <span style={{ color: TONE_COLOR.working }}>
                      {g.working} working
                    </span>
                  ) : null}
                  {g.ready > 0 ? (
                    <span style={{ color: TONE_COLOR.ready }}>
                      {g.ready} ready
                    </span>
                  ) : null}
                  {g.blocked > 0 ? <span>{g.blocked} waiting</span> : null}
                  {g.paused > 0 ? <span>{g.paused} paused</span> : null}
                  {g.total === 0 ? (
                    <span className="italic">
                      {p.errored ? "Couldn't read" : "No crew work yet"}
                    </span>
                  ) : null}
                  <span className="ml-auto truncate text-text-5">{p.root}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
