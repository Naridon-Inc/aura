// Who is in a cloud workspace, in its header: the share popover (who may
// open it) and the people who have it open now. Follow is in the header's
// actions beside them, read from `useWorkspaceAccess` here. Used by every
// cloud workspace screen, so a workspace reads the same whichever chat it
// runs.
//
// A face opens a small card about that person, anchored on the face: here
// or not, their access, and Mention. It never navigates; filtering Home by a
// person belongs to the sidebar's team list, not to a workspace.

import { useCallback, useEffect, useMemo, useState } from "react";

import { setCloudNotice } from "../../lib/cloudPlace";
import { cloudTeamApi, type WorkspaceAccessDto } from "../../lib/cloudTeamApi";
import { cloudProblem } from "../../lib/cloudWorkspacesApi";
import { WorkspaceShare, type WorkspaceAccess } from "../ui/cloud-sharing";
import { CloudPersonCard } from "../ui/cloud-person-card";
import { CollaboratorPresence, type CloudMember } from "../ui/cloud-workspace";
import { viewKey } from "./cloudPlaceKeep";
import { useKeptView } from "./useKeptView";
import {
  grantsOf,
  newlyGranted,
  notOnProjectUser,
  personCardOf,
  serverSentence,
  shareValueOf,
  viewersOf,
} from "./cloudPeople";
import { setFollowing, useCloudFollowing, useCloudPresence } from "./cloudTeamStore";

/** Someone else may change who has access; read it again this often. */
const ACCESS_EVERY_MS = 60_000;

export type WorkspaceAccessState = {
  /** As the server holds it, or null until read (or when it can't be). */
  access: WorkspaceAccessDto | null;
  saving: boolean;
  saveError: string | null;
  save: (value: WorkspaceAccess) => void;
  /**
   * The member a share was just refused for because they aren't on the
   * workspace's project, while you may add them (you manage it and its
   * project is known). Null otherwise.
   */
  notOnProject: string | null;
  /** Put the people being shared with on the project, then save again. */
  addToProjectAndSave: () => void;
  following: boolean;
  followBusy: boolean;
  toggleFollow: () => void;
};

function sayFailure(e: unknown): string {
  return serverSentence(e) ?? cloudProblem(e).message;
}

/**
 * How many refusals one "add to the project and share" walks through: the
 * server names one missing member per refusal, so sharing with several new
 * people at once takes a round each. Bounded so a server that keeps refusing
 * can't loop.
 */
const MAX_PROJECT_ADDS = 20;

/** One workspace's access and your follow, kept fresh while it is open and
 *  kept for the window, so the header has them at once when it opens again. */
export function useWorkspaceAccess(id: string, repoId?: string | null): WorkspaceAccessState {
  const [access, keepAccess] = useKeptView<WorkspaceAccessDto | null>(viewKey("access", id), null);
  const setAccess = useCallback(
    (next: WorkspaceAccessDto | null | ((a: WorkspaceAccessDto | null) => WorkspaceAccessDto | null)) =>
      keepAccess((a) => (typeof next === "function" ? next(a) : next)),
    [keepAccess],
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The share the server refused, and who it named, until it saves or the
  // workspace changes.
  const [refused, setRefused] = useState<{ value: WorkspaceAccess; userId: string } | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const followed = useCloudFollowing();

  useEffect(() => {
    let live = true;
    setSaveError(null);
    setRefused(null);
    const read = () =>
      cloudTeamApi
        .access(id)
        .then((a) => {
          if (live) setAccess(a);
        })
        // A server without sharing yet: the header simply doesn't offer it.
        .catch(() => {});
    void read();
    const t = setInterval(() => void read(), ACCESS_EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id, setAccess]);

  const saved = useCallback((a: WorkspaceAccessDto) => {
    setAccess(a);
    setRefused(null);
    setCloudNotice(
      a.general === "restricted"
        ? "Only the people with access can open this workspace now."
        : "Everyone on the project can open this workspace now.",
    );
  }, [setAccess]);

  const failed = useCallback((e: unknown, value: WorkspaceAccess) => {
    setSaveError(sayFailure(e));
    const userId = notOnProjectUser(e);
    setRefused(userId ? { value, userId } : null);
  }, []);

  const save = useCallback(
    (value: WorkspaceAccess) => {
      setSaving(true);
      setSaveError(null);
      setRefused(null);
      cloudTeamApi
        .setAccess(id, value.general, grantsOf(value))
        .then(saved)
        .catch((e) => failed(e, value))
        .finally(() => setSaving(false));
    },
    [id, saved, failed],
  );

  // Only the people this share adds are ever put on the project, one per
  // refusal the server names. Granting someone the project already holds
  // would rewrite their role there, so nobody else is touched.
  const heldGrants = access?.grants;
  const addToProjectAndSave = useCallback(() => {
    if (!refused || !repoId) return;
    const { value } = refused;
    const adding = new Set(newlyGranted(heldGrants ?? [], grantsOf(value)));
    setSaving(true);
    setSaveError(null);
    void (async () => {
      let userId: string | null = refused.userId;
      try {
        for (let round = 0; userId && round < MAX_PROJECT_ADDS; round++) {
          if (!adding.has(userId)) break;
          adding.delete(userId);
          await cloudTeamApi.addToProject(repoId, userId);
          try {
            saved(await cloudTeamApi.setAccess(id, value.general, grantsOf(value)));
            return;
          } catch (e) {
            userId = notOnProjectUser(e);
            if (!userId || !adding.has(userId)) {
              failed(e, value);
              return;
            }
          }
        }
        setSaveError("The cloud still wouldn\u2019t share it. Try again in a moment.");
      } catch (e) {
        setSaveError(sayFailure(e));
        setRefused(null);
      } finally {
        setSaving(false);
      }
    })();
  }, [refused, repoId, heldGrants, id, saved, failed]);

  const canAdd = !!repoId && !!access?.can_manage;
  const notOnProject = canAdd && refused ? refused.userId : null;

  const following = access?.following ?? followed.includes(id);
  const toggleFollow = useCallback(() => {
    setFollowBusy(true);
    cloudTeamApi
      .follow(id, !following)
      .then((r) => {
        setFollowing(id, r.following);
        setAccess((a) => (a ? { ...a, following: r.following } : a));
      })
      .catch((e) => setCloudNotice(sayFailure(e)))
      .finally(() => setFollowBusy(false));
  }, [id, following, setAccess]);

  return {
    access,
    saving,
    saveError,
    save,
    notOnProject,
    addToProjectAndSave,
    following,
    followBusy,
    toggleFollow,
  };
}

/** A member's name for a sentence, or a plain word when the team doesn't hold them. */
function nameOf(members: CloudMember[], id: string): string {
  return members.find((m) => m.id === id)?.name || "them";
}

export function CloudWorkspacePeople({
  workspaceId,
  members,
  me,
  owner,
  orgName,
  access,
  onCopyLink,
  logins,
  onMention,
  mentionBlocked,
}: {
  /** The workspace's id on the server. */
  workspaceId: string;
  members: CloudMember[];
  me: string | null;
  /** The member who opened it, when they are in the team. */
  owner: string | null | undefined;
  orgName: string;
  access: WorkspaceAccessState;
  onCopyLink?: () => void;
  /** Member id → GitHub login: what a mention names. */
  logins: Record<string, string>;
  /** Puts an "@login " in this workspace's message box. */
  onMention?: (insert: string) => void;
  /** Why you can't send here right now, said in place of Mention. */
  mentionBlocked?: string | null;
}) {
  const presence = useCloudPresence();
  const shown = useMemo(
    () => viewersOf(presence, workspaceId, members, me, owner),
    [presence, workspaceId, members, me, owner],
  );
  const dto = access.access;
  const value = useMemo(() => (dto ? shareValueOf(dto) : null), [dto]);
  // The opener always has it; offering to add them would say otherwise.
  const addable = useMemo(
    () => members.filter((m) => m.id !== (dto?.owner_id ?? owner)),
    [members, dto?.owner_id, owner],
  );
  // In the order the workspace header reads: who may open it, then who is
  // here. Follow sits with the workspace's other actions, after both.
  return (
    <>
      {dto && value && (
        <WorkspaceShare
          value={value}
          members={addable}
          onSave={access.save}
          onCopyLink={onCopyLink}
          orgName={orgName}
          readOnly={!dto.can_manage}
          error={access.saveError}
          errorAction={
            access.notOnProject
              ? {
                  label: `Add ${nameOf(members, access.notOnProject)} to the project and share`,
                  onClick: access.addToProjectAndSave,
                }
              : undefined
          }
          saving={access.saving}
        />
      )}
      <CollaboratorPresence
        members={shown}
        card={(m) => {
          const c = personCardOf(m, presence, workspaceId, dto, me, logins[m.id], Date.now());
          return (
            <CloudPersonCard
              member={m.id === me ? { ...m, name: `${m.name} (you)` } : m}
              status={c.status}
              here={c.here}
              access={c.access}
              mention={c.mention}
              onMention={onMention}
              mentionBlocked={mentionBlocked}
            />
          );
        }}
      />
    </>
  );
}
