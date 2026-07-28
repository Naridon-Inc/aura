// WorkspaceCreateComposer — the compact, Conductor-style "start a new agent"
// card. One centered panel: pick the project, pick what to start FROM (a
// branch or an open PR), say what you want to work on, choose a model + effort,
// and Start agent. Starting provisions a real isolated worktree (a fresh copy
// of the project) and spawns an agent in it (via `launchWorkspace`), seeding
// your objective as the agent's opening mission — so "describe it and go" lands
// one working agent on its own branch, to merge back when you're happy.
//
// Self-contained surface: it mounts once and stays dormant until a
// `window` "aura:new-workspace" CustomEvent opens it (optional
// `detail.repoRoot` to preselect a project). Esc / click-away / a successful
// start close it — unless "Create more" is on, which clears the objective and
// keeps the card up for the next one. No title, by doctrine — the card's own
// affordances carry the meaning.
//
// Models + effort are real but pre-session: there's no agent session yet to
// persist an override against, so the model chip reads the user's actual
// brains/catalog (`managerListBrains` + `agentModelsList`) and the composer
// holds the choice; effort holds a `ReasoningEffort`. Both ride into the
// launch (`launchWorkspace` → `workspace_launch` → the agent's PTY spawn) as
// real `--model` / reasoning-effort flags on the agent CLI — the controls are
// wired to real catalogs and a real spawn, never a fake list.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cloud,
  CornerDownLeft,
  FolderGit2,
  GitBranch,
  Loader2,
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
import { knownCrewProjectRoots, projectNameFromRoot } from "../commons/crew/crewProjects";
import { launchWorkspace } from "../../lib/workspaceCreateStore";
import { trackFeature } from "../../lib/track";
import { randomPlaceName } from "../../lib/placeNames";
import { CreateFromPicker, type CreateFromSelection } from "./CreateFromPicker";

/** Default agent for a fresh workspace — the native Claude agent the `/launch`
 *  verb uses. Real CLI id, not a placeholder. */
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
 *  `ReasoningEffort` knob. `null` = let the model choose (Auto). */
const EFFORT_OPTIONS: { value: ReasoningEffort | null; label: string }[] = [
  { value: null, label: "Auto" },
  { value: "low", label: "Fast" },
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
    const roots = await knownCrewProjectRoots(preferRoot).catch(
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

  // Resolve cloud readiness while the Cloud target is active. Sign-in status
  // gates the setup path; runner liveness (scoped to the selected project)
  // tells us whether a task drains now or queues until a machine comes online.
  useEffect(() => {
    if (!open || target !== "cloud") return;
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
        try {
          const mission = await missionState(repoRoot ? [repoRoot] : undefined);
          runnerOnline = mission.host.online;
        } catch {
          /* mission read failed — assume no runner, non-blocking */
        }
      }
      if (cancelled) return;
      setCloud({ checking: false, connected, org, runnerOnline });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, target, repoRoot, authTick]);

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
  useEffect(() => {
    if (!projectMenuOpen) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (projectMenuRef.current && t && !projectMenuRef.current.contains(t)) {
        setProjectMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [projectMenuOpen]);

  const activeProjectName = useMemo(() => {
    if (!repoRoot) return "Choose a project";
    const entry = projects.find((p) => p.root === repoRoot);
    return entry?.label?.trim() || projectNameFromRoot(repoRoot);
  }, [repoRoot, projects]);

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

    // ── Cloud: hand the objective to the always-on runner as a submitted a2a
    // task (scoped to this repo's origin). No local worktree — a runner drains
    // it, and results come back via cloud-sync. ────────────────────────────
    if (target === "cloud") {
      trackFeature("workspace_cloud_launch");
      try {
        const res = await api.loopCloudSend(repoRoot, mission, DEFAULT_AGENT_ID);
        window.dispatchEvent(
          new CustomEvent("aura:cloud-task-created", {
            detail: { repoRoot, id: res.id, status: res.status },
          }),
        );
        if (createMore) {
          setObjective("");
          setPhase({ kind: "done", cloud: res });
          requestAnimationFrame(() => textareaRef.current?.focus());
        } else {
          setPhase({ kind: "done", cloud: res });
          close();
        }
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
      const { manifest, tabs } = await launchWorkspace({
        repoRoot,
        branch,
        startPoint,
        agents: [{ agentId: DEFAULT_AGENT_ID }],
        prompt: mission,
        // Model id (e.g. "claude-opus-4-8") + effort ride into the launch as
        // the agent's pre-session intent; `null`/undefined = the agent keeps
        // its own default.
        model: model?.modelId ?? undefined,
        effort: effort ?? undefined,
        // Single launch switches into the worktree — defer tab placement so App
        // opens the agent ACTIVELY there (lands the user in the running chat,
        // not the empty worktree). Create-more launches keep passive placement.
        deferTabPlacement: !createMore,
      });
      const path = manifest.worktree.path;
      // The roster is built from the app's `recents`; the launch doesn't
      // touch that list, so announce the parent repo root and let App promote
      // it — otherwise the new workspace stays invisible in the sidebar. The
      // worktree path + createMore ride along so App can (a) refresh the
      // parent's cached worktree list — the brand-new checkout has no roster
      // row until then — and (b) on a single launch, switch into the worktree
      // so the user lands in the agent they just started instead of hunting
      // for it in the parallel-copies fold.
      window.dispatchEvent(
        new CustomEvent("aura:workspace-launched", {
          detail: { repoRoot, worktreePath: path, createMore, tabs },
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
                  <div className="px-3 py-2 text-[11.5px] text-text-4">No projects yet.</div>
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
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-bg-2"
                      >
                        <ProjectAvatar url={avatars[p.root]} size={18} />
                        <span
                          className={`truncate text-[12.5px] ${active ? "text-text-1" : "text-text-2"}`}
                        >
                          {name}
                        </span>
                        <span className="ml-auto truncate font-mono text-[9.5px] text-text-5">
                          {projectNameFromRoot(p.root)}
                        </span>
                        {active && <span className="shrink-0 text-accent text-[12px]">✓</span>}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Create-from picker */}
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

          {/* Run target — one Cloud switch: off = a local isolated worktree
              (default), on = the always-on cloud runner. The dot reads
              readiness while on: green = a runner is draining now, amber =
              signed in but idle (work queues). */}
          <label className="ml-auto flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[11.5px] text-text-3">
            <Cloud
              size={13}
              className={target === "cloud" ? "text-accent" : "text-text-4"}
            />
            <span>Cloud</span>
            {target === "cloud" && cloud.connected && (
              <span
                className={`size-1.5 rounded-full ${cloud.runnerOnline ? "bg-emerald-400" : "bg-amber-400"}`}
                aria-hidden
              />
            )}
            <Switch
              checked={target === "cloud"}
              onCheckedChange={(v) => setTarget(v ? "cloud" : "local")}
              aria-label="Run this work on the cloud runner instead of locally"
            />
          </label>
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
            className="w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-1 py-1 text-[13.5px] leading-relaxed text-text-1 placeholder:text-text-4 focus:outline-none disabled:opacity-60"
          />
        </div>

        {/* Cloud readiness — only while the Cloud target is selected. Tells the
            user whether this runs now, queues, or needs a one-time sign-in
            (in which case the primary button becomes "Set up cloud"). */}
        {target === "cloud" && (
          <div className="px-3 pt-1.5">
            {cloud.checking ? (
              <div className="flex items-center gap-2 text-[11.5px] text-text-4">
                <AsciiSpinner /> Checking your cloud…
              </div>
            ) : !cloud.connected ? (
              <div className="flex items-start gap-2 rounded-md bg-accent-soft px-2.5 py-1.5 text-[11.5px] text-text-2">
                <Cloud size={13} className="mt-[1px] shrink-0 text-accent" />
                <span>
                  Cloud isn't set up yet. Sign in to your always-on machine to run
                  this in the cloud — it keeps working after you close your laptop.
                </span>
              </div>
            ) : cloud.runnerOnline ? (
              <div className="flex items-center gap-1.5 text-[11.5px] text-emerald-400">
                <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
                Runner online{cloud.org ? ` · ${cloud.org}` : ""} — starts right away.
              </div>
            ) : (
              <div className="flex items-start gap-2 text-[11.5px] text-amber-400">
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
            className="mx-3 mt-1 rounded-md px-2.5 py-1.5 text-[11.5px]"
            style={{ color: "var(--color-red)", background: "rgba(239,68,68,0.08)" }}
          >
            {phase.message}
          </div>
        )}
        {phase.kind === "done" && createMore && (
          <div className="mx-3 mt-1 text-[11.5px] text-emerald-400">
            {phase.cloud
              ? `Sent to cloud — task ${phase.cloud.id.slice(0, 8)} (${phase.cloud.status}). Ready for the next one.`
              : "Agent started — ready for the next one."}
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
            <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11.5px] text-text-3">
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
                    <Loader2 className="animate-spin" />
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
  // their actual preference, not always "Auto". One-shot, once the brains
  // resolve (a `SelectedModel` needs a brain to route through) and only while
  // the user hasn't picked yet. A `default` of "auto" stays `null` (= the Auto
  // row, already the shown default); an unresolvable id also stays Auto, so
  // this only ever adds a concrete default, never regresses one.
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

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (rootRef.current && t && !rootRef.current.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(brain: BrainChoice, model: CatalogModel) {
    onChange(toSelectedModel(brain, model));
    setOpen(false);
  }

  return (
    <div className="relative" ref={rootRef}>
      <ChipButton onClick={() => setOpen((v) => !v)} active={!!selected}>
        {selected ? (
          <AgentIcon agentId={selected.brainId} label={selected.label} size={13} />
        ) : (
          <Sparkles size={12} className="text-text-4" />
        )}
        <span className="max-w-[130px] truncate">{selected ? selected.label : "Auto"}</span>
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
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-bg-2 ${
              selected == null ? "text-text-1" : "text-text-2"
            }`}
          >
            <span className="font-medium">Auto</span>
            <span className="text-[10.5px] text-text-4">model's choice</span>
            {selected == null && <span className="ml-auto text-accent text-[12px]">✓</span>}
          </button>
          {brains.map((brain) => (
            <div key={brain.id}>
              <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-3">
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
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 pl-5 text-left text-[12px] transition-colors ${
                      usable ? "hover:bg-bg-2" : "cursor-not-allowed opacity-50"
                    } ${isSel ? "text-text-1" : "text-text-2"}`}
                  >
                    <span className="font-medium">{model.label}</span>
                    {isSel && <span className="ml-auto text-accent text-[12px]">✓</span>}
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

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (rootRef.current && t && !rootRef.current.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

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
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-bg-2 ${
                effort === opt.value ? "text-text-1" : "text-text-2"
              }`}
            >
              <span className="font-medium">{opt.label}</span>
              {effort === opt.value && <span className="ml-auto text-accent text-[12px]">✓</span>}
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
