// WorkspaceCreateComposer — the compact, Conductor-style "start a new agent"
// card. One centered panel: pick the project, pick what to start FROM (a
// branch or an open PR), say what you want to work on, choose a model + effort,
// and Start agent. Starting provisions a real isolated worktree (a fresh copy
// of the project) and opens Aura chat inside it with your objective as the
// first message — so "describe it and go" lands one working copy on its own
// branch, to merge back when you're happy.
//
// Local work comes in two shapes, and both are real git. "Separate copy" (the
// default) puts the new branch in its own folder — a git worktree — which is
// the ONLY way to have two branches of one repository checked out at the same
// moment: a folder has exactly one HEAD, so main and feat/abc live at once
// only by living in two places. Turn it off and the new branch is created
// right here instead, the plain `git checkout -b` most people mean by
// "branch": no second copy, no disk, but you leave the branch you were on. The
// switch is the whole difference; everything after it is identical.
//
// It used to spawn a raw Claude Code terminal in the worktree and type the
// objective into it after the TUI painted. Two things were wrong with that.
// The message went missing whenever the injection lost the race with the
// CLI's own startup — the user watched the setup steps run, landed in Claude,
// and their objective simply wasn't there. And it routed people around Aura
// into a bare agent terminal, when Aura is the surface that can hand the work
// out to agents, keep the goal attached to it, and prove it afterwards. So the
// launch now provisions the worktree only (no agents in the manifest) and App
// opens Aura chat there — see the `aura:workspace-launched` handler.
//
// Self-contained surface: it mounts once and stays dormant until a
// `window` "aura:new-workspace" CustomEvent opens it (optional
// `detail.repoRoot` to preselect a project). Esc / click-away / a successful
// start close it — unless "Create more" is on, which clears the objective and
// keeps the card up for the next one. No title, by doctrine — the card's own
// affordances carry the meaning.
//
// WHERE it runs is asked here too, and that is new. It used to be inferred
// from where you already were: this dialog always made the copy on this laptop,
// and the only route to a cloud workspace was to walk into the machine and
// create one from over there. So the place was chosen by navigating rather than
// by picking, which meant most people never knew it was a choice. The Where
// chip is the same control the launcher carries — one question, asked the same
// way wherever new work starts — and picking a machine makes the worktree over
// there (`cloudbox::script::add_worktree`) with the agent running in tmux on
// its CPU, its disk, its sign-ins.
//
// Models + effort are real but pre-session: there's no chat session yet to
// persist an override against, so the model chip reads the user's actual
// brains/catalog (`managerListBrains` + `agentModelsList`) and the composer
// holds the choice; effort holds a `ReasoningEffort`. Both ride out on the
// launch event and are applied to the Aura chat the moment its session exists
// — the model becomes that chat's own model chip and its first turn runs on
// it. The controls are wired to real catalogs and a real turn, never a fake
// list.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cloud,
  CornerDownLeft,
  FolderGit2,
  GitBranch,
  Sparkles,
} from "lucide-react";

import {
  api,
  missionState,
  type BrainChoice,
  type CloudSendResult,
  type GitBranchInfo,
  type ModelCatalog,
  type ReasoningEffort,
} from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { AgentIcon } from "../agent/AgentIcon";
import { Button } from "../ui/button";
import { ChipButton } from "../ui/chip";
import { Switch } from "../ui/switch";
import {
  catalogFor,
  familyOf,
  toSelectedModel,
  type CatalogModel,
  type SelectedModel,
} from "../../lib/modelCatalog";
import { getModelPrefs } from "../../lib/modelStore";
import { humanizeGitError } from "../git/branches";
import { cachedRepoAvatar, resolveRepoAvatar } from "../../lib/repoAvatar";
import { knownProjectRoots, projectNameFromRoot } from "../../lib/projectRoots";
import { newCloudThreadKey } from "../../lib/cloudJobs";
import { openRemoteWorkspace } from "../../lib/editorStore";
import { launchWorkspace } from "../../lib/workspaceCreateStore";
import { trackFeature } from "../../lib/track";
import { randomPlaceName } from "../../lib/placeNames";
import { CreateFromPicker, type CreateFromSelection } from "./CreateFromPicker";
import { useDismiss } from "../../lib/useDismiss";
import { WherePicker, useWherePlaces } from "../place/WherePicker";

/** The agent a workspace falls back to when something has to name one: the
 *  cloud launch path (which runs a CLI, not Aura chat) and the model chip's
 *  starting brain. Real CLI id, not a placeholder. Local launches no longer
 *  spawn an agent at all — they open Aura chat, which decides. */
const DEFAULT_AGENT_ID = "claude";

/** Branch names already in use for this repo — every local branch plus each
 *  remote's last path segment. Fed to `randomPlaceName` so the auto-namer
 *  never re-picks an existing name: a repo with dozens of parallel copies
 *  (each on its own place-name branch) would otherwise routinely collide, and
 *  `git worktree add -b <name>` fails with "a branch named '<name>' already
 *  exists" — a hidden, auto-generated name, so the failure reads as nothing
 *  happening. */
function takenBranchNames(branches: GitBranchInfo[]): Set<string> {
  const taken = new Set<string>();
  for (const b of branches) {
    const name = b.name.trim();
    if (!name) continue;
    taken.add(name);
    const leaf = name.split("/").pop();
    if (leaf) taken.add(leaf);
  }
  return taken;
}

/** Effort levels offered in the compact chip, mapped to the cross-agent
 *  `ReasoningEffort` knob. `null` = leave the model at its own depth. Named
 *  exactly as the chat composer names them — "Fast" is a separate control
 *  there, so low effort is Low here too. */
const EFFORT_OPTIONS: { value: ReasoningEffort | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

function effortLabel(v: ReasoningEffort | null): string {
  return EFFORT_OPTIONS.find((o) => o.value === v)?.label ?? "Effort";
}

type ProjectRoot = { root: string; label?: string };

/** Where the work runs: a LOCAL isolated worktree (default) or the always-on
 *  CLOUD runner (a submitted a2a task a runner drains). */
type Target = "local" | "cloud";

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; path?: string; cloud?: CloudSendResult }
  | { kind: "error"; message: string };

export function WorkspaceCreateComposer() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRoot[]>([]);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [createFromOpen, setCreateFromOpen] = useState(false);
  const [createFrom, setCreateFrom] = useState<CreateFromSelection | null>(null);
  const [objective, setObjective] = useState("");
  const [createMore, setCreateMore] = useState(false);
  // Model + effort live in the composer (not the chips) so they ride into
  // `launchWorkspace` as the agent's pre-session intent. `null` on either =
  // Auto (let the agent keep its own default). The chips below are now
  // controlled — they render the choice and report it back here.
  const [model, setModel] = useState<SelectedModel | null>(null);
  const [effort, setEffort] = useState<ReasoningEffort | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // GitHub-owner avatar per project root (`github.com/<owner>.png`). Seeded
  // synchronously from the cache for first paint, then resolved in the
  // background. `null` = known not on GitHub → folder fallback.
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  // Run target — LOCAL worktree (default, preserves the classic flow) or the
  // always-on CLOUD runner. Sticky across opens so a cloud-first user doesn't
  // re-toggle every time.
  const [target, setTarget] = useState<Target>("local");
  // Does the new branch get its own folder? On (default) = a separate copy, so
  // the branch you're on now stays checked out beside it. Off = created right
  // here, which is cheaper and simpler but means leaving the current branch.
  // Sticky, because which of the two you want is a habit, not a per-task call.
  const [separate, setSeparate] = useState(() => {
    try {
      return localStorage.getItem("aura.newwork.separate") !== "0";
    } catch {
      return true;
    }
  });
  const chooseSeparate = useCallback((v: boolean) => {
    setSeparate(v);
    try {
      localStorage.setItem("aura.newwork.separate", v ? "1" : "0");
    } catch {
      /* quota — the choice just won't stick */
    }
  }, []);
  // Cloud readiness, resolved lazily while the Cloud target is selected.
  // `connected` = signed in to Aura cloud (gates the setup path); `runnerOnline`
  // = an always-on machine is draining work now (else the task queues). Drives
  // the setup hint + the Cloud dot.
  const [cloud, setCloud] = useState<{
    checking: boolean;
    connected: boolean;
    org?: string | null;
    runnerOnline: boolean;
  }>({ checking: false, connected: false, runnerOnline: false });
  // Bumped when sign-in state may have changed, to re-run the readiness probe.
  const [authTick, setAuthTick] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  // ── Open/close, driven by the window event ─────────────────────────────
  // Listen for the trigger. `detail.repoRoot` (when present) becomes the
  // preselected project; otherwise the first known project leads.
  // `detail.createFrom` opens straight into the base-picker (the roster's
  // "Create from…" item + the global ⌘⇧N both pass it).
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ repoRoot?: string; createFrom?: boolean }>)
        .detail;
      void openComposer(detail?.repoRoot).then(() => {
        if (detail?.createFrom) setCreateFromOpen(true);
      });
    }
    window.addEventListener("aura:new-workspace", onOpen);
    return () => window.removeEventListener("aura:new-workspace", onOpen);
    // openComposer is stable (defined below with useCallback).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openComposer = useCallback(async (preferRoot?: string) => {
    setOpen(true);
    setPhase({ kind: "idle" });
    setCreateFrom(null);
    setCreateFromOpen(false);
    setProjectMenuOpen(false);
    // Enumerate projects (recents-ordered); seed the active root so it's
    // present even on a fresh registry.
    const roots = await knownProjectRoots(preferRoot).catch(
      () => [] as ProjectRoot[],
    );
    setProjects(roots);
    const chosen = preferRoot ?? roots[0]?.root ?? null;
    setRepoRoot(chosen);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setProjectMenuOpen(false);
    setCreateFromOpen(false);
  }, []);

  // Resolve each project's GitHub-owner avatar so the chip + picker rows show
  // a real face/logo, not a folder glyph. Seed from the cache for an instant
  // first paint, then refresh in the background (best-effort — failures fall
  // back to the folder icon and are remembered as `null`).
  useEffect(() => {
    if (projects.length === 0) return;
    setAvatars((prev) => {
      const next = { ...prev };
      for (const p of projects) {
        if (!(p.root in next)) next[p.root] = cachedRepoAvatar(p.root);
      }
      return next;
    });
    let cancelled = false;
    void (async () => {
      for (const p of projects) {
        const url = await resolveRepoAvatar(p.root);
        if (cancelled) return;
        setAvatars((prev) => (prev[p.root] === url ? prev : { ...prev, [p.root]: url }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  // Seed the start point with the repo's default branch so the "Create from"
  // chip opens already showing a real branch (main/master), not an empty
  // "Create from…" placeholder — the user sees what the new worktree forks
  // from at a glance. Re-runs when the project changes (which clears the
  // selection); `?? default` so it never overrides a branch the user picked.
  useEffect(() => {
    if (!open || !repoRoot) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.gitBranchesRich(repoRoot);
        if (cancelled) return;
        const locals = rows.filter((b) => !b.isRemote);
        const def =
          locals.find((b) => b.name === "main") ??
          locals.find((b) => b.name === "master") ??
          locals.find((b) => b.isCurrent) ??
          locals[0];
        if (def) {
          setCreateFrom(
            (cur) => cur ?? { kind: "branch", ref: def.name, label: def.name },
          );
        }
      } catch {
        /* unreadable repo — leave the implicit HEAD default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot]);

  // The SignInWizard broadcasts this after a successful login. Re-run the
  // readiness probe so the composer flips from "Set up cloud" to "Send to
  // cloud" live, without the user reopening the card.
  useEffect(() => {
    function onAuthChanged() {
      setAuthTick((n) => n + 1);
    }
    window.addEventListener("aura:cloud-auth-changed", onAuthChanged);
    return () => window.removeEventListener("aura:cloud-auth-changed", onAuthChanged);
  }, []);

  // Resolve cloud readiness while the card is open. Sign-in status decides
  // whether the queue is offered AT ALL — it used to only gate the copy on a
  // switch that was always there, which is how a project with no cloud ended up
  // with a Cloud control whose entire content was an apology. Runner liveness
  // (scoped to the selected project) then tells us whether a task drains now or
  // queues until a machine comes online.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCloud((c) => ({ ...c, checking: true }));
    void (async () => {
      let connected = false;
      let org: string | null | undefined;
      try {
        const status = await api.cloudAuthStatus();
        connected = status.connected;
        org = status.org_slug;
      } catch {
        /* offline / no cloud — treat as not set up */
      }
      let runnerOnline = false;
      if (connected) {
        // The cloud registry is the authority: it hears every runner's
        // heartbeat, including boxes that leave no trace on this disk. The
        // local mission read stays as a fallback for a runner running on this
        // same Mac, where a live lease is real evidence and the cloud may be
        // unreachable.
        try {
          runnerOnline = (await api.cloudRunners()).some((r) => r.online);
        } catch {
          /* signed out or cloud unreachable — fall back to the local read */
        }
        if (!runnerOnline) {
          try {
            const mission = await missionState(repoRoot ? [repoRoot] : undefined);
            runnerOnline = mission.host.online;
          } catch {
            /* mission read failed — assume no runner, non-blocking */
          }
        }
      }
      if (cancelled) return;
      setCloud({ checking: false, connected, org, runnerOnline });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot, authTick]);

  // Esc closes the whole card (when no inner popover is intercepting it).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (createFromOpen) {
          setCreateFromOpen(false);
          return;
        }
        if (projectMenuOpen) {
          setProjectMenuOpen(false);
          return;
        }
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, createFromOpen, projectMenuOpen, close]);

  // Click-away on the project menu.
  useDismiss(projectMenuOpen, () => setProjectMenuOpen(false), projectMenuRef);

  const activeProjectName = useMemo(() => {
    if (!repoRoot) return "Choose a project";
    const entry = projects.find((p) => p.root === repoRoot);
    return entry?.label?.trim() || projectNameFromRoot(repoRoot);
  }, [repoRoot, projects]);

  // Where the work runs. This laptop always leads; the project's cloud is on
  // the list only where the project has one, and every box of yours is on it
  // whichever project you are in — see `lib/place/where.ts`, which holds both
  // rules so no surface can decide them a second time.
  const where = useWherePlaces(repoRoot, activeProjectName);
  const onABox = where.chosen.machineId !== null;

  // The always-on runner queue is a different offer from a place, and it is
  // only a real one when the project's cloud is actually set up. Left showing
  // regardless, it was the dead option the Where row exists to abolish: a Cloud
  // switch on every project, most of them answering "Cloud isn't set up yet".
  const canQueue = !onABox && !cloud.checking && cloud.connected;
  useEffect(() => {
    if (!canQueue && target === "cloud") setTarget("local");
  }, [canQueue, target]);

  // ── Create ──────────────────────────────────────────────────────────────
  const submit = useCallback(async () => {
    if (!repoRoot || phase.kind === "busy") return;
    const mission = objective.trim();
    if (!mission) return;

    // Cloud target but not signed in → route to the one-click sign-in instead
    // of a doomed send (Enter and the button both land here).
    if (target === "cloud" && !cloud.connected) {
      window.dispatchEvent(new CustomEvent("aura:open-signin"));
      return;
    }

    setPhase({ kind: "busy" });

    // ── On a box: the copy is made over there and the agent runs over there.
    // `launchWorkspace` takes the machine and routes to `box_start`, which adds
    // the worktree beside the project and holds the agent in tmux — so the work
    // outlives this window, this wifi and this laptop's lid. Nothing is checked
    // out here and no tab is placed here; the machine's own workspace is where
    // that session is, and sending work somewhere should take you there. ─────
    const machineId = where.chosen.machineId;
    if (machineId) {
      trackFeature("workspace_place_launch");
      try {
        let taken = new Set<string>();
        try {
          taken = takenBranchNames(await api.gitBranches(repoRoot));
        } catch {
          /* branch read failed — a blind pick, and git still guards over there */
        }
        const branch = randomPlaceName(taken);
        // The agent named in this dialog is the one that starts over there. The
        // model chip's brain IS an agent id; with nothing pinned it falls to the
        // same default the rest of this card uses.
        const agentId = model?.brainId ?? DEFAULT_AGENT_ID;
        const { errors } = await launchWorkspace({
          repoRoot,
          branch,
          agents: [{ agentId }],
          prompt: mission,
          machineId,
          remoteProjectPath: where.chosen.projectPath,
        });
        if (errors.length > 0) {
          // The worktree exists (a total failure throws), so this is the fleet
          // with a gap in it — say which, and leave the card up.
          setPhase({ kind: "error", message: errors.join("; ") });
          return;
        }
        setPhase({ kind: "done" });
        if (createMore) {
          setObjective("");
          requestAnimationFrame(() => textareaRef.current?.focus());
          return;
        }
        openRemoteWorkspace({ machineId, repoRoot });
        close();
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        setPhase({ kind: "error", message: humanizeGitError(raw) });
      }
      return;
    }

    // ── Cloud: hand the objective to the always-on runner as a submitted a2a
    // task (scoped to this repo's origin). No local worktree — a runner drains
    // it, and results come back via cloud-sync. ────────────────────────────
    if (target === "cloud") {
      trackFeature("workspace_cloud_launch");
      try {
        // Every cloud send opens a conversation, even the ones nobody replies
        // to. Threading at the first message rather than at the first reply is
        // what lets the job have a place to be read the moment it exists.
        const threadKey = newCloudThreadKey();
        const res = await api.loopCloudSend(
          repoRoot,
          mission,
          DEFAULT_AGENT_ID,
          undefined,
          threadKey,
        );
        window.dispatchEvent(
          new CustomEvent("aura:cloud-task-created", {
            detail: { repoRoot, id: res.id, status: res.status },
          }),
        );
        setPhase({ kind: "done", cloud: res });
        if (createMore) {
          setObjective("");
          requestAnimationFrame(() => textareaRef.current?.focus());
          // Staying to send another means staying on the card; the thread is
          // on the rail and one click away when they're done.
          return;
        }
        // Local work closes the card because something takes its place: the
        // copy opens and the agent starts in front of you. Cloud work does the
        // same, and lands in the same kind of destination — the machine's
        // workspace, with the conversation you just started as its first tab.
        // Sending work somewhere should take you there.
        openRemoteWorkspace({ threadKey, repoRoot });
        close();
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        setPhase({ kind: "error", message: humanizeGitError(raw) });
      }
      return;
    }

    // ── Local: provision an isolated worktree + spawn an agent in it. ───────
    // Start point = the Create-from selection, else HEAD (current branch).
    const startPoint = createFrom?.ref ?? "HEAD";

    trackFeature("workspace_launch");
    try {
      // Branch name: always a fresh, memorable place-name (this composer always
      // creates NEW work on a NEW branch). Read the live branch list first so
      // the auto-namer skips names already taken by the repo's existing
      // parallel copies — otherwise it collides and the worktree never gets
      // created. Fetched here (not at open) so a name minted since the card
      // opened is still excluded; on read failure we fall back to a blind pick.
      let taken = new Set<string>();
      try {
        taken = takenBranchNames(await api.gitBranches(repoRoot));
      } catch {
        /* branch read failed — fall back to a blind pick, Rust still guards */
      }
      const branch = randomPlaceName(taken);

      // ── In this folder: no second copy. `git checkout -b` is the whole of
      // it, which is why it needs a clean tree — git refuses to carry your
      // uncommitted work onto a branch that forks somewhere else, and we'd
      // rather say that in words than let the command fail underneath. The
      // separate copy is the answer to a dirty tree, so the message points
      // there instead of leaving the user stuck.
      if (!separate) {
        // `catch(() => ({}))` here answered "the tree is clean" whenever the
        // status read failed — which walked straight past the guard below and
        // into the `checkout -b` it exists to keep you out of. A read we
        // couldn't do is not a clean tree; say so and stop.
        const dirty = await api.gitStatus(repoRoot).catch(() => null);
        if (dirty === null) {
          setPhase({
            kind: "error",
            message:
              "Couldn’t check whether this folder has changes you haven’t " +
              "committed yet, so it isn’t safe to start the new work here. " +
              "Try again, or turn on Separate copy to start it beside what’s " +
              "here instead.",
          });
          return;
        }
        if (Object.keys(dirty).length > 0) {
          setPhase({
            kind: "error",
            message:
              "This folder has changes you haven’t committed yet. Commit them " +
              "first, or turn on Separate copy to start the new work beside " +
              "them without disturbing what’s here.",
          });
          return;
        }
        // Fork from what the Create-from chip says, not from wherever HEAD
        // happens to be: standing on `feat/x` and asking to start from `main`
        // has to mean main. Going there first makes `checkout -b` fork right.
        if (startPoint && startPoint !== "HEAD") {
          await api.gitCheckout(repoRoot, startPoint);
        }
        await api.gitCreateBranch(repoRoot, branch);
        // The branch chip, the roster badges and the Changes rail all read git
        // on this event — without it they'd keep naming the branch we left.
        window.dispatchEvent(new Event("aura:git-changed"));
        window.dispatchEvent(
          new CustomEvent("aura:workspace-launched", {
            detail: {
              repoRoot,
              // The "worktree" here IS this folder — the handler switches into
              // it (a re-hydrate, since we never left) and opens Aura chat
              // rooted on it, which is exactly what the copy path does.
              worktreePath: repoRoot,
              createMore,
              mission,
              model,
              effort,
            },
          }),
        );
        if (createMore) {
          setObjective("");
          setPhase({ kind: "done", path: repoRoot });
          requestAnimationFrame(() => textareaRef.current?.focus());
        } else {
          setPhase({ kind: "done", path: repoRoot });
          close();
        }
        return;
      }

      // No agents in the manifest: the worktree's working surface is Aura
      // chat, not a coding-agent terminal, and Aura runs in-process rather
      // than as a PTY. `workspace_launch` provisions the checkout and returns
      // an empty session list, which is exactly what we want — the agents this
      // work needs are the ones Aura decides to hand it to.
      // No machine on this call: the remote branch returned above, so anything
      // reaching here is being made on this laptop and has a manifest.
      const { worktreePath: path } = await launchWorkspace({
        repoRoot,
        branch,
        startPoint,
        agents: [],
      });
      // The roster is built from the app's `recents`; the launch doesn't
      // touch that list, so announce the parent repo root and let App promote
      // it — otherwise the new workspace stays invisible in the sidebar. The
      // worktree path + createMore ride along so App can (a) refresh the
      // parent's cached worktree list — the brand-new checkout has no roster
      // row until then — and (b) on a single launch, switch into the worktree
      // so the user lands in the work they just started instead of hunting
      // for it in the parallel-copies fold.
      //
      // The objective + model + effort ride along too. They can't be applied
      // here: the Aura chat they belong to doesn't exist until App has
      // switched into the worktree (starting the session from this side would
      // file it under the OUTGOING workspace's snapshot — the same trap that
      // made launched agent tabs open into a blank screen).
      window.dispatchEvent(
        new CustomEvent("aura:workspace-launched", {
          detail: {
            repoRoot,
            worktreePath: path,
            createMore,
            mission,
            model,
            effort,
          },
        }),
      );
      if (createMore) {
        // Keep the card up for the next one — clear only the objective.
        setObjective("");
        setPhase({ kind: "done", path });
        requestAnimationFrame(() => textareaRef.current?.focus());
      } else {
        setPhase({ kind: "done", path });
        close();
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message: humanizeGitError(raw) });
    }
  }, [
    repoRoot,
    objective,
    createFrom,
    createMore,
    model,
    effort,
    phase.kind,
    close,
    target,
    cloud.connected,
    separate,
    where.chosen.machineId,
    where.chosen.projectPath,
  ]);

  function onTextareaKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter submits; Shift+Enter newlines (standard composer contract).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  if (!open) return null;

  const busy = phase.kind === "busy";
  const canCreate = !!repoRoot && objective.trim().length > 0 && !busy;
  // Cloud selected but not signed in → the primary action becomes a one-click
  // "Set up cloud" (sign-in) rather than a send.
  const cloudSetup = target === "cloud" && !cloud.checking && !cloud.connected;
  const createFromLabel = createFrom
    ? createFrom.label.length > 28
      ? `${createFrom.label.slice(0, 28)}…`
      : createFrom.label
    : "Create from…";

  return (
    // Scrim + centered card. Mousedown on the scrim closes (mousedown inside
    // the card stops propagation).
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-hidden pt-[16vh]"
      style={{ background: "rgba(5,5,5,0.5)", backdropFilter: "blur(3px)" }}
      onMouseDown={close}
    >
      <div
        className="w-full max-w-[520px] min-w-0 overflow-visible rounded-xl shadow-2xl"
        style={{ background: "var(--color-bg-1)", border: "1px solid var(--color-line)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header bar — project + Create-from, ruled off from the body so the
            modal reads as header / canvas / footer (reference parity). */}
        <div className="flex items-center gap-1 border-b border-line-soft px-3 py-2">
          {/* Project picker */}
          <div className="relative min-w-0" ref={projectMenuRef}>
            <ChipButton onClick={() => setProjectMenuOpen((v) => !v)}>
              <ProjectAvatar url={repoRoot ? avatars[repoRoot] : null} size={16} />
              <span className="max-w-[150px] truncate">{activeProjectName}</span>
            </ChipButton>
            {projectMenuOpen && (
              <div
                className="absolute left-0 top-8 z-40 max-h-[40vh] w-[260px] overflow-y-auto rounded-lg py-1 shadow-xl"
                style={{
                  background: "var(--color-bg-1)",
                  border: "1px solid var(--color-line)",
                }}
              >
                {projects.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-text-4">No projects yet.</div>
                ) : (
                  projects.map((p) => {
                    const name = p.label?.trim() || projectNameFromRoot(p.root);
                    const active = p.root === repoRoot;
                    return (
                      <button
                        key={p.root}
                        type="button"
                        onClick={() => {
                          setRepoRoot(p.root);
                          setCreateFrom(null);
                          setProjectMenuOpen(false);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-state-hover"
                      >
                        <ProjectAvatar url={avatars[p.root]} size={18} />
                        <span
                          className={`truncate text-base ${active ? "text-text-1" : "text-text-2"}`}
                        >
                          {name}
                        </span>
                        <span className="ml-auto truncate font-mono text-2xs text-text-5">
                          {projectNameFromRoot(p.root)}
                        </span>
                        {active && <span className="shrink-0 text-accent text-sm">✓</span>}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Where it runs. Always present, never disabled: this laptop is
              always on the list, so the row has something true to say even for
              a project with no cloud and no box of yours. */}
          <WherePicker places={where} />

          {/* Create-from picker. Only where the base is ours to choose — on a
              box the copy forks from what that machine has checked out, and a
              picker that quietly did nothing would be the dialog lying about
              which commit the work starts from. */}
          {!onABox && (
          <div className="relative">
            <ChipButton
              onClick={() => repoRoot && setCreateFromOpen((v) => !v)}
              disabled={!repoRoot}
              active={!!createFrom}
            >
              <GitBranch size={13} className={createFrom ? "text-accent/70" : "text-text-4"} />
              <span className="max-w-[200px] truncate">{createFromLabel}</span>
            </ChipButton>
            {createFromOpen && repoRoot && (
              <CreateFromPicker
                repoRoot={repoRoot}
                value={createFrom}
                onPick={(selection) => {
                  setCreateFrom(selection);
                  // Picking a GitHub issue seeds the objective with the issue's
                  // prompt and focuses the box, so "start from this issue" lands
                  // you ready to refine rather than staring at an empty field.
                  if (selection.kind === "issue" && selection.prompt) {
                    setObjective(selection.prompt);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }
                }}
                onClose={() => setCreateFromOpen(false)}
              />
            )}
          </div>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-3">
          {/* Where the new branch lives. Only meaningful locally — a cloud run
              has no folder of yours to put it in — so it steps aside entirely
              while Cloud is on rather than sitting there greyed out. */}
          {target === "local" && !onABox && (
            <label
              className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-sm text-text-3"
              title={
                separate
                  ? "The new branch gets its own folder, so the branch you're on now stays open beside it"
                  : "The new branch is created in this folder. Nothing is copied, but you leave the branch you're on"
              }
            >
              <FolderGit2
                size={13}
                className={separate ? "text-accent" : "text-text-4"}
              />
              <span>Separate copy</span>
              <Switch
                checked={separate}
                onCheckedChange={chooseSeparate}
                aria-label="Give the new branch its own folder, so both branches stay open at once"
              />
            </label>
          )}
          {/* Hand it to the queue instead of opening it. A different offer from
              the Where row — that one says which computer holds the copy, this
              one says nobody watches it start — and it appears only where the
              project's cloud is genuinely set up, so it can never be the
              apology it used to be. The dot reads readiness while on: green = a
              runner is draining now, amber = signed in but idle (work queues). */}
          {canQueue && (
          <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-sm text-text-3">
            <Cloud
              size={13}
              className={target === "cloud" ? "text-accent" : "text-text-4"}
            />
            <span>Queue it</span>
            {target === "cloud" && (
              <span
                className={`size-1.5 rounded-full ${cloud.runnerOnline ? "bg-emerald-400" : "bg-amber-400"}`}
                aria-hidden
              />
            )}
            <Switch
              checked={target === "cloud"}
              onCheckedChange={(v) => setTarget(v ? "cloud" : "local")}
              aria-label="Hand this to the always-on machine instead of starting it in front of you"
            />
          </label>
          )}
          </div>
        </div>

        {/* Objective — borderless, blends into the card (reference-calm). */}
        <div className="px-3 pt-1.5">
          <textarea
            ref={textareaRef}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            onKeyDown={onTextareaKey}
            disabled={busy}
            rows={3}
            placeholder="What do you want to work on?"
            className="w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-1 py-1 text-md leading-relaxed text-text-1 placeholder:text-text-4 focus:outline-none disabled:opacity-60"
          />
        </div>

        {/* Turning the copy off changes what happens to the folder you're
            standing in, so it says so once, plainly, rather than letting the
            branch swap under someone who didn't expect it. */}
        {target === "local" && !separate && (
          <div className="px-3 pt-1.5 text-sm text-text-4">
            This folder switches to the new branch. Nothing is copied, but
            whatever you're on now closes here until you come back to it.
          </div>
        )}

        {/* Cloud readiness — only while the Cloud target is selected. Tells the
            user whether this runs now, queues, or needs a one-time sign-in
            (in which case the primary button becomes "Set up cloud"). */}
        {target === "cloud" && (
          <div className="px-3 pt-1.5">
            {cloud.checking ? (
              <div className="flex items-center gap-2 text-sm text-text-4">
                <AsciiSpinner /> Checking your cloud…
              </div>
            ) : !cloud.connected ? (
              <div className="flex items-start gap-2 rounded-md bg-accent-soft px-2.5 py-1.5 text-sm text-text-2">
                <Cloud size={13} className="mt-[1px] shrink-0 text-accent" />
                <span>
                  Cloud isn't set up yet. Sign in to your always-on machine to run
                  this in the cloud. It keeps working after you close your laptop.
                </span>
              </div>
            ) : cloud.runnerOnline ? (
              <div className="flex items-center gap-1.5 text-sm text-emerald-400">
                <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
                Runner online{cloud.org ? ` · ${cloud.org}` : ""}. Starts right away.
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm text-amber-400">
                <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden />
                <span>
                  Signed in{cloud.org ? ` as ${cloud.org}` : ""}, but no always-on
                  machine is running. Your task will queue until one comes online.
                </span>
              </div>
            )}
          </div>
        )}

        {/* Error / done line */}
        {phase.kind === "error" && (
          <div
            className="mx-3 mt-1 rounded-md px-2.5 py-1.5 text-sm"
            style={{ color: "var(--color-red)", background: "rgba(239,68,68,0.08)" }}
          >
            {phase.message}
          </div>
        )}
        {/* Cloud always reports back, whether or not you're creating more: it is
            the only sign the work exists, since nothing opens in front of you.
            The local line stays tied to Create-more, because a local start
            announces itself by opening the copy. */}
        {phase.kind === "done" && (phase.cloud || createMore) && (
          <div className="mx-3 mt-1 text-sm text-emerald-400">
            {phase.cloud ? (
              <>
                Sent to the cloud
                {cloud.runnerOnline
                  ? ". A machine is picking it up."
                  : ". It waits until a machine comes online."}{" "}
                <span className="text-text-3">
                  Track it under “In the cloud” on Workspaces.
                </span>
              </>
            ) : (
              "Agent started. Ready for the next one."
            )}
          </div>
        )}

        {/* Footer bar — model + effort (left), Create-more toggle + Start
            (right). The left group shrinks (min-w-0 + truncating chips) and the
            action cluster never shrinks, so the row can't overflow → no stray
            horizontal scrollbar however long the model name is. */}
        <div className="flex items-center gap-1 px-3 pb-2.5 pt-2">
          <div className="flex min-w-0 items-center gap-0.5">
            <ModelChip value={model} onChange={setModel} />
            <EffortChip value={effort} onChange={setEffort} />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-sm text-text-3">
              <Switch
                checked={createMore}
                onCheckedChange={setCreateMore}
                aria-label="Keep the composer open to create more"
              />
              Create more
            </label>

            {cloudSetup ? (
              <Button
                size="sm"
                onClick={() => window.dispatchEvent(new CustomEvent("aura:open-signin"))}
              >
                <Cloud />
                Set up cloud
              </Button>
            ) : (
              <Button
                size="sm"
                variant={target === "cloud" ? "accentSoft" : "default"}
                onClick={() => void submit()}
                disabled={!canCreate || (target === "cloud" && cloud.checking)}
              >
                {busy ? (
                  <>
                    {/* Same spinner the "Checking your cloud…" line above uses,
                        and the same one every other busy button in the app
                        uses. This button drew a lucide `Loader2` instead, so
                        one composer showed you two different loaders during
                        one create. */}
                    <AsciiSpinner />
                    {target === "cloud" ? "Sending…" : "Starting…"}
                  </>
                ) : target === "cloud" ? (
                  <>
                    Send to cloud
                    <Cloud />
                  </>
                ) : (
                  <>
                    Start agent
                    <CornerDownLeft />
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The project's GitHub-owner avatar (`github.com/<owner>.png`), shown on the
 *  project chip + each picker row. Falls back to the folder glyph when the
 *  repo isn't on GitHub, the owner hasn't resolved yet, or the image 404s. */
function ProjectAvatar({ url, size = 16 }: { url: string | null | undefined; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        onError={() => setFailed(true)}
        className="shrink-0 rounded-[4px] object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return <FolderGit2 size={size - 2} className="shrink-0 text-text-4" />;
}

// ── Model chip — real brains + catalog, local pre-session selection ─────────
// No agent session exists yet, so this can't persist an override the way
// BrainPicker does (that path needs a sessionId). Instead it reads the user's
// real brains and each family's exact models and holds the pick locally. Picks
// are genuine catalog rows, never a fake list.
function ModelChip({
  value,
  onChange,
}: {
  value: SelectedModel | null;
  onChange: (next: SelectedModel | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [brains, setBrains] = useState<BrainChoice[]>([]);
  const [liveCatalog, setLiveCatalog] = useState<ModelCatalog | null>(null);
  const selected = value;
  const rootRef = useRef<HTMLDivElement>(null);
  // Guards the one-shot default seed so it fires once per open, and never
  // overrides a pick the user has already made.
  const seededDefaultRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api
      .managerListBrains()
      .then((list) => {
        if (!cancelled) setBrains(list);
      })
      .catch(() => {
        /* no brains configured — chip shows Auto */
      });
    api
      .agentModelsList()
      .then((cat) => {
        if (!cancelled) setLiveCatalog(cat);
      })
      .catch(() => {
        /* offline — static catalog covers it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed the chip from the user's saved default model so the launcher opens on
  // their actual preference, not always on the active brain. One-shot, once the
  // brains resolve (a `SelectedModel` needs a brain to route through) and only
  // while the user hasn't picked yet. A `default` of "auto" stays `null` (=
  // follow-the-brain, already the shown default); an unresolvable id stays
  // there too, so this only ever adds a concrete default, never regresses one.
  // The brain a turn falls to when no model is pinned — what the chip names.
  const activeBrain = useMemo(() => brains.find((b) => b.active) ?? null, [brains]);

  useEffect(() => {
    if (seededDefaultRef.current) return;
    if (value != null) {
      seededDefaultRef.current = true;
      return;
    }
    if (brains.length === 0) return;
    seededDefaultRef.current = true;
    const wanted = getModelPrefs().default;
    if (wanted === "auto") return;
    // Prefer the brain the launcher actually spawns (the default agent), then
    // any Anthropic-family brain, then whatever's first.
    const brain =
      brains.find((b) => b.id === DEFAULT_AGENT_ID) ??
      brains.find((b) => familyOf(b) === "anthropic") ??
      brains[0];
    if (!brain) return;
    const rows = catalogFor(brain, liveCatalog);
    const row =
      rows.find((m) => m.id === wanted && !m.longContext) ??
      rows.find((m) => m.id === wanted);
    if (row) onChange(toSelectedModel(brain, row));
  }, [brains, liveCatalog, value, onChange]);

  useDismiss(open, () => setOpen(false), rootRef);

  function pick(brain: BrainChoice, model: CatalogModel) {
    onChange(toSelectedModel(brain, model));
    setOpen(false);
  }

  return (
    <div className="relative" ref={rootRef}>
      <ChipButton onClick={() => setOpen((v) => !v)} active={!!selected}>
        {selected ? (
          <AgentIcon agentId={selected.brainId} label={selected.label} size={13} />
        ) : activeBrain ? (
          <AgentIcon agentId={activeBrain.id} label={activeBrain.label} size={13} />
        ) : (
          <Sparkles size={12} className="text-text-4" />
        )}
        {/* Unpinned says which brain will actually run, not "Auto" — the word
            was already spoken for by the mode chip beside it. */}
        <span className="max-w-[130px] truncate">
          {selected ? selected.label : (activeBrain?.label ?? "Active brain")}
        </span>
      </ChipButton>
      {open && (
        <div
          className="absolute left-0 bottom-8 z-40 max-h-[320px] min-w-[240px] overflow-y-auto rounded-md py-1 shadow-lg"
          style={{ background: "var(--color-bg-3)", border: "1px solid var(--color-line-soft)" }}
        >
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-state-hover ${
              selected == null ? "text-text-1" : "text-text-2"
            }`}
          >
            <span className="font-medium">Follow the active brain</span>
            <span className="text-xs text-text-4">
              {activeBrain ? activeBrain.label : "whichever brain is active"}
            </span>
            {selected == null && <span className="ml-auto text-accent text-sm">✓</span>}
          </button>
          {brains.map((brain) => (
            <div key={brain.id}>
              <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-xs font-medium text-text-4">
                <AgentIcon agentId={brain.id} label={brain.label} size={13} />
                {brain.label}
              </div>
              {catalogFor(brain, liveCatalog).map((model) => {
                const isSel =
                  selected != null &&
                  selected.brainId === brain.id &&
                  selected.modelId === model.id &&
                  selected.longContext === !!model.longContext;
                const usable = !brain.requires_api_key || brain.has_api_key;
                return (
                  <button
                    key={model.key}
                    type="button"
                    disabled={!usable}
                    onClick={() => pick(brain, model)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 pl-5 text-left text-sm transition-colors ${
                      usable ? "hover:bg-state-hover" : "cursor-not-allowed opacity-50"
                    } ${isSel ? "text-text-1" : "text-text-2"}`}
                  >
                    <span className="font-medium">{model.label}</span>
                    {isSel && <span className="ml-auto text-accent text-sm">✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Effort chip — local ReasoningEffort, signal-strength gauge ──────────────
function EffortChip({
  value,
  onChange,
}: {
  value: ReasoningEffort | null;
  onChange: (next: ReasoningEffort | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const effort = value;
  const rootRef = useRef<HTMLDivElement>(null);

  useDismiss(open, () => setOpen(false), rootRef);

  // 0 = Auto/unset, 1 = low … 4 = max — drives the gauge fill.
  const level: 0 | 1 | 2 | 3 | 4 =
    effort === "low" ? 1 : effort === "medium" ? 2 : effort === "high" ? 3 : effort === "max" ? 4 : 0;

  return (
    <div className="relative" ref={rootRef}>
      <ChipButton onClick={() => setOpen((v) => !v)} active={!!effort}>
        <EffortGauge level={level} />
        {/* Always show a chosen value — `null` is the real "Auto" default
            (the app-wide default effort), never a bare "Effort" placeholder,
            so the picker never opens unselected. */}
        <span>{effortLabel(effort)}</span>
      </ChipButton>
      {open && (
        <div
          className="absolute left-0 bottom-8 z-40 min-w-[160px] rounded-md py-1 shadow-lg"
          style={{ background: "var(--color-bg-3)", border: "1px solid var(--color-line-soft)" }}
        >
          {EFFORT_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-state-hover ${
                effort === opt.value ? "text-text-1" : "text-text-2"
              }`}
            >
              <span className="font-medium">{opt.label}</span>
              {effort === opt.value && <span className="ml-auto text-accent text-sm">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Signal-strength gauge mirroring the ManagerComposer effort glyph — four
 *  ascending bars that light low → high. Purely presentational. */
function EffortGauge({ level }: { level: 0 | 1 | 2 | 3 | 4 }) {
  const bars = [
    { x: 0.5, y: 8, h: 3 },
    { x: 4, y: 5.5, h: 5.5 },
    { x: 7.5, y: 3, h: 8 },
    { x: 11, y: 0.5, h: 10.5 },
  ];
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor" aria-hidden>
      {bars.map((b, i) => (
        <rect
          key={b.x}
          x={b.x}
          y={b.y}
          width="2.2"
          height={b.h}
          rx="0.8"
          style={{ opacity: i < level ? 1 : 0.28 }}
        />
      ))}
    </svg>
  );
}
