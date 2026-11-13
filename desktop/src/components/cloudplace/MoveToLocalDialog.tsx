// Move to this computer: bring a cloud workspace's branch into a worktree of
// the matching project here, its conversation into an Aura chat here, and
// tell the cloud workspace it moved, so its computer stops answering it.
//
// The dialog reads before it offers: whether the workspace can move now, and
// which project on this computer it comes into. A project this computer
// doesn't have yet can be cloned first, into a folder the person picks. The
// work itself is `moveToLocal` (lib/moveToLocal.ts).

import { useEffect, useState } from "react";

import { Dialog } from "../Dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { boxChat } from "../../lib/cloudBoxChat";
import { leaveCloud, setCloudNotice } from "../../lib/cloudPlace";
import { cloudApi, cloudProblem, type CloudMessageRow, type CloudWorkspaceRow } from "../../lib/cloudWorkspacesApi";
import { forgetMovedToCloud } from "../../lib/movedToCloud";
import { findLocalProject, localTurns, moveToLocal, planMoveToLocal } from "../../lib/moveToLocal";
import { pickPath } from "../../lib/nativeDialog";
import { basename } from "../../lib/paths";
import { readRecents } from "../../lib/recentProjects";
import { addressedTo } from "./cloudPeople";
import { reloadCloudPlace } from "./cloudPlaceStore";
import "../ui/continue-in-cloud.css";

/** The brain the computer's answers are marked with in the chat here: it
 *  ran Claude. */
const CLOUD_BRAIN = "anthropic_native";

type Where = { state: "checking" } | { state: "here"; root: string } | { state: "missing" };

type Props = {
  row: CloudWorkspaceRow;
  title: string;
  /** `owner/name` on GitHub. */
  repositoryFullName: string | null;
  messages: CloudMessageRow[] | null;
  /** Your own member id. */
  me: string | null;
  /** Your name as the team sees it. */
  myName: string | null;
  /** Member id → GitHub login, to tell a message to teammates from a prompt. */
  logins: Record<string, string>;
  onClose: () => void;
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function MoveToLocalDialog({ row, title, repositoryFullName, messages, me, myName, logins, onClose }: Props) {
  const plan = planMoveToLocal(row, repositoryFullName, messages, (m) => !!addressedTo(m.body, logins));
  const [where, setWhere] = useState<Where>({ state: "checking" });
  const [cloneInto, setCloneInto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repo = plan.ok ? plan.repo : null;

  useEffect(() => {
    if (!repo) return;
    let live = true;
    void findLocalProject(repo, readRecents(), (root) => api.gitRemoteOrigin(root)).then(
      (root) => live && setWhere(root ? { state: "here", root } : { state: "missing" }),
    );
    return () => {
      live = false;
    };
  }, [repo]);

  const turns = localTurns(messages ?? [], me);
  const from = row.place?.machine || "the cloud";
  const canGo = plan.ok && !busy && (where.state === "here" || (where.state === "missing" && !!cloneInto));

  async function chooseFolder() {
    const picked = await pickPath({ directory: true, title: `Where should ${repo} go on this computer?` }).catch(() => null);
    if (typeof picked === "string" && picked) setCloneInto(picked);
  }

  async function go() {
    if (!plan.ok || !canGo) return;
    setBusy(true);
    setError(null);
    try {
      let root = where.state === "here" ? where.root : null;
      if (!root && cloneInto) {
        try {
          root = (await api.gitClone(`https://github.com/${plan.repo}.git`, cloneInto, plan.repo.split("/")[1])).root;
        } catch (e) {
          throw new Error(`Couldn’t clone ${plan.repo} into ${cloneInto}, so nothing was moved: ${errorText(e)}`);
        }
      }
      if (!root) return;
      const out = await moveToLocal(
        {
          workspaceId: row.id,
          branch: plan.branch,
          title,
          projectRoot: root,
          computer: myName ? `${myName}’s computer` : null,
          from,
          turns,
        },
        {
          bring: (r, b) => api.worktreeBring(r, b),
          markMoved: (id, moved) => cloudApi.markMoved(id, moved).catch((e) => Promise.reject(new Error(cloudProblem(e).message))),
          startChat: (path, t) => api.managerChatStart(path, t),
          backfill: (sid, t) => boxChat.backfill(sid, t, null, CLOUD_BRAIN),
          note: (sid, text) => api.managerAppendChat(sid, "system", text),
          forgetMoved: (path) => forgetMovedToCloud(path),
        },
      );
      void reloadCloudPlace();
      onClose();
      leaveCloud();
      // The roster learns the project and worktree, switches into it and
      // opens the chat the conversation came into.
      window.dispatchEvent(
        new CustomEvent("aura:workspace-launched", {
          detail: { repoRoot: root, worktreePath: out.path, createMore: false, sessionId: out.sessionId ?? undefined },
        }),
      );
      if (out.warning) setCloudNotice(out.warning);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const project = where.state === "here" ? basename(where.root) : repo?.split("/")[1] ?? "";
  const said = turns.length;

  return (
    <Dialog
      open
      width={500}
      title="Move to this computer"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void go()} disabled={!canGo}>
            {busy ? "Moving…" : "Move to this computer"}
          </Button>
        </>
      }
    >
      <div className="ui-continue-cloud" data-state={plan.ok ? where.state : "refused"}>
        {row.branch && (
          <p className="ui-continue-cloud-where">
            <span className="ui-continue-cloud-branch">{row.branch}</span> from <strong>{from}</strong>
          </p>
        )}
        {!plan.ok && (
          <Alert>
            <AlertDescription>{plan.why}</AlertDescription>
          </Alert>
        )}
        {plan.ok && where.state === "checking" && (
          <p className="ui-continue-cloud-checking">
            <AsciiSpinner /> Looking for {plan.repo} on this computer…
          </p>
        )}
        {plan.ok && where.state !== "checking" && (
          <>
            <ul className="ui-continue-cloud-lines">
              {where.state === "here" ? (
                <li>
                  {plan.branch} comes from GitHub into a workspace of {project} on this computer. A copy already here is
                  moved forward, never over work of its own.
                </li>
              ) : (
                <li>
                  {plan.repo} isn’t on this computer yet. It’s cloned {cloneInto ? <>into {cloneInto}</> : "into a folder you choose"} first, then {plan.branch} comes into a workspace of it.
                </li>
              )}
              <li>
                {said > 0
                  ? `The conversation (${said} ${said === 1 ? "message" : "messages"}) comes into an Aura chat here, which goes on with your own agent.`
                  : "There’s no conversation to bring yet."}
              </li>
              <li>{from === "the cloud" ? "The cloud" : from} stops answering this workspace. Its chat stays here, marked with where the work went.</li>
            </ul>
            {where.state === "missing" && (
              <div className="ui-continue-cloud-agent">
                <span>{cloneInto ? basename(cloneInto) : "No folder chosen"}</span>
                <Button variant="outline" size="sm" onClick={() => void chooseFolder()} disabled={busy}>
                  {cloneInto ? "Change folder…" : "Choose folder…"}
                </Button>
              </div>
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
