// The new-workspace dialog: which repository, where it runs, what it starts
// from, and what you want to work on. Opened by `aura:new-workspace` (the
// sidebar's Create row, ⌘N, a repository's "New workspace"); `createFrom`
// opens it with the starting-point menu already down, and `from` opens it
// already starting from that branch or pull request.
//
// The dialog only gathers answers. How each kind of start runs — on a machine,
// queued for the always-on runner, in a separate copy, in this folder — lives
// in `launchNewWork.ts`, so the guards there are read in one place.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";

import { api, type ReasoningEffort } from "../../lib/api";
import type { SelectedModel } from "../../lib/modelCatalog";
import { knownProjectRoots } from "../../lib/projectRoots";
import { openRemoteWorkspace } from "../../lib/editorStore";
import { pickPath } from "../../lib/nativeDialog";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  WorkspacesCreateDialog,
  type WorkspacesCreateChip,
  type WorkspacesCreateNote,
} from "../ui/workspaces-create";
import { humanizeGitError } from "../git/branches";
import { WherePicker, useWherePlaces } from "../place/WherePicker";
import {
  CreateFromPicker,
  defaultStartBranch,
  type CreateFromSelection,
} from "./CreateFromPicker";
import type { CreateWorkspaceRequest } from "./createWorkspaceEvents";
import { CreateModelPicker } from "./CreateModelPicker";
import { CreateOptionsMenu } from "./CreateOptionsMenu";
import {
  CreateRepositoryMenu,
  repositoryName,
  type KnownRepository,
} from "./CreateRepositoryMenu";
import {
  DEFAULT_AGENT_ID,
  queueForRunner,
  startLocally,
  startOnMachine,
  type NewWorkOutcome,
} from "./launchNewWork";
import { useCloudReadiness } from "./useCloudReadiness";

/** Where the work runs when it is not on a machine: a checkout here, or the
 *  always-on runner's queue. */
type Target = "local" | "cloud";

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; queued: boolean }
  | { kind: "error"; message: string };

const SEPARATE_KEY = "aura.newwork.separate";

/** Does the new branch get its own folder? On (the default) keeps the branch
 *  you are on checked out beside it; off creates it right here. Sticky,
 *  because which one you want is a habit, not a per-task call. */
function useSeparateCopy(): [boolean, (next: boolean) => void] {
  const [separate, setSeparate] = useState(() => {
    try {
      return localStorage.getItem(SEPARATE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const choose = useCallback((next: boolean) => {
    setSeparate(next);
    try {
      localStorage.setItem(SEPARATE_KEY, next ? "1" : "0");
    } catch {
      /* storage full — the choice just won't stick */
    }
  }, []);
  return [separate, choose];
}

function startChipLabel(start: CreateFromSelection): string {
  if (start.kind === "branch") return `Branch: ${start.label}`;
  if (start.kind === "pr") return `Pull request ${start.label}`;
  return `Issue ${start.label}`;
}

export function WorkspaceCreateComposer() {
  const [open, setOpen] = useState(false);
  const [repositories, setRepositories] = useState<KnownRepository[]>([]);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [createFromOpen, setCreateFromOpen] = useState(false);
  const [createFrom, setCreateFrom] = useState<CreateFromSelection | null>(null);
  const [defaultStart, setDefaultStart] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [createMore, setCreateMore] = useState(false);
  // `null` on either is the model's own default.
  const [model, setModel] = useState<SelectedModel | null>(null);
  const [effort, setEffort] = useState<ReasoningEffort | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [target, setTarget] = useState<Target>("local");
  const [separate, chooseSeparate] = useSeparateCopy();
  const cloud = useCloudReadiness(open, repoRoot);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const openComposer = useCallback(async (preferRoot?: string) => {
    setOpen(true);
    setPhase({ kind: "idle" });
    setCreateFrom(null);
    setDefaultStart(null);
    setCreateFromOpen(false);
    const roots = await knownProjectRoots(preferRoot).catch(() => [] as KnownRepository[]);
    setRepositories(roots);
    setRepoRoot(preferRoot ?? roots[0]?.root ?? null);
  }, []);

  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<CreateWorkspaceRequest | undefined>).detail;
      void openComposer(detail?.repoRoot).then(() => {
        // Set after the reset; the default-branch read never overrides a
        // start that is already chosen.
        if (detail?.from) setCreateFrom(detail.from);
        else if (detail?.createFrom) setCreateFromOpen(true);
      });
    }
    window.addEventListener("aura:new-workspace", onOpen);
    return () => window.removeEventListener("aura:new-workspace", onOpen);
  }, [openComposer]);

  const close = useCallback(() => {
    setOpen(false);
    setCreateFromOpen(false);
  }, []);

  // Open on the repository's default branch, so the starting point is a real
  // branch from the first frame. `cur ??` never overrides a pick.
  useEffect(() => {
    if (!open || !repoRoot) return;
    let cancelled = false;
    api
      .gitBranchesRich(repoRoot)
      .then((rows) => {
        if (cancelled) return;
        const def = defaultStartBranch(rows);
        if (!def) return;
        setDefaultStart(def.name);
        setCreateFrom((cur) => cur ?? { kind: "branch", ref: def.name, label: def.name });
      })
      .catch(() => {
        /* unreadable repository — the start stays HEAD */
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot]);

  const repositoryLabel = useMemo(
    () =>
      repoRoot
        ? repositoryName(repositories.find((r) => r.root === repoRoot), repoRoot)
        : "Choose a repository",
    [repoRoot, repositories],
  );

  // Where the work runs. This laptop always leads; every machine of yours is
  // listed whichever repository you are in — `lib/place/where.ts` holds the
  // rule so no surface decides it a second time.
  const where = useWherePlaces(repoRoot, repositoryLabel);
  const onABox = where.chosen.machineId !== null;

  // The runner's queue is offered only when the cloud is actually set up; a
  // choice whose whole content would be "not set up yet" is not offered.
  const canQueue = !onABox && !cloud.checking && cloud.connected;
  useEffect(() => {
    if (!canQueue && target === "cloud") setTarget("local");
  }, [canQueue, target]);

  const pickRepository = useCallback((root: string) => {
    setRepoRoot(root);
    setCreateFrom(null);
    setDefaultStart(null);
    setPhase({ kind: "idle" });
  }, []);

  const addRepository = useCallback(async () => {
    const picked = await pickPath({ directory: true, title: "Add repository" }).catch(() => null);
    const root = typeof picked === "string" ? picked : null;
    if (!root) return;
    // The registry is what every repository list reads, so the new one is
    // still there the next time any of them opens.
    await api.projectsRegister(root).catch(() => null);
    setRepositories((rows) => (rows.some((r) => r.root === root) ? rows : [{ root }, ...rows]));
    pickRepository(root);
  }, [pickRepository]);

  const finish = useCallback(
    (outcome: NewWorkOutcome, root: string) => {
      if (outcome.kind === "refused") {
        setPhase({ kind: "error", message: outcome.message });
        return;
      }
      setPhase({ kind: "done", queued: outcome.kind === "queued" });
      if (createMore) {
        setObjective("");
        requestAnimationFrame(() => textRef.current?.focus());
        return;
      }
      if (outcome.kind === "machine") {
        openRemoteWorkspace({
          machineId: outcome.machineId,
          repoRoot: root,
          remoteRoot: outcome.worktreePath ?? undefined,
        });
      } else if (outcome.kind === "queued") {
        openRemoteWorkspace({ threadKey: outcome.threadKey, repoRoot: root });
      }
      close();
    },
    [createMore, close],
  );

  const submit = useCallback(async () => {
    if (!repoRoot || phase.kind === "busy") return;
    const mission = objective.trim();
    if (!mission) return;
    if (target === "cloud" && !cloud.connected) {
      window.dispatchEvent(new CustomEvent("aura:open-signin"));
      return;
    }
    setPhase({ kind: "busy" });
    const machineId = where.chosen.machineId;
    try {
      const outcome = machineId
        ? await startOnMachine({
            repoRoot,
            mission,
            machineId,
            projectPath: where.chosen.projectPath,
            agentId: model?.brainId ?? DEFAULT_AGENT_ID,
          })
        : target === "cloud"
          ? await queueForRunner({ repoRoot, mission })
          : await startLocally({
              repoRoot,
              separate,
              startPoint: createFrom?.ref ?? "HEAD",
              continues: createFrom?.kind === "pr" ? (createFrom.continues ?? null) : null,
              launched: { createMore, mission, model, effort },
            });
      finish(outcome, repoRoot);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message: humanizeGitError(raw) });
    }
  }, [
    repoRoot,
    phase.kind,
    objective,
    target,
    cloud.connected,
    where.chosen.machineId,
    where.chosen.projectPath,
    model,
    effort,
    separate,
    createFrom,
    createMore,
    finish,
  ]);

  const busy = phase.kind === "busy";
  const queued = target === "cloud";
  const canCreate = !!repoRoot && objective.trim().length > 0 && !busy;
  const startShown = !onABox && !queued;

  const chips: WorkspacesCreateChip[] =
    startShown && createFrom && !(createFrom.kind === "branch" && createFrom.ref === defaultStart)
      ? [
          {
            key: "start",
            label: startChipLabel(createFrom),
            onRemove: () =>
              setCreateFrom(
                defaultStart ? { kind: "branch", ref: defaultStart, label: defaultStart } : null,
              ),
          },
        ]
      : [];

  const notes: WorkspacesCreateNote[] = [];
  if (startShown && !separate) {
    notes.push({
      key: "here",
      children:
        "This folder switches to the new branch. Nothing is copied, but whatever you're on now closes here until you come back to it.",
    });
  }
  if (queued) {
    notes.push(
      cloud.runnerOnline
        ? {
            key: "runner",
            tone: "success",
            children: `Runner online${cloud.org ? ` · ${cloud.org}` : ""}. Starts right away.`,
          }
        : {
            key: "runner",
            tone: "warning",
            children: `Signed in${cloud.org ? ` as ${cloud.org}` : ""}, but no always-on machine is running. Your task will queue until one comes online.`,
          },
    );
  }
  if (phase.kind === "error") notes.push({ key: "error", tone: "danger", children: phase.message });
  // A queued task always reports back: nothing opens in front of you, so this
  // line is the only sign it exists. A local start announces itself by opening.
  if (phase.kind === "done" && (phase.queued || createMore)) {
    notes.push({
      key: "done",
      tone: "success",
      children: phase.queued
        ? `Sent to the cloud. ${cloud.runnerOnline ? "A machine is picking it up." : "It waits until a machine comes online."} It shows in Workspaces.`
        : "Workspace created. Ready for the next one.",
    });
  }

  const header = (
    <>
      <CreateRepositoryMenu
        repositories={repositories}
        value={repoRoot}
        onPick={pickRepository}
        onAdd={() => void addRepository()}
      />
      <span className="ui-workspaces-create-spacer" />
      <span className="ui-workspaces-create-where">
        <WherePicker places={where} />
      </span>
      {startShown && (
        <>
          <i />
          <CreateFromPicker
            repoRoot={repoRoot}
            value={createFrom}
            open={createFromOpen}
            onOpenChange={setCreateFromOpen}
            onPick={(selection) => {
              setCreateFrom(selection);
              setCreateFromOpen(false);
              // An issue is a whole objective; it replaces the draft.
              if (selection.kind === "issue" && selection.prompt) setObjective(selection.prompt);
            }}
          />
        </>
      )}
    </>
  );

  const footer = (
    <>
      <CreateModelPicker
        model={model}
        effort={effort}
        onModelChange={setModel}
        onEffortChange={setEffort}
      />
      <span className="ui-workspaces-create-spacer" />
      <CreateOptionsMenu
        separate={onABox || queued ? null : separate}
        onSeparateChange={chooseSeparate}
        queued={canQueue ? queued : null}
        onQueuedChange={(next) => setTarget(next ? "cloud" : "local")}
        createMore={createMore}
        onCreateMoreChange={setCreateMore}
      />
      <Button type="submit" size="sm" disabled={!canCreate}>
        {busy ? (
          <>
            <AsciiSpinner />
            {queued ? "Sending…" : "Creating…"}
          </>
        ) : (
          <>
            {queued ? "Send to cloud" : "Create"}
            <CornerDownLeft size={13} />
          </>
        )}
      </Button>
    </>
  );

  return (
    <WorkspacesCreateDialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      header={header}
      footer={footer}
      chips={chips}
      notes={notes}
      prompt={objective}
      onPromptChange={setObjective}
      onSubmit={() => void submit()}
      busy={busy}
      textRef={textRef}
    />
  );
}
