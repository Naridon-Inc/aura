// Task-integrations IPC surface — kept in its own module so the
// 4600-line `lib/api.ts` doesn't keep growing. Re-exports the
// connection types the renderer needs to render the settings card
// and (later) wire up sync UI.
//
// The Rust side lives in `src-tauri/src/cmd_integrations.rs`.

import { invoke } from "@tauri-apps/api/core";

export type IntegrationKind = "jira" | "linear";

export type ExternalIdentity = {
  account_id: string;
  display_name: string;
  email?: string | null;
  avatar_url?: string | null;
};

export type CloudSite = {
  cloud_id: string;
  url: string;
  name: string;
  scopes?: string[];
  avatar_url?: string | null;
};

export type MirrorSummary = {
  cloud_id: string;
  project_key: string;
  project_name: string;
  repo_root: string;
  /** Unix-seconds timestamp of the most recent sync. Null until first run. */
  last_synced_at?: number | null;
  last_sync_created?: number;
  last_sync_updated?: number;
  last_sync_errors?: number;
};

export type ConnectionStatus = {
  kind: IntegrationKind;
  connected: boolean;
  /** Whether this machine carries the provider's credentials at all —
   *  i.e. whether `~/.aura/integrations.toml` has its block. A different
   *  question from `connected`, and the card needs both: without it the
   *  only honest thing it can offer is a Connect button that opens
   *  nothing and errors after the click. */
  configured: boolean;
  identity?: ExternalIdentity | null;
  sites?: CloudSite[];
  scopes?: string | null;
  /** Unix-seconds expiry of the cached access token. */
  expires_at?: number | null;
  mirrors?: MirrorSummary[];
  /** When set, the background poller auto-discovers new Jira projects
   *  every 5 min and creates mirrors targeting this repo. */
  auto_mirror_repo_root?: string | null;
};

export type JiraProject = {
  id: string;
  key: string;
  name: string;
  avatar_url?: string | null;
  project_type_key?: string | null;
};

export type SyncOutcome = {
  project_key: string;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  synced_at: number;
};

/** Count-only look at a Beads tracker before importing — drives the
 *  "Found N issues" confirmation. */
export type BeadsPreview = {
  /** Absolute path to the `.jsonl` issue log we'd read. */
  source_path: string;
  total: number;
  open: number;
  closed: number;
  with_dependencies: number;
};

/** One Jira person's link to an Aura teammate, as stored in
 *  `.aura/integrations/jira_user_map.json`. Drives the "People" list in the
 *  Jira settings panel. */
export type JiraUserLink = {
  /** Stable Jira key (accountId, or the display label for legacy sites). */
  account_id: string;
  display_name?: string | null;
  email?: string | null;
  /** The Aura roster handle this Jira person is linked to, when resolved. */
  handle?: string | null;
  status: "resolved" | "unresolved";
  via: "email" | "brain" | "manual" | "none";
  /** Confidence of a brain-proposed match (0–1); absent for email/manual. */
  confidence?: number | null;
  updated_at: number;
};

/** A brain-proposed (or empty) match for one still-unlinked Jira person. */
export type ReconcileSuggestion = {
  account_id: string;
  display_name?: string | null;
  email?: string | null;
  /** Roster handle the brain proposes, or null for "no confident match". */
  suggested_handle?: string | null;
  /** That teammate's display name, for the UI. */
  suggested_name?: string | null;
  confidence: number;
  reason: string;
};

/** Result of confirming a link — how many imported tasks were re-pointed. */
export type LinkApplied = {
  account_id: string;
  handle: string;
  tasks_updated: number;
};

/** Tally of one Beads → board import run. */
export type BeadsImportOutcome = {
  source_path: string;
  parsed: number;
  created: number;
  updated: number;
  skipped: number;
  /** Blocking dependency edges resolved onto Aura blocked-by links. */
  links: number;
  errors: string[];
};

export const integrationsApi = {
  /** Start Jira (Atlassian 3LO) OAuth. Opens the browser, awaits the
   *  callback, exchanges the code, and persists tokens — all in one
   *  call. The renderer just shows a spinner.
   *
   *  The Rust side ALSO emits `aura:integrations:jira:auth_url` with
   *  the authorize URL so the renderer can show a "didn't open?" link. */
  jiraConnect: () => invoke<ConnectionStatus>("integrations_jira_connect"),
  /** Cancel an in-flight Jira OAuth flow. The pending `jiraConnect`
   *  promise rejects with "connect cancelled", the loopback listener
   *  is dropped, and the port is released so a retry can bind it.
   *  Idempotent — calling when no flow is pending is a no-op. */
  jiraCancel: () => invoke<void>("integrations_jira_cancel"),
  /** Return the current Jira connection status. Refreshes the access
   *  token if it's within 30s of expiry. Does not re-fetch identity
   *  or sites — those are cached in `~/.aura/integrations.state.json`. */
  jiraStatus: () => invoke<ConnectionStatus>("integrations_jira_status"),
  /** Wipe Jira tokens + cached state. Idempotent. */
  jiraDisconnect: () => invoke<void>("integrations_jira_disconnect"),
  /** List projects on a Jira cloud site so the renderer can populate
   *  the "Mirror this project" dropdown. Auto-refreshes the access
   *  token if expired. */
  jiraProjects: (cloudId: string) =>
    invoke<JiraProject[]>("integrations_jira_projects", { cloudId }),
  /** Bind a Jira project to a local Aura repo. Repeat calls upsert the
   *  binding in place. Returns the updated connection status so the
   *  UI can swap in the new mirror chip without a follow-up `_status`. */
  jiraMirrorSet: (input: {
    cloudId: string;
    projectKey: string;
    projectName: string;
    repoRoot: string;
  }) => invoke<ConnectionStatus>("integrations_jira_mirror_set", input),
  /** Remove a mirror binding. Idempotent. */
  jiraMirrorUnset: (input: { cloudId: string; projectKey: string }) =>
    invoke<ConnectionStatus>("integrations_jira_mirror_unset", input),
  /** Run a pull-mirror sync now. With no `repoRoot`, every configured
   *  mirror runs; otherwise only mirrors targeting that repo. The
   *  5-min background poller calls the all-mirrors variant internally
   *  and emits `aura:integrations:jira:synced` with the same outcomes. */
  jiraSyncNow: (input?: { repoRoot?: string }) =>
    invoke<SyncOutcome[]>("integrations_jira_sync_now", input ?? {}),
  /** Clear the per-mirror incremental watermark and run a full sweep.
   *  Use after a client upgrade that imports new fields (parent links,
   *  epic flags) or when the mirror has drifted from upstream. The
   *  incremental cache rebuilds itself on the next clean poll. */
  jiraBackfill: (input?: { repoRoot?: string }) =>
    invoke<SyncOutcome[]>("integrations_jira_backfill", input ?? {}),
  /** Turn on auto-mirror — every project on every connected Jira site
   *  gets a mirror pointing at this repo, and the 5-min poller picks up
   *  newly-created projects from upstream. */
  jiraAutoMirrorEnable: (repoRoot: string) =>
    invoke<ConnectionStatus>("integrations_jira_auto_mirror_enable", { repoRoot }),
  /** Turn off auto-mirror. Already-imported projects keep syncing — only
   *  upstream-side new-project discovery stops. */
  jiraAutoMirrorDisable: () =>
    invoke<ConnectionStatus>("integrations_jira_auto_mirror_disable"),

  /** Start Linear OAuth. Same one-call shape as `jiraConnect`: opens the
   *  browser, awaits the loopback callback, exchanges the code, probes
   *  the workspace identity, and persists the token. Emits
   *  `aura:integrations:linear:auth_url` for the "didn't open?" link. */
  linearConnect: () => invoke<ConnectionStatus>("integrations_linear_connect"),
  /** Cancel an in-flight Linear OAuth flow. The pending `linearConnect`
   *  promise rejects with "connect cancelled" and the port is released.
   *  Idempotent. */
  linearCancel: () => invoke<void>("integrations_linear_cancel"),
  /** Current Linear connection status. Linear access tokens are
   *  long-lived and carry no refresh token, so there's no refresh step —
   *  a genuinely expired token simply reports disconnected and the UI
   *  prompts a reconnect. Identity is read from the local state cache. */
  linearStatus: () => invoke<ConnectionStatus>("integrations_linear_status"),
  /** Wipe Linear tokens + cached state. Idempotent. */
  linearDisconnect: () => invoke<void>("integrations_linear_disconnect"),

  /** Snapshot of all integrations for the settings list view. */
  list: () => invoke<ConnectionStatus[]>("integrations_list"),

  /** Count the issues in a local Beads tracker without importing. The
   *  `source` may be a repo folder containing `.beads/`, the `.beads/`
   *  folder itself, or a direct path to a `*.jsonl` issue log. */
  beadsPreview: (source: string) =>
    invoke<BeadsPreview>("integrations_beads_preview", { source }),

  /** Import (or re-import) a Beads tracker's issues into `repoRoot`'s
   *  task board. Re-running updates rows in place instead of duplicating
   *  (keyed on the bead id) and wires the dependency graph onto blocked-by
   *  links. */
  beadsImport: (input: { repoRoot: string; source: string }) =>
    invoke<BeadsImportOutcome>("integrations_beads_import", input),

  /** Every Jira person seen on an import for this repo, unresolved-first,
   *  with their linked teammate handle when known. Backs the "Match people"
   *  list in the Jira settings panel. */
  jiraUsersList: (repoRoot: string) =>
    invoke<JiraUserLink[]>("integrations_jira_users_list", { repoRoot }),

  /** Ask Aura's own brain to propose a teammate for each still-unlinked Jira
   *  person (with a confidence). Conservative — returns "no confident match"
   *  rather than guess. The user confirms each one; nothing merges
   *  automatically. */
  jiraUsersReconcile: (repoRoot: string) =>
    invoke<ReconcileSuggestion[]>("integrations_jira_users_reconcile", {
      repoRoot,
    }),

  /** Confirm a link: bind a Jira account to a teammate's handle and re-point
   *  every already-imported Jira task onto it. Returns how many were updated. */
  jiraUsersLink: (input: {
    repoRoot: string;
    accountId: string;
    handle: string;
  }) => invoke<LinkApplied>("integrations_jira_users_link", input),

  /** Drop a link (it was wrong). The Jira person returns to the unresolved
   *  list; already-imported tasks keep whatever assignee they have. */
  jiraUsersUnlink: (input: { repoRoot: string; accountId: string }) =>
    invoke<void>("integrations_jira_users_unlink", input),
};
