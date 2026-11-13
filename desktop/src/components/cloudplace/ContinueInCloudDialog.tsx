// Move to cloud: hand a local workspace's branch, its pull request, its
// uncommitted edits and its chat to the team's cloud computer, which carries
// on from there by itself, so this laptop can close.
//
// The dialog reads before it offers. It says what gets saved and pushed
// first, what stays on this laptop, which computer takes it, and whether
// there is a chat to bring. Only then is there a button. The work itself is
// `moveToCloud` (lib/continueInCloud.ts). A team with no cloud computer, but
// a machine in this laptop's book that has the repository, still gets the
// older path: the chat runs there and is driven from here (`continueInCloud`).

import { useEffect, useMemo, useState } from "react";

import { Dialog } from "../Dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { api, type ChatTurn } from "../../lib/api";
import {
  boxChat,
  engineFor,
  findMachineFor,
  githubSlugOf,
  holdFirstPrompt,
  takeFirstPrompt,
  type BoxTarget,
} from "../../lib/cloudBoxChat";
import { boxComputersOf, handToComputer, type BoxComputer } from "../../lib/cloudBoxDrive";
import { openCloudWorkspace, setCloudNotice } from "../../lib/cloudPlace";
import { cloudPrApi, reasonIssue } from "../../lib/cloudPullRequest";
import { fetchAheadBehind, invalidateGitState } from "../../lib/gitStateCache";
import { fetchManagerList } from "../../lib/managerCache";
import { cloudApi, cloudProblem } from "../../lib/cloudWorkspacesApi";
import {
  cannotReach,
  continueInCloud,
  handoffLines,
  moveToCloud,
  openingNote,
  planHandoff,
  wipPaths,
  type HandoffState,
  type MoveDeps,
} from "../../lib/continueInCloud";
import { rememberMovedToCloud } from "../../lib/movedToCloud";
import { setWorkspaceArchived } from "../../lib/workspaceCustomization";
import { cloudPlaceDataNow, reloadCloudPlace, useCloudPlaceData, valueOf } from "./cloudPlaceStore";
import { meAmong } from "./cloudPeople";
import { PUBLIC_ROW_PREFIX } from "./cloudRows";
import { useCloudModels } from "./cloudModels";
import { SetUpCloudAgentButton } from "./CloudAgentsHost";
import "../ui/continue-in-cloud.css";

export type ContinueInCloudRequest = {
  /** The local workspace's folder. */
  path: string;
  branch: string;
  title: string;
  /** Its open pull request, when it has one. */
  pr: number | null;
  /** The repository's main checkout, which can't be archived away. */
  isMain?: boolean;
};

const EVENT = "aura:continue-in-cloud";

/** Open the dialog from anywhere (a row menu, a command). */
export function requestContinueInCloud(request: ContinueInCloudRequest): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: request }));
}

/** Mounted once; shows the dialog for whichever workspace asked last. */
export function ContinueInCloudHost() {
  const [request, setRequest] = useState<ContinueInCloudRequest | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      const detail = (e as CustomEvent<ContinueInCloudRequest>).detail;
      if (detail?.path && detail.branch) setRequest(detail);
    };
    window.addEventListener(EVENT, open);
    return () => window.removeEventListener(EVENT, open);
  }, []);
  if (!request) return null;
  return <ContinueInCloudDialog key={request.path} {...request} onClose={() => setRequest(null)} />;
}

/** Where the work can go: the team's computers, which answer by themselves,
 *  or else a machine this laptop drives the chat on. */
type Destination = { kind: "computer"; computers: BoxComputer[] } | { kind: "machine"; target: BoxTarget };

type Ready = {
  /** Where the branch stands on this laptop. */
  facts: HandoffState;
  repo: string;
  to: Destination;
  turns: ChatTurn[];
  /** The local chat the turns came from, told where the work went. */
  sessionId: string | null;
};

type Read = { state: "checking" } | { state: "refused"; why: string } | ({ state: "ready" } & Ready);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Everything the dialog has to know before it can offer the button. */
async function readHandoff(path: string, cloudRepos: string[]): Promise<Read> {
  let ab, status, origin;
  try {
    [ab, status, origin] = await Promise.all([fetchAheadBehind(path), api.gitStatus(path), api.gitRemoteOrigin(path)]);
  } catch (e) {
    return { state: "refused", why: `Couldn’t read where this branch stands, so nothing was moved: ${errorText(e)}` };
  }
  const facts: HandoffState = { ...ab, uncommitted: Object.keys(status ?? {}).length };
  // Refusals that no choice in the dialog can lift come now.
  const plain = planHandoff(facts);
  if (!plain.ok) return { state: "refused", why: plain.why };
  const slug = githubSlugOf(origin);
  if (!slug) {
    return { state: "refused", why: "This project’s origin isn’t on GitHub, so a cloud computer has nowhere to fetch the branch from." };
  }
  // The organization's own spelling of the repository, when it has it.
  const repo = cloudRepos.find((r) => r.toLowerCase() === slug) ?? slug;
  const computers = boxComputersOf(await api.placesList().catch(() => null));
  let to: Destination | null = computers.length ? { kind: "computer", computers } : null;
  if (!to) {
    const target = await findMachineFor(repo);
    if (target) to = { kind: "machine", target };
  }
  if (!to) {
    return {
      state: "refused",
      why: "Your team has no cloud computer yet, so there’s nowhere to move this to. Set one up from Cloud, then try again.",
    };
  }
  const sessions = await fetchManagerList(path).catch(() => []);
  const sessionId = sessions[0]?.id ?? null;
  const latest = sessionId ? await api.managerStatus(sessionId).catch(() => null) : null;
  return { state: "ready", facts, repo, to, turns: latest?.chat ?? [], sessionId };
}

/** Commit every uncommitted change in the folder, so it travels with the branch. */
async function saveWip(path: string, message: string): Promise<void> {
  const paths = wipPaths(await api.gitStatusV2(path));
  if (paths.length) await api.gitStage(path, paths);
  await api.gitCommit(path, message);
}

/** Why the computer couldn't fetch the branch from GitHub, or null. */
async function reach(workspaceId: string, branch: string): Promise<string | null> {
  const read = await cloudPrApi.read(workspaceId, branch);
  if (!cannotReach(read.reason)) return null;
  return reasonIssue(read.reason!, read.detail)?.description ?? read.detail ?? "GitHub won’t let the cloud computer fetch this repository.";
}

type Props = ContinueInCloudRequest & { onClose: () => void };

export function ContinueInCloudDialog({ path, branch, title, pr, isMain = false, onClose }: Props) {
  const data = useCloudPlaceData();
  const { models, model, loaded } = useCloudModels();
  const [read, setRead] = useState<Read>({ state: "checking" });
  const [carry, setCarry] = useState(true);
  const [bring, setBring] = useState(true);
  const [onlyInvited, setOnlyInvited] = useState(false);
  const [archiveHere, setArchiveHere] = useState(false);
  const [placeId, setPlaceId] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read once the organization's repositories have answered (or been
  // refused), so the computers are asked once and not again on every poll.
  const reposSettled = data.repos.state !== "loading";
  useEffect(() => {
    if (!reposSettled) return;
    let live = true;
    const repos = valueOf(cloudPlaceDataNow().repos, []).map((r) => r.full_name);
    void readHandoff(path, repos).then((r) => live && setRead(r));
    return () => {
      live = false;
    };
  }, [path, reposSettled]);

  const members = valueOf(data.members, []);
  const you = members.find((m) => m.user_id === meAmong(members, data.userId, data.login));
  const authorName = you ? you.display_name || you.github_login : null;
  const ready = read.state === "ready" ? read : null;
  const to = ready?.to ?? null;
  const computers = to?.kind === "computer" ? to.computers : [];
  const computer = computers.find((c) => c.placeId === placeId) ?? computers[0] ?? null;
  // A machine this laptop drives needs an agent connected for the cloud; the
  // team's computer runs its own.
  const engine = to?.kind === "machine" && models.length ? engineFor(models, model.model) : null;
  const plan = useMemo(() => (ready ? planHandoff(ready.facts, carry) : null), [ready, carry]);
  const said = ready ? ready.turns.filter((t) => (t.role === "user" || t.role === "manager") && t.text.trim()).length : 0;
  const where = computer?.name ?? (to?.kind === "machine" ? to.target.machineName : null);
  const canGo = !!plan?.ok && !busy && (to?.kind === "computer" ? !!computer : !!engine);

  async function go() {
    if (!ready || !plan?.ok || !canGo || !where) return;
    setBusy(true);
    setError(null);
    try {
      const note = openingNote({ branch: plan.branch, pr, turns: bring ? ready.turns : [], next, wip: plan.wip });
      const create: MoveDeps["create"] = (draft) =>
        cloudApi.createWorkspace(draft).catch((e) => Promise.reject(new Error(cloudProblem(e).message)));
      const push: MoveDeps["push"] = (p, up) => api.gitPush(p, up).finally(invalidateGitState);
      const archive: MoveDeps["archive"] = (id) => cloudApi.setWorkspaceState(id, "archive");
      const shared = { path, title, pr, repo: ready.repo, plan, model: model.model || null, access: onlyInvited ? "restricted" : null, note } as const;
      let workspaceId: string;
      let warning: string | null = null;
      if (to?.kind === "computer" && computer) {
        const out = await moveToCloud(
          { ...shared, computer },
          {
            saveWip,
            push,
            create,
            reach,
            link: (id, c, b) => handToComputer(id, c, b),
            prompt: (id, text, m) => cloudApi.prompt(id, text, m),
            archive,
          },
        );
        workspaceId = out.workspaceId;
        warning = out.warning;
      } else if (to?.kind === "machine" && engine) {
        const out = await continueInCloud(
          { ...shared, target: to.target, engine, authorName },
          {
            saveWip,
            push,
            create,
            hold: (id, prompt) => holdFirstPrompt(localStorage, id, prompt),
            take: (id) => takeFirstPrompt(localStorage, id),
            open: (o) => boxChat.open(o),
            archive,
          },
        );
        workspaceId = out.workspaceId;
      } else {
        return;
      }
      invalidateGitState();
      rememberMovedToCloud(path, { workspaceId, machine: where, branch: plan.branch, at: Date.now() });
      if (ready.sessionId) {
        void api
          .managerAppendChat(ready.sessionId, "system", `Moved to the cloud, on ${where}. The work carries on there.`)
          .catch(() => undefined);
      }
      if (archiveHere && !isMain) setWorkspaceArchived(path, true);
      const lands = pr ? `pull request #${pr}` : "the same branch";
      setCloudNotice(warning ?? `${plan.branch} moved to ${where}. It carries on there and pushes to ${lands}.`);
      await reloadCloudPlace();
      onClose();
      openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${workspaceId}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      width={500}
      title="Move to cloud"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void go()} disabled={!canGo}>
            {busy ? "Moving…" : "Move to cloud"}
          </Button>
        </>
      }
    >
      <div className="ui-continue-cloud" data-state={read.state}>
        <p className="ui-continue-cloud-where">
          <span className="ui-continue-cloud-branch">{branch}</span>
          {pr ? ` · pull request #${pr}` : ""}
          {where && computers.length <= 1 && (
            <>
              {" "}
              to <strong>{where}</strong>
            </>
          )}
        </p>
        {read.state === "checking" && (
          <p className="ui-continue-cloud-checking">
            <AsciiSpinner /> Checking this workspace and your team’s cloud computers…
          </p>
        )}
        {read.state === "refused" && (
          <Alert>
            <AlertDescription>{read.why}</AlertDescription>
          </Alert>
        )}
        {ready && plan && (
          <>
            {computers.length > 1 && (
              <Select
                aria-label="Cloud computer"
                value={computer?.placeId ?? ""}
                onChange={setPlaceId}
                options={computers.map((c) => ({ value: c.placeId, label: c.name }))}
              />
            )}
            {plan.ok ? (
              <ul className="ui-continue-cloud-lines">
                {handoffLines(plan).map((line) => (
                  <li key={line}>{line}</li>
                ))}
                {said === 0 && <li>There’s no Aura chat in this workspace to bring. A terminal agent’s own session stays on this laptop.</li>}
                {to?.kind === "computer" && <li>The computer answers from then on, so this laptop can close.</li>}
              </ul>
            ) : (
              <Alert>
                <AlertDescription>{plan.why}</AlertDescription>
              </Alert>
            )}
            {ready.facts.uncommitted > 0 && (
              <label className="ui-check-label">
                <Checkbox checked={carry} onCheckedChange={(v) => setCarry(v === true)} />
                Bring my uncommitted changes, saved in a commit on {branch}
              </label>
            )}
            {said > 0 && (
              <label className="ui-check-label">
                <Checkbox checked={bring} onCheckedChange={(v) => setBring(v === true)} />
                Bring a copy of the last {Math.min(said, 12)} {said === 1 ? "message" : "messages"} as the cloud chat’s opening note
              </label>
            )}
            <Textarea
              value={next}
              onChange={(e) => setNext(e.target.value)}
              rows={3}
              aria-label="What should happen next"
              placeholder="What next? e.g. fix the test the review flagged"
            />
            <label className="ui-check-label">
              <Checkbox checked={onlyInvited} onCheckedChange={(v) => setOnlyInvited(v === true)} />
              Only me and people I invite can open it
            </label>
            {!isMain && (
              <label className="ui-check-label">
                <Checkbox checked={archiveHere} onCheckedChange={(v) => setArchiveHere(v === true)} />
                Archive this workspace here once it’s moved
              </label>
            )}
            {to?.kind === "machine" && loaded && !models.length && (
              <div className="ui-continue-cloud-agent">
                <span>Connect an agent for the cloud first.</span>
                <SetUpCloudAgentButton />
              </div>
            )}
            {to?.kind === "machine" && models.length > 0 && !engine && (
              <p className="ui-continue-cloud-help">The chosen agent can’t run on a machine yet. Connect Claude or Codex for the cloud.</p>
            )}
          </>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
