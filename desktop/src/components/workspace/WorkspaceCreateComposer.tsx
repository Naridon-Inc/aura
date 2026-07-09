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
  CornerDownLeft,
  FolderGit2,
  GitBranch,
  Loader2,
  Sparkles,
} from "lucide-react";

import {
  api,
  type BrainChoice,
  type GitBranchInfo,
  type ModelCatalog,
  type ReasoningEffort,
} from "../../lib/api";
import { Button } from "../ui/button";
import { ChipButton } from "../ui/chip";
import { Switch } from "../ui/switch";
import {
  catalogFor,
  toSelectedModel,
  type CatalogModel,
  type SelectedModel,
} from "../../lib/modelCatalog";
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

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; path: string }
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

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  // ── Open/close, driven by the window event ─────────────────────────────
  // Listen for the trigger. `detail.repoRoot` (when present) becomes the
  // preselected project; otherwise the first known project leads.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ repoRoot?: string }>).detail;
      void openComposer(detail?.repoRoot);
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

    // Start point = the Create-from selection, else HEAD (current branch).
    const startPoint = createFrom?.ref ?? "HEAD";

    setPhase({ kind: "busy" });
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
      const { manifest } = await launchWorkspace({
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
          detail: { repoRoot, worktreePath: path, createMore },
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
  }, [repoRoot, objective, createFrom, createMore, model, effort, phase.kind, close]);

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
                onPick={setCreateFrom}
                onClose={() => setCreateFromOpen(false)}
              />
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
            className="w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-1 py-1 text-[13.5px] leading-relaxed text-text-1 placeholder:text-text-4 focus:outline-none disabled:opacity-60"
          />
        </div>

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
            Agent started — ready for the next one.
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

            <Button size="sm" onClick={() => void submit()} disabled={!canCreate}>
              {busy ? (
                <>
                  <Loader2 className="animate-spin" />
                  Starting…
                </>
              ) : (
                <>
                  Start agent
                  <CornerDownLeft />
                </>
              )}
            </Button>
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
        <Sparkles size={12} className={selected ? "text-accent/70" : "text-text-4"} />
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
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-3">
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
        <span>{effort ? effortLabel(effort) : "Effort"}</span>
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
