// Who else is in a cloud workspace — sharing, following, @mentions and
// presence — through the desktop's proxy, the same way `cloudWorkspacesApi`
// reaches the cloud's own routes. Failures read through `cloudProblem`.

import { invoke } from "@tauri-apps/api/core";

/** One teammate the server has heard from in the last minute and a half. */
export type PresenceEntry = {
  user_id: string;
  /** `active` while they are using the app; `idle` after a quarter hour away. */
  state: "active" | "idle";
  typing: boolean;
  /** The cloud workspace they have open — only ever one you can open too. */
  viewing_workspace_id: string | null;
  last_seen_at: string;
  last_active_at: string;
};

/** `read` or `write` — what a person invited to a workspace may do there. */
export type AccessLevel = "read" | "write";

export type AccessGrant = { user_id: string; level: AccessLevel };

/** Who may open one workspace, as the server holds it. */
export type WorkspaceAccessDto = {
  workspace_id: string;
  /** `organization`: everyone in the project. `restricted`: only those invited. */
  general: "organization" | "restricted";
  grants: AccessGrant[];
  followers: { user_id: string; reason: string; since: string }[];
  owner_id: string | null;
  /** You may change who has access: you opened it, or you run the org. */
  can_manage: boolean;
  following: boolean;
  your_access: "read" | "write" | "none";
};

/** A turn that named you, in a workspace you could open when it was sent. */
export type MentionRow = {
  id: string;
  workspace_id: string | null;
  workspace_title: string | null;
  by_user_id: string | null;
  excerpt: string;
  created_at: string;
  read_at: string | null;
  /** What brought it: an @mention in a message (absent on rows from before
   *  comments), or a comment — an @mention in one, a reply in a thread you
   *  are in, or a comment on your message. */
  kind?: "mention" | "reply" | "comment" | string | null;
  /** The comment it came from, for the kinds a comment brings. */
  comment_id?: string | null;
  /** The turn that comment is on; null for a comment on the workspace. */
  anchor_message_id?: string | null;
};

export const cloudTeamApi = {
  beacon: (viewing: string | null, typing: boolean, idleMs: number) =>
    invoke<unknown>("cloud_presence_beacon", {
      viewing,
      typing,
      idleMs: Math.max(0, Math.floor(idleMs)),
    }),
  presence: () => invoke<PresenceEntry[]>("cloud_presence_list"),
  access: (id: string) => invoke<WorkspaceAccessDto>("cloud_workspace_access", { id }),
  /** Put an org member on a project, so its workspaces can be shared with them. Owners and admins only. */
  addToProject: (repoId: string, userId: string) =>
    invoke<void>("cloud_repo_member_add", { repoId, userId }),
  setAccess: (id: string, general: WorkspaceAccessDto["general"], grants: AccessGrant[]) =>
    invoke<WorkspaceAccessDto>("cloud_workspace_access_set", { id, general, grants }),
  follow: (id: string, follow: boolean) =>
    invoke<{ workspace_id: string; following: boolean }>("cloud_workspace_follow", { id, follow }),
  following: () => invoke<string[]>("cloud_following"),
  mentions: (unread: boolean, limit?: number) =>
    invoke<MentionRow[]>("cloud_mentions", { unread, limit: limit ?? null }),
  markMentionsRead: (ids: string[]) => invoke<{ marked: number }>("cloud_mentions_read", { ids }),
  /** Hand a workspace to another member. Its owner or an org admin only, to
   *  someone who can already open its project. */
  reassign: (id: string, userId: string) =>
    invoke<unknown>("cloud_workspace_reassign", { id, userId }),
};
