// Create, for the cloud: the library dialog over the public workspaces API.
//
// What the server can't take — attached files, an issue to start from — isn't
// offered. Private is: the server writes the workspace and its "only people
// invited" rule in one go.
//
// An open pull request is: the workspace is made on the pull request's own
// branch and titled from it, and the computer checks GitHub's copy of that
// branch out instead of starting one, so the agent's pushes land on the same
// pull request and the workspace's pull request panel shows it.
//
// A workspace's chat runs on one of the org's cloud computers: the agent works
// in a fresh worktree there and the prompt is its first message. Nothing else
// answers a workspace, so one is never made without that. The org's own Aura
// computer needs nothing from this laptop: the server gives it the workspace
// as it's made, and it answers the prompt on your sign-in. With no computer, or
// no agent of yours set up, the dialog says which and offers the one thing
// that fixes it. A computer without the project is given it first.
//
// Pushes and pull requests from the workspace go out as the member, with the
// GitHub they connected in Settings → Git → Your GitHub, so only repositories
// that GitHub can open are offered. Nothing connected says so and connects
// right here, so whatever was typed stays.

import { useState } from "react";

import {
  boxChat,
  branchFor,
  engineFor,
  holdFirstPrompt,
  takeFirstPrompt,
} from "../../lib/cloudBoxChat";
import { stoppedComputerAt } from "../../lib/auraComputer";
import { handToComputer, isBoxDriven } from "../../lib/cloudBoxDrive";
import { chatReadiness, placeChat, readinessNote } from "../../lib/cloudChatPlace";
import { objectiveFor } from "../../lib/continueInCloud";
import { githubBlock, reachableRepos, startableRepos } from "../../lib/cloudMyGithub";
import { cloudApi, cloudProblem } from "../../lib/cloudWorkspacesApi";
import { useAuraComputer } from "../../lib/useAuraComputer";
import {
  openCloudWorkspace,
  setCloudCreating,
  setCloudNotice,
  useCloudPlace,
} from "../../lib/cloudPlace";
import { CloudWorkspaceCreateDialog } from "../ui/cloud-workspace-create";
import { reloadCloudPlace, valueOf, type CloudPlaceData } from "./cloudPlaceStore";
import { meAmong } from "./cloudPeople";
import { PUBLIC_ROW_PREFIX } from "./cloudRows";
import { useCloudModels } from "./cloudModels";
import { SetUpCloudAgentButton } from "./CloudAgentsHost";
import { cloudRepoPicture } from "./CloudRepoAvatar";
import { fixReadiness, useChatReadiness } from "./useChatReadiness";
import { pullStartIntent, readPullStarts } from "./cloudPullStarts";
import { useMyGithubConnect } from "./useMyGithubConnect";
import { useMyGithubRepos } from "./useMyGithubRepos";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function titleOf(prompt: string): string {
  const line = prompt.split("\n")[0].trim();
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

/** `web`: opened in a browser, where a chat can only start on the org's Aura
 *  computer — nothing here reaches any other. */
export function CloudCreateDialog({ data, web = false }: { data: CloudPlaceData; web?: boolean }) {
  const place = useCloudPlace();
  const { models, model, loaded } = useCloudModels();
  const [step, setStep] = useState<string | null>(null);
  // Connecting happens here, so whatever was typed stays; a connect reads
  // the repositories again.
  const [asked, setAsked] = useState(0);
  const mine = useMyGithubRepos(place.creating, asked);
  const myGithub = useMyGithubConnect(() => setAsked((n) => n + 1));
  const { status: computerStatus } = useAuraComputer();
  const reach = reachableRepos(valueOf(data.repos, []).map((r) => r.full_name), mine);
  const names = reach.names;
  const github = githubBlock(mine, reach);
  const members = valueOf(data.members, []);
  const myId = meAmong(members, data.userId, data.login);
  const you = members.find((m) => m.user_id === myId);
  const authorName = you ? you.display_name || you.github_login : null;
  const teammates = members.filter((m) => m.user_id !== myId && m.github_login).map((m) => m.github_login);
  const readiness = useChatReadiness(place.creating && loaded, models.length > 0, web);
  const start = startableRepos(names, readiness?.kind === "answers-itself");
  const repositories = place.defaultRepo && start.names.includes(place.defaultRepo)
    ? [place.defaultRepo, ...start.names.filter((n) => n !== place.defaultRepo)]
    : start.names;
  const note = readiness ? readinessNote(readiness) : null;
  const blocked = note
    ? {
        message: note.message,
        action: note.fix && note.label ? { label: note.label, onClick: () => fixReadiness(note.fix) } : undefined,
      }
    : github
      ? {
          message: myGithub.error ?? github,
          action: mine?.connected ? undefined : { label: myGithub.label, onClick: myGithub.connect },
        }
      : !repositories.length && (readiness?.kind === "ready" || readiness?.kind === "answers-itself")
      ? {
          message: start.offGithub
            ? `${readiness.kind === "answers-itself" ? readiness.name : "The computer"} opens projects from GitHub, and none of this organization’s repositories are on GitHub yet. Add one that is.`
            : "Add a repository first, so the agent has a project to work in.",
          action: { label: "Add a repository", onClick: () => fixReadiness("computer") },
        }
      : null;
  return (
    <CloudWorkspaceCreateDialog
      open={place.creating}
      onOpenChange={setCloudCreating}
      repositories={repositories}
      models={models}
      model={model}
      // The note above already offers "Set up an agent"; one button for it.
      noModels={note?.fix === "agent" ? null : <SetUpCloudAgentButton />}
      orgName={data.orgName || "your organization"}
      branches={[]}
      startingPoints={false}
      contextMenu={false}
      fallbackRepository=""
      repositoryIcon={(full) => cloudRepoPicture(full, 14)}
      onManageRepositories={() => fixReadiness("computer")}
      blocked={blocked}
      step={step}
      pullRequests={readPullStarts}
      onCreate={async (draft) => {
        const pr = draft.pullRequest;
        const objective = pr ? objectiveFor(pr.title, pr.branch, pr.number) : titleOf(draft.prompt);
        const repo = draft.repository.trim();
        const model = draft.model.model || null;
        const engine = engineFor(models, draft.model.model);
        if (!repo) throw new Error("Pick the repository the agent works in.");
        if (!engine) throw new Error("That agent can’t run on a cloud computer yet. Pick a Claude or Codex model.");
        // Asked again: the board may have changed since the dialog opened.
        const now = await chatReadiness(models.length > 0, web);
        if (now.kind === "answers-itself") {
          // The org's Aura computer is given the workspace as it's made and
          // answers the prompt itself, waking first if it's asleep. Nothing
          // here reaches it. A pull request's start is first pointed at that
          // pull request's branch, so the agent's pushes land on it; only then
          // is the prompt sent, so the computer never starts it elsewhere.
          let row;
          try {
            setStep(`Starting the chat on ${now.name}…`);
            row = await cloudApi.createWorkspace({
              objective,
              repo,
              branch: pr?.branch ?? null,
              intent: pr ? pullStartIntent(pr) : null,
              prompt: pr ? null : draft.prompt,
              model,
              access: draft.access,
            });
          } catch (e) {
            setStep(null);
            throw new Error(cloudProblem(e).message);
          }
          let problem: string | null = null;
          if (pr && isBoxDriven(row)) {
            try {
              await handToComputer(row.id, { placeId: now.placeId, name: now.name }, pr.branch, engine);
              await cloudApi.prompt(row.id, draft.prompt, model);
            } catch (e) {
              problem = errorText(e);
            }
          } else if (pr) {
            // Nothing took it: the prompt still goes on its log, for people.
            await cloudApi.prompt(row.id, draft.prompt, model).catch(() => undefined);
          }
          setStep(null);
          setCloudNotice(
            problem
              ? `Workspace created, but ${now.name} couldn’t start on ${pr?.branch}: ${problem}`
              : isBoxDriven(row) && stoppedComputerAt(computerStatus, now.placeId)
                ? `Workspace created. ${now.name} can’t wake until its payment goes through; pay again in Billing and it answers.`
                : isBoxDriven(row)
                ? `Workspace created. ${now.name} answers it; the first reply can take a few minutes while it wakes.`
                : `Workspace created, but ${now.name} didn’t take it, so nothing answers it yet.`,
          );
          await reloadCloudPlace();
          openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${row.id}`);
          return;
        }
        if (now.kind !== "ready") throw new Error(readinessNote(now)?.message ?? "No cloud computer can run this.");
        let target;
        try {
          target = await placeChat(now.computers, repo, setStep);
        } finally {
          setStep(null);
        }
        let row;
        try {
          setStep(`Starting the chat on ${target.machineName}…`);
          // The prompt is the chat's first message, not a task queued on the row.
          row = await cloudApi.createWorkspace({
            objective,
            repo,
            branch: pr?.branch ?? null,
            intent: pr ? pullStartIntent(pr) : null,
            prompt: null,
            model,
            access: draft.access,
          });
        } catch (e) {
          setStep(null);
          throw new Error(cloudProblem(e).message);
        }
        holdFirstPrompt(localStorage, row.id, draft.prompt);
        try {
          await boxChat.open({
            workspaceId: row.id,
            machineId: target.machineId,
            placeId: target.placeId,
            project: target.project,
            branch: pr ? pr.branch : branchFor(objective, row.id),
            // GitHub's copy of the pull request's branch, not a new one.
            continueBranch: !!pr,
            engine,
            authorName,
            people: teammates,
          });
        } catch (e) {
          // The workspace exists now. Its prompt goes onto its log, where the
          // workspace offers to run it on the computer again.
          const first = takeFirstPrompt(localStorage, row.id);
          if (first) await cloudApi.prompt(row.id, first, model).catch(() => undefined);
          setCloudNotice(`Workspace created, but its chat didn’t start on ${target.machineName}: ${errorText(e)}`);
          await reloadCloudPlace();
          openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${row.id}`);
          return;
        } finally {
          setStep(null);
        }
        setCloudNotice(`Workspace created. The chat runs on ${target.machineName}.`);
        await reloadCloudPlace();
        openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${row.id}`);
      }}
    />
  );
}
