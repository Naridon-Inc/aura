// A workspace no computer runs: said plainly, with the way to fix it.
//
// Nothing answers a workspace with no computer under it, so its messages only
// reach the people in it. When the team has a computer on its board, "Run on
// <computer>" hands it the workspace: from then on it answers every member's
// message by itself, on the Claude of whoever started the workspace, with no
// laptop open.
//
// The org's own Aura computer is offered the same way while it sleeps: the
// next message after the hand-over wakes it.
//
// A team whose only computers are ones this laptop reaches over its own link
// gets the older way: the project is put on that computer if it isn't there
// yet, the chat starts there with your own sign-in, and the agent is handed
// the messages of yours nobody answered. You then drive that chat.

import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import { boxChat, branchFor, engineFor, holdFirstPrompt, takeFirstPrompt } from "../../lib/cloudBoxChat";
import {
  pickComputer,
  placeChat,
  readinessNote,
  unansweredMine,
  type ChatComputer,
} from "../../lib/cloudChatPlace";
import { setCloudNotice } from "../../lib/cloudPlace";
import type { CloudMessageRow, CloudWorkspaceRow } from "../../lib/cloudWorkspacesApi";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { addressedTo, type Authored } from "./cloudPeople";
import { reloadCloudPlace } from "./cloudPlaceStore";
import { useCloudModels } from "./cloudModels";
import { HandToComputer, handOverLine, useBoxComputers } from "./CloudBoxDrive";
import { fixReadiness, useChatReadiness } from "./useChatReadiness";

export const NO_COMPUTER_LINE =
  "No computer is running this workspace, so no agent answers here. Messages reach the people in it.";

export function CloudRunOnComputer({
  row,
  repositoryFullName,
  messages,
  me,
  owner,
  runsOn,
  logins,
  authorName,
  people,
  canRun,
}: {
  row: CloudWorkspaceRow;
  repositoryFullName: string | null;
  messages: readonly (CloudMessageRow & Authored)[] | null;
  me: string | null;
  owner: string | undefined;
  /** Whose Claude the computer will answer on: whoever started the workspace. */
  runsOn: string;
  logins: Record<string, string>;
  /** How you are shown on the turns you send. */
  authorName: string | null;
  /** Your teammates' logins, who a message can be addressed to. */
  people: readonly string[];
  /** You can write here; someone who can only read can't start its chat. */
  canRun: boolean;
}) {
  const { models, loaded } = useCloudModels();
  const repo = repositoryFullName?.trim() || null;
  // A computer that answers by itself first; the laptop-driven way is only
  // asked about when the team has none.
  const box = useBoxComputers(canRun && !!repo);
  const offerBox = !!box && box.length > 0;
  const [handing, setHanding] = useState<{ busy: string } | { error: string } | null>(null);
  const readiness = useChatReadiness(canRun && !!repo && loaded && box !== null && !offerBox, models.length > 0);
  const [computer, setComputer] = useState<ChatComputer | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The computer the button names: the one that has the project, else the first.
  useEffect(() => {
    if (readiness?.kind !== "ready" || !repo) {
      setComputer(null);
      return;
    }
    let live = true;
    void pickComputer(readiness.computers, repo, (id) => api.boxProjects(id)).then((c) => live && setComputer(c));
    return () => {
      live = false;
    };
  }, [readiness, repo]);

  const run = async () => {
    if (readiness?.kind !== "ready" || !repo || !computer || step) return;
    const engine = engineFor(models, row.model ?? "");
    if (!engine) {
      setError("Your agent can’t run on a cloud computer yet. Set up Claude or Codex.");
      return;
    }
    setError(null);
    const open = unansweredMine(messages ?? [], me, owner ?? null, (body) => !!addressedTo(body, logins));
    try {
      // The chosen computer first, so the button does what it said.
      const others = readiness.computers.filter((c) => c.machineId !== computer.machineId);
      const target = await placeChat([computer, ...others], repo, setStep);
      setStep(`Starting the chat on ${target.machineName}…`);
      if (open) holdFirstPrompt(localStorage, row.id, open.text, open.ids);
      await boxChat.open({
        workspaceId: row.id,
        machineId: target.machineId,
        placeId: target.placeId,
        project: target.project,
        branch: branchFor(row.objective ?? "workspace", row.id),
        engine,
        authorName,
        people: [...people],
        onLog: open?.text ?? null,
      });
      setCloudNotice(`This workspace now runs on ${target.machineName}.`);
      await reloadCloudPlace();
    } catch (e) {
      takeFirstPrompt(localStorage, row.id);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStep(null);
    }
  };

  // The org's Aura computer while it sleeps: off the board's live list, but
  // handed the workspace all the same; the next message wakes it.
  const handTo = offerBox
    ? box
    : readiness?.kind === "answers-itself"
      ? [{ placeId: readiness.placeId, name: readiness.name }]
      : null;
  if (handTo) {
    return (
      <div className="ui-cloud-session-banner ui-cloud-run-banner" role="status">
        <span>
          {NO_COMPUTER_LINE}
          {handing && "error" in handing ? (
            <em data-tone="error">{handing.error}</em>
          ) : (
            <em>{handing?.busy ?? handOverLine(handTo, runsOn)}</em>
          )}
        </span>
        <HandToComputer workspaceId={row.id} branch={row.branch} computers={handTo} onStep={setHanding} />
      </div>
    );
  }

  const note = readiness ? readinessNote(readiness) : null;
  return (
    <div className="ui-cloud-session-banner ui-cloud-run-banner" role="status">
      <span>
        {NO_COMPUTER_LINE}
        {step ? <em>{step}</em> : error ? <em data-tone="error">{error}</em> : canRun && note ? <em>{note.message}</em> : null}
      </span>
      {canRun && repo && computer && !note ? (
        <Button size="sm" variant="secondary" disabled={!!step} onClick={() => void run()}>
          {step ? <AsciiSpinner size={10} /> : null}
          {`Run on ${computer.machineName}`}
        </Button>
      ) : canRun && note?.fix && note.label ? (
        <Button size="sm" variant="secondary" onClick={() => fixReadiness(note.fix)}>
          {note.label}
        </Button>
      ) : null}
    </div>
  );
}
