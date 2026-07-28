// Typed wrappers around tauri::invoke. Centralised so we can swap IPC
// transports later (e.g. WebSocket for live mode) without touching every
// component, and so the React side has compile-time guarantees against
// the Rust command signatures.

import { invoke } from "@tauri-apps/api/core";
import { isToolMetadataPath } from "./categorizeChange";
import { roomAuthHeaders } from "./roomAuth";
import type {
  ContributesSummary,
  InstalledExtension,
  OpenVsxHit,
} from "./vscodeExt/vsixTypes";

export type AuraStatus = {
  db_path: string;
  initialized: boolean;
  block_count: number | null;
  schema_version: number | null;
  channel: string;
};

export type StrictModeInfo = {
  /** "off" | "on" | "locked". Locked = passcode set, only a human can disable. */
  mode: "off" | "on" | "locked";
};

export type DirEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  git_status: string | null;
};

export type WorktreeEntry = {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
  locked: boolean;
};

export type BranchDiffFile = {
  path: string;
  /** porcelain status letter from `git diff --name-status` */
  status: string;
  additions: number;
  deletions: number;
};

/** One row in the footer branch switcher (from `git_branches`). */
export type GitBranchInfo = {
  /** Short name: `main`, `feat/x`, or `origin/feat/x` for remotes. */
  name: string;
  is_current: boolean;
  is_remote: boolean;
  /** Short upstream ref when the local branch tracks one. */
  upstream: string | null;
  /** Last commit subject — shown as dropdown context. */
  subject: string | null;
};

/** A richly-detailed branch row for the Cmd-K branch switcher (from
 *  `git_branches_rich`). One `for-each-ref` call fills every field, so the
 *  modal shows per-branch context — author, when it last moved, the subject,
 *  and ahead/behind vs upstream — with no round-trip per branch. */
export type GitBranchRich = {
  /** Short name: `main`, `feat/x`, or `origin/feat/x` for remotes. */
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  /** Short upstream ref (`origin/main`) when the local branch tracks one. */
  upstream: string | null;
  /** Commits ahead of upstream (0 when no upstream). */
  ahead: number;
  /** Commits behind upstream (0 when no upstream). */
  behind: number;
  /** Last-commit author name — who last moved this branch. */
  author: string | null;
  /** Last-commit time, unix seconds — drives the relative "2h ago" label. */
  committedAt: number | null;
  /** Last commit subject — the one-line "what's on this branch". */
  subject: string | null;
};

export type FileContent = {
  path: string;
  text: string;
  size: number;
  language: string;
  /** "ok" | "too_large" | "binary" — non-ok means text is empty. */
  status: string;
};

/** An external code editor Aura can launch a file/folder in. Only installed
 *  editors are returned by `editorsList`, always including a "System default"
 *  entry that defers to the OS file association. Mirrors Rust `EditorInfo`. */
export type EditorInfo = {
  id: string;
  name: string;
  available: boolean;
};

/** A file's bytes as base64 + a guessed media type — what `readFileBase64`
 *  returns. Used to attach an OS-dropped screenshot to the chat. Mirrors the
 *  Rust `FileBase64`. */
export type FileBase64 = {
  path: string;
  name: string;
  media_type: string;
  /** Standard (padded) base64 of the bytes, no `data:` prefix. */
  data_base64: string;
  size: number;
  is_image: boolean;
};

export type RemoteStatus = {
  running: boolean;
  url: string | null;
  pin: string | null;
  clients: number;
};

export type RemoteRelayStatus = {
  running: boolean;
  code: string | null;
  public_url: string | null;
};

export type ClipEntry = {
  id: string;
  /** "image" | "file" — image entries get a thumbnail preview, files
   *  render as a generic document chip with their extension. */
  kind: "image" | "file";
  name: string;
  /** Absolute path on disk under ~/.aura/clips/ — usable as a drag
   *  payload (text/uri-list / text/plain) and as a `convertFileSrc`
   *  source for image previews. */
  path: string;
  created_at: number;
  size: number;
};

// Legacy free-form status union. OO.3 replaces `status` with a
// pointer into the per-repo state catalog (`state_id`); this type
// is kept so older filter/view code keeps compiling while the
// migration is in progress. Cards should prefer the state catalog.
export type TaskStatus = "backlog" | "in_progress" | "in_review" | "done";

// OO.3 canonical state group. Every entry in the state catalog
// belongs to one of these five buckets — they drive column ordering
// on the kanban and the back-compat status mirror on the wire.
export type TaskStateGroup =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "cancelled";

// OO.3 5-stop priority ladder. Replaces the legacy `low | medium |
// high` set. `none` is a real value, not null — Plane and Linear
// both surface it as an explicit pill rather than a missing field.
export type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";

export type LinkedPr = {
  repo: string;
  number: number;
  url: string;
};

// OO.3 — per-repo state catalog. Backend persists this at
// `<repoRoot>/.aura/tasks/task_states.json`; the five default
// states (backlog/unstarted/started/completed/cancelled) are
// seeded on first read. Users may add custom states; each must
// belong to one canonical `group` so ordering + legacy status
// mirroring stay well-defined.
export type TaskState = {
  /** Stable slug ("backlog", "started", "ready-for-qa"). Used as
   *  `Task.state_id` and as the kanban column key. */
  id: string;
  /** Human label rendered in the state pill + column header. */
  name: string;
  /** Canonical bucket — drives ordering + the legacy `status`
   *  mirror. Custom states must pick one of the five buckets. */
  group: TaskStateGroup;
  /** CSS color string ("#94a3b8") used by the pill background. */
  color: string;
  /** Sort key for the kanban columns (smaller renders first).
   *  Defaults seeded at 100/200/300/400/500 so custom states can
   *  slot in between without renumbering. */
  position: number;
  /** True for the five seeded defaults — the UI hides the delete
   *  affordance for these so users don't lock themselves out of
   *  the canonical workflow. */
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type TaskStateInput = {
  id: string;
  name: string;
  group: TaskStateGroup;
  color: string;
  position?: number;
};

// OO.3 — per-repo label catalog. Backend persists this at
// `<repoRoot>/.aura/tasks/task_labels.json`. Legacy `Task.labels`
// strings are auto-imported lazily (lowercase-kebab slug as id)
// so existing tasks surface their chips without manual migration.
export type TaskLabel = {
  /** Stable slug — lowercased kebab-case of `name`. Used as the
   *  foreign key in `Task.label_ids`. */
  id: string;
  /** Human label rendered on the chip. */
  name: string;
  /** CSS color string ("#ef4444"). Auto-imports get a deterministic
   *  palette pick keyed by the slug. */
  color: string;
  created_at: string;
  updated_at: string;
};

export type TaskLabelInput = {
  /** Optional — when omitted, derived from `name`. Pass an existing
   *  id to update in place. */
  id?: string;
  name: string;
  /** Empty string falls back to a palette pick on the backend. */
  color?: string;
};

export type Task = {
  id: string;
  /** Monotonic per-repo number rendered in the UI as `AURA-{n}`.
   *  Defaults to 0 on tasks written before Phase 1 shipped — the
   *  backend heals zeroes on first read, so non-zero is what callers
   *  should see in practice. */
  sequence_id: number;
  title: string;
  description: string;
  /** Legacy free-form status. OO.3 mirrors this from the state
   *  catalog at write time so older readers keep working. New code
   *  should prefer `state_id`. */
  status: TaskStatus;
  /** OO.3 canonical state pointer. References an entry in the
   *  state catalog (`task_states_list`). Empty string on rows
   *  written before OO.3 — the backend heals these on read. */
  state_id: string;
  /** 5-stop priority (`urgent | high | medium | low | none`). The
   *  backend normalises any out-of-range value to `none`. */
  priority: TaskPriority;
  /** Legacy single-assignee. Mirrored from `assignee_ids[0]` so
   *  older readers see the same owner. */
  assignee?: string | null;
  /** OO.3 multi-assignee. List of git handles in display order
   *  (drives the avatar-stack rendering). Empty on rows written
   *  before OO.3 — the backend wraps `assignee` into a single-
   *  element list on read. */
  assignee_ids: string[];
  /** AI agent owner (claude, gemini, codex, ...). Surfaces as a chip
   *  next to the assignee stack. */
  agent_assignee?: string | null;
  reporter?: string | null;
  /** Legacy free-form label strings. OO.3 mirrors this from the
   *  label catalog (`label_ids`) at write time so older readers
   *  keep working. New code should prefer `label_ids`. */
  labels: string[];
  /** OO.3 label-catalog pointers. Empty on rows written before
   *  OO.3 — backend auto-imports each legacy string and rebuilds
   *  this array on read. */
  label_ids: string[];
  linked_pr?: LinkedPr | null;
  linked_message_id?: string | null;
  /** YYYY-MM-DD. Pill on card, sort key for "by due". */
  due_date?: string | null;
  /** YYYY-MM-DD. Gantt bar's left edge; falls back to `created_at`. */
  start_date?: string | null;
  /** Story points or hours — caller's choice. Sprint summing uses it. */
  estimate?: number | null;
  /** Parent task id. Canonical successor to `epic_id`; backend mirrors
   *  the two so older readers keep working. Read code should prefer
   *  `parent_id` and fall back to `epic_id` only if absent. */
  parent_id?: string | null;
  /** Legacy parent-epic field. Kept in sync with `parent_id` by the
   *  backend so the wire shape stays back-compatible. */
  epic_id?: string | null;
  /** True when this task IS an epic (container for child tasks). */
  is_epic?: boolean;
  /** Free-text objective/OKR pointer ("Q3-O1 KR2: ship v0.3.0"). */
  objective?: string | null;
  /** Other task IDs that must finish before this one starts. */
  dependencies?: string[];
  /** Linked A2A bead id — the agent-execution side of this task. */
  bead_id?: string | null;
  /** Sprint / iteration slug ("w20", "may-1", "sprint-7"). */
  sprint?: string | null;
  /** OO.4 — Plane-style Cycle pointer. References an entry in
   *  `tasksCyclesList`. Cleared by the backend heal pass when the
   *  referenced cycle is deleted. */
  cycle_id?: string | null;
  /** OO.4 — Plane-style Module pointer. References an entry in
   *  `tasksModulesList`. Same heal semantics as `cycle_id`. */
  module_id?: string | null;
  /** RFC3339 archive timestamp. Phase-3 archive flow will set this;
   *  Phase 1 just reserves the field. */
  archived_at?: string | null;
  /** QQ.1 — Source-system slug ("jira", "linear", "github", "sentry",
   *  or a custom MCP server name). Set when the row was imported via
   *  the MCP importer. Together with `external_id` it forms the upsert
   *  key so re-running the same import doesn't duplicate rows. */
  external_source?: string | null;
  /** QQ.1 — Stable id in the source system (e.g. `ACME-123` for Jira).
   *  Combined with `external_source` to dedupe imports. */
  external_id?: string | null;
  /** QQ.1 — Clickable URL back to the source-system record. Rendered
   *  as a chip on the task card + detail pane. */
  external_url?: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateTaskInput = {
  title: string;
  description?: string;
  /** Legacy free-form status (back-compat). New callers should send
   *  `state_id`. When both are set `state_id` wins; `status` is
   *  mirrored from the state's group on the backend. */
  status?: TaskStatus;
  /** OO.3 canonical state pointer. Defaults to `"backlog"` on the
   *  backend when omitted. */
  state_id?: string;
  priority?: TaskPriority;
  /** Legacy single-assignee writer. Prefer `assignee_ids`. */
  assignee?: string;
  /** OO.3 multi-assignee writer. Wins over `assignee` when set. */
  assignee_ids?: string[];
  agent_assignee?: string;
  reporter?: string;
  /** Legacy label-strings writer. Strings are auto-imported into
   *  the catalog. Prefer `label_ids` for explicit references. */
  labels?: string[];
  /** OO.3 label-catalog pointers writer. Wins over `labels`. */
  label_ids?: string[];
  linked_pr?: LinkedPr;
  linked_message_id?: string;
  due_date?: string;
  start_date?: string;
  estimate?: number;
  /** Canonical parent pointer. Either this or `epic_id` may be sent;
   *  the backend mirrors them. */
  parent_id?: string;
  epic_id?: string;
  is_epic?: boolean;
  objective?: string;
  dependencies?: string[];
  bead_id?: string;
  sprint?: string;
  /** OO.4 — Plane Cycle pointer. Empty string clears at create time. */
  cycle_id?: string;
  /** OO.4 — Plane Module pointer. Empty string clears at create time. */
  module_id?: string;
  /** QQ.1 — MCP importer pointers. Setting either to an empty string
   *  clears that field on the resulting row. */
  external_source?: string;
  external_id?: string;
  external_url?: string;
};

export type UpdateTaskInput = {
  id: string;
  title?: string;
  description?: string;
  /** Legacy status writer (back-compat). Prefer `state_id`. */
  status?: TaskStatus;
  /** OO.3 canonical state pointer. When set, `status` is mirrored
   *  from the state's group on the backend. */
  state_id?: string;
  priority?: TaskPriority;
  /** Legacy single-assignee writer. Prefer `assignee_ids` for
   *  multi-assignee. A `null` assignee clears both fields. */
  assignee?: string | null;
  /** OO.3 multi-assignee writer — replaces the whole list when
   *  supplied. Pass an empty array to clear. */
  assignee_ids?: string[];
  agent_assignee?: string;
  /** Legacy labels writer — strings are auto-imported into the
   *  catalog. Prefer `label_ids` for explicit references. */
  labels?: string[];
  /** OO.3 labels writer — catalog ids. Wins over `labels`. */
  label_ids?: string[];
  due_date?: string;
  start_date?: string;
  estimate?: number;
  /** Canonical parent pointer (mirrored to `epic_id` by backend). */
  parent_id?: string;
  epic_id?: string;
  /** Promote / demote a task to an epic. Omit to leave unchanged. */
  is_epic?: boolean;
  objective?: string;
  dependencies?: string[];
  bead_id?: string;
  sprint?: string;
  /** OO.4 — Plane Cycle pointer writer. Empty string clears the
   *  pointer; the backend treats `""` as null. */
  cycle_id?: string;
  /** OO.4 — Plane Module pointer writer. Same clearing convention. */
  module_id?: string;
  /** QQ.1 — MCP importer pointers. Empty string clears each field. */
  external_source?: string;
  external_id?: string;
  external_url?: string;
};

// ── QQ.1 — MCP→Tasks importer ─────────────────────────────────────────
//
// One call per source record. Backend dedupes on
// `(external_source, external_id)`: an existing match is patched,
// otherwise a fresh task is created with the external_* pointers set.
// `created: true` in the result tells the caller it minted a row;
// `created: false` means it patched. The importer UI sums these to
// render "imported N · updated M".

export type UpsertExternalTaskInput = {
  /** Source slug — "jira", "linear", "github", "sentry", or any custom
   *  MCP server name. Required. */
  external_source: string;
  /** Source-system stable id (e.g. Jira issue key `ACME-123`). Required. */
  external_id: string;
  /** Optional clickable URL back to the source record. */
  external_url?: string;
  /** Required on initial create; on re-import an empty string leaves
   *  the existing title alone. */
  title: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
  due_date?: string;
  assignee_ids?: string[];
};

export type UpsertExternalTaskResult = {
  task: Task;
  /** True when a brand-new task was minted; false when an existing
   *  row was patched. Frontend sums these to render
   *  "imported N · updated M". */
  created: boolean;
};

/** #218 — result of one `tasks_sync_poll`. snake_case to match the Rust
 *  serde wire format. */
export type TaskSyncPollResult = {
  /** At least one task was inserted, replaced, or removed — refetch. */
  changed: boolean;
  applied_ids: string[];
  removed_ids: string[];
  /** Cursor after this poll (highest cloud seq consumed). */
  next_seq: number;
};

/** #219 — result of one `pages_sync_poll`. snake_case to match the Rust
 *  serde wire format. */
export type PageSyncPollResult = {
  /** At least one page was written or removed — refetch the notes list. */
  changed: boolean;
  applied_ids: string[];
  removed_ids: string[];
  /** Cursor after this poll (highest cloud seq consumed). */
  next_seq: number;
};

// ── OO.4 — Plane Cycles + Modules ─────────────────────────────────────
//
// Plane-style sprint (Cycle) and workstream (Module) registries.
// Persisted at `.aura/tasks/task_cycles.json` and
// `.aura/tasks/task_modules.json`. Membership is mirrored both ways:
// each task carries a `cycle_id` / `module_id` pointer, and each
// catalog row carries a `task_ids` membership list.

export type CycleStatus = "planned" | "active" | "completed";

export type Cycle = {
  /** Stable slug — also the value stored on `Task.cycle_id`. */
  id: string;
  name: string;
  /** YYYY-MM-DD inclusive. */
  start_date: string;
  /** YYYY-MM-DD inclusive. */
  end_date: string;
  /** Free-text sprint goal ("what are we trying to land?"). Folded in
   *  from the legacy `Sprint.goal` when the two primitives unified. */
  goal: string;
  status: CycleStatus;
  /** Explicit membership mirror — the backend keeps this in sync with
   *  `Task.cycle_id` on assign / unassign / detach. */
  task_ids: string[];
  /** BEAD-I phase 4 — frozen throughput captured at Close (Σ points or
   *  done-count delivered). `null`/absent while planned or active. */
  velocity?: number | null;
  created_at: string;
  updated_at: string;
};

export type CycleInput = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  /** Free-text sprint goal. Optional — omitted by older callers. */
  goal?: string;
  status?: CycleStatus;
};

export type ModuleStatus = "planned" | "in_progress" | "completed";

export type Module = {
  /** Stable slug — also the value stored on `Task.module_id`. */
  id: string;
  name: string;
  status: ModuleStatus;
  /** Optional Plane-style "what is this workstream for" blurb. */
  description?: string;
  task_ids: string[];
  created_at: string;
  updated_at: string;
};

export type ModuleInput = {
  id: string;
  name: string;
  status?: ModuleStatus;
  description?: string;
};

// ── OO.5 — Plane Relations + Activity + Comments + Bulk ───────────────
//
// Relations: typed cross-task links (blocked_by / blocks / duplicates
// / relates_to). The backend persists asymmetric mirrors automatically
// — creating "A blocked_by B" also creates "B blocks A"; deleting one
// row deletes the pair.
//
// Activity: append-only audit timeline. Every mutation path emits a
// `TaskActivity` row that the detail panel renders chronologically.
//
// Comments: threaded discussion attached to a single task.
//
// Bulk ops: apply one mutation to many tasks in a single round trip.
// The result splits successes (`affected`) from failures (`errors`)
// so the UI can surface partial-success states.

export type TaskRelationKind =
  | "blocked_by"
  | "blocks"
  | "duplicates"
  | "relates_to";

export type TaskRelation = {
  id: string;
  source_id: string;
  target_id: string;
  kind: TaskRelationKind;
  created_at: string;
};

export type TaskActivityKind =
  | "created"
  | "updated"
  | "state_changed"
  | "assigned"
  | "unassigned"
  | "labeled"
  | "unlabeled"
  | "linked"
  | "unlinked"
  | "commented";

export type TaskActivity = {
  id: string;
  task_id: string;
  /** Canonical kind — see `TaskActivityKind`. Stored as a free-form
   *  string on the wire so future kinds don't break older readers. */
  kind: TaskActivityKind | string;
  /** Git handle of the human responsible. `"system"` when the
   *  mutation came from a non-attributable code path. */
  actor_handle: string;
  /** Event-specific payload. Example shapes:
   *    state_changed → { from: "backlog", to: "started" }
   *    assigned      → { added: ["ashiq"] }
   *    labeled       → { added: ["bug"] }
   *    linked        → { target_id: "task_abc", kind: "blocked_by" }
   *    commented     → { comment_id: "cmt_..." } */
  payload: Record<string, unknown>;
  created_at: string;
};

export type TaskComment = {
  id: string;
  task_id: string;
  /** When set, this comment is a reply to the referenced root. */
  parent_comment_id?: string | null;
  author_handle: string;
  body: string;
  created_at: string;
  updated_at: string;
};

export type BulkOpResult = {
  /** Task ids the mutation succeeded on. */
  affected: string[];
  /** Per-task failure pairs: `[task_id, error_message]`. */
  errors: [string, string][];
};

// Sprint registry — per-repo iteration windows backing the TasksBoard
// "Sprint" view. Persisted to `.aura/tasks/sprints.json`.
export type Sprint = {
  /** Stable slug — also the value stored on Task.sprint. */
  id: string;
  name: string;
  /** YYYY-MM-DD inclusive. */
  start: string;
  /** YYYY-MM-DD inclusive. */
  end: string;
  /** Free-text "what we want to land". */
  goal: string;
  /** Only one sprint is active at a time. */
  active: boolean;
  /** BEAD-I phase 4 — frozen throughput recorded at Close (Σ points or
   *  done-count delivered). `null`/absent until the sprint is completed. */
  velocity?: number | null;
  created_at: string;
  updated_at: string;
};

export type SprintInput = {
  id: string;
  name: string;
  start: string;
  end: string;
  goal?: string;
  active?: boolean;
};

// Saved views — OO.2 Phase 2. A view bundles a layout, filter set,
// grouping, ordering, and display-property selection into one named
// slice persisted at `.aura/tasks/views.json`. See cmd_tasks.rs.
export type TaskViewLayout =
  | "board"
  | "list"
  | "spreadsheet"
  | "epics"
  | "sprint"
  | "gantt"
  | "roadmap";

export type TaskViewFilters = {
  /** Status slugs ("backlog", "in_progress", ...). */
  status?: TaskStatus[];
  /** Priority slugs. */
  priority?: TaskPriority[];
  /** Assignee handles — `"@me"` is resolved to the current user at
   *  runtime by the frontend. */
  assignee?: string[];
  /** AI agent slugs ("claude", "gemini", "codex", "opencode"). */
  agent?: string[];
  /** Label strings. */
  labels?: string[];
  /** Free-text search over title + description. */
  q?: string;
};

export type TaskViewGroupBy =
  | "none"
  | "status"
  | "priority"
  | "assignee"
  | "label";

export type TaskViewOrderBy =
  | "created"
  | "updated"
  | "priority"
  | "due"
  | "estimate"
  | "title";

export type TaskViewOrderDir = "asc" | "desc";

export type TaskViewDisplayProp =
  | "id"
  | "assignee"
  | "priority"
  | "due"
  | "start"
  | "labels"
  | "estimate"
  | "agent"
  | "pr"
  | "updated";

export type TaskView = {
  id: string;
  name: string;
  layout: TaskViewLayout;
  /** Free-form on the wire — see TaskViewFilters for the runtime shape. */
  filters: TaskViewFilters;
  group_by: TaskViewGroupBy;
  order_by: TaskViewOrderBy;
  order_dir: TaskViewOrderDir;
  display_props: TaskViewDisplayProp[];
  created_at: string;
  updated_at: string;
};

export type TaskViewInput = {
  id: string;
  name: string;
  layout: TaskViewLayout;
  filters: TaskViewFilters;
  group_by: TaskViewGroupBy;
  order_by: TaskViewOrderBy;
  order_dir: TaskViewOrderDir;
  display_props: TaskViewDisplayProp[];
};

// Notes — Notion-style per-scope markdown
export type NoteScope = "team" | "channel" | "member";

// Slack-canvas-style team note: a single markdown blob keyed by file
// path (`.aura/team/channels/<channel>.notes.md` or
// `.aura/team/notes.md`). `updated_at === 0` means the file didn't
// exist at read time — semantically identical to an empty body.
export type NoteDoc = { body: string; updated_at: number; byte_len: number };

// Timed-feed notes — one row per entry, with author + timestamp + mentions.
// Scope is `"team"` | `"channel:<name>"` | `"user:<handle>"`. The first two
// land in `.aura/team/` and get committed; user scope is local-only.
export type NoteEntry = {
  id: string;
  ts: number;
  author_handle: string;
  author_name: string;
  body: string;
  mentions: string[];
};

export type NoteFrontmatter = {
  title?: string | null;
  author?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  visibility?: string | null;
  /** Lock toggle — when true the page is read-only in the editor.
   *  Persisted in frontmatter so the lock travels with the note. */
  locked?: boolean | null;
  tags: string[];
  /** Folder id this page lives in; null/absent ⇒ a root page. */
  folder?: string | null;
};

export type NoteSummary = {
  id: string;
  scope: NoteScope;
  bucket: string;
  title: string;
  updated_at: string;
  tags: string[];
  visibility: string;
  /** Tree parent — null/absent for a top-level page. */
  parent_id?: string | null;
  /** Present (ISO ts) when the page is archived. */
  archived_at?: string | null;
  /** Folder id this page lives in; null/absent ⇒ a root page. */
  folder?: string | null;
};

export type Note = {
  id: string;
  scope: NoteScope;
  bucket: string;
  frontmatter: NoteFrontmatter;
  body: string;
  raw: string;
};

export type NoteSearchHit = {
  note: NoteSummary;
  /** ~120-char window around the first match in the body. */
  snippet: string;
  match_count: number;
};

/** A lightweight, user-organizational group for Pages — named + colored,
 *  optionally nested. Membership lives on the page (its `folder` field), so a
 *  folder never holds page bytes and deleting one only un-files its pages. */
export type Folder = {
  id: string;
  name: string;
  /** Color token the UI maps to a swatch. */
  color: string;
  /** Manual sort key within a parent; lower sorts first. */
  order: number;
  /** Parent folder id for nesting; null/absent ⇒ a top-level folder. */
  parent?: string | null;
};

// Brain abstraction (v0.2.30 KK.3) — one descriptor per compiled brain.
export type BrainDescriptor = {
  provider_id: string;
  display_name: string;
  blurb: string;
  requires_api_key: boolean;
  /** True iff the keychain currently holds an API key for this brain. */
  has_api_key: boolean;
};

export type BrainProviderConfig = {
  model?: string | null;
  extra?: unknown;
};

/** Saved config for a cloud singleton brain (Bedrock / Vertex) as read back
 *  by {@link Api.brainCloudConfigGet}. Mirrors Rust `BrainCloudConfigOut`.
 *  Never carries the credential itself — `has_secret` only says whether one
 *  is in the keychain. `extra` holds the non-secret fields (Bedrock:
 *  `region` / `access_key_id` / `session_token`; Vertex: `project_id` /
 *  `location`). */
export type BrainCloudConfig = {
  provider_id: string;
  model: string | null;
  extra: Record<string, string>;
  has_secret: boolean;
};

/** One selectable brain for the chat-header BrainPicker (WW-B1). Flatter
 *  than {@link BrainDescriptor} — just what the dropdown needs. `kind` is
 *  the brain family (`anthropic_native`, `cli_wrapper`, `openai_compat`,
 *  …) for the per-row icon; `active` marks the globally-active brain. */
export type BrainChoice = {
  id: string;
  label: string;
  kind: string;
  active: boolean;
  /** Whether this brain needs an API key to run at all. CLI-wrapper brains
   *  authenticate out-of-band → `false`; hosted brains → `true`. With
   *  `has_api_key` the picker disables a row that can't run. */
  requires_api_key: boolean;
  /** Whether a key for this brain is in the keychain. When
   *  `requires_api_key && !has_api_key` the picker disables the row and
   *  shows a fix-it hint. */
  has_api_key: boolean;
};

/** The semantic state a *different* brain reads to resume work at the
 *  exact point of interruption (Claude → Gemini → Kimi). Returned by
 *  `brain_carryover` at the explicit swap moment — NOT per turn. Mirrors
 *  the Rust `AuraCarryover` (which mirrors `aura carryover --json`). */
export type AuraCarryover = {
  version: number;
  /** `"full"` | `"semantic"`. */
  mode: string;
  generated_at: number;
  repo: string;
  branch?: string | null;
  target_agent?: string | null;
  session?: CarryoverSessionDigest | null;
  intents: CarryoverIntentBrief[];
  /** Function/class nodes recent checkpoints touched, each tagged with
   *  the intent that changed it (function-level intent linkage). */
  touched_nodes: CarryoverNodeState[];
  working_tree: CarryoverWorkingTreeDiff;
  /** Project-memory compact summary, as-is (shape varies). */
  memory?: unknown | null;
  /** Transcript tail, capped by `mode`. */
  recent_turns: CarryoverTurnBrief[];
};

export type CarryoverSessionDigest = {
  session_id: string;
  agent_id: string;
  model?: string | null;
  branch?: string | null;
  base_commit?: string | null;
  started_at: number;
  last_activity: number;
  files_touched: string[];
  first_prompt?: string | null;
  summary?: CarryoverSessionSummaryBrief | null;
};

export type CarryoverSessionSummaryBrief = {
  intent: string;
  outcome: string;
  open_items: string[];
  learnings: string[];
};

export type CarryoverIntentBrief = {
  timestamp: number;
  agent_id: string;
  intent: string;
  intent_type?: string | null;
  /** Present when the intent was signed — verifiable via `aura attest verify`. */
  signed_block_id?: string | null;
};

export type CarryoverNodeState = {
  /** Rename-proof node id (`fn::name@file:line`). */
  node_id: string;
  identifier?: string | null;
  kind: string;
  file_path?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  signature?: string | null;
  /** True if the node still holds a stub/TODO — unfinished work. */
  is_stub: boolean;
  intent: string;
  at: number;
};

export type CarryoverWorkingTreeDiff = {
  files_changed: number;
  insertions: number;
  deletions: number;
  files: CarryoverFileDiffStat[];
};

export type CarryoverFileDiffStat = {
  path: string;
  /** Single-letter git status (M/A/D/R/?). */
  status: string;
};

export type CarryoverTurnBrief = {
  role: string;
  text: string;
  at: number;
};

export type BrainSettings = {
  active_provider_id?: string | null;
  providers: Record<string, BrainProviderConfig>;
  /** When true, the dispatcher + tick scheduler auto-bind each unpinned
   *  lane to the Agent Skill Ledger's best provider for its taxonomy
   *  cell. A manual per-lane override always wins. Defaults to true. */
  auto_route: boolean;
};

/** Snapshot of the currently-active brain — emitted by
 *  `brain_active_info`. `ManagerChatView` reads this on session mount
 *  to decide whether to use the legacy `manager-stream` path (CLI
 *  wrappers — terminal surface) or the new `manager-chat-chunk`
 *  stream path (native brains). */
export type ActiveBrainInfo = {
  provider_id: string;
  is_cli_wrapper: boolean;
};

/** One chat message in a brain turn. Mirrors the Rust `ChatMessage`
 *  type 1:1. `content` is either plain text or a JSON-serialized
 *  content-block array — the brain translates as needed. */
export type BrainChatMessage = {
  role: "user" | "assistant" | "system";
  content: unknown;
};

/** Cross-agent reasoning effort. Maps onto each provider's real mechanism
 *  server-side (Anthropic/Gemini thinking budgets, OpenAI `reasoning_effort`,
 *  Codex `model_reasoning_effort`, or a CLI prompt-steer). Mirrors the Rust
 *  `aura_agents::ReasoningEffort` (snake_case). */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

/** Cross-agent permission / autonomy mode. One picker chip drives the real
 *  per-CLI approval flag server-side — Claude `--permission-mode`, Gemini
 *  `--approval-mode`, Codex sandbox — so "auto / bypass / plan" works the
 *  same on every agent. Mirrors the Rust `aura_agents::ApprovalPolicy`
 *  (snake_case). `default` → the agent's own gating (byte-identical). */
export type ApprovalPolicy = "default" | "accept_edits" | "plan" | "bypass";

/** Per-turn context the frontend passes to `brain_chat_turn`. All
 *  fields are optional — the simplest call is `(sessionId, message)`
 *  with `null` context. */
export type BrainChatContext = {
  messages?: BrainChatMessage[];
  system?: string | null;
  tools?: unknown[];
  max_tokens?: number | null;
  temperature?: number | null;
  /** Reasoning effort for this turn. Omit → provider default (request is
   *  byte-identical to the pre-effort build). Set by the composer Effort chip. */
  effort?: ReasoningEffort | null;
  /** Latency-first (⚡): collapse effort to the provider minimum / disable
   *  extended thinking. Orthogonal to `effort`. */
  fast?: boolean;
  /** Per-turn model override from the composer model picker (#251). Omit /
   *  null → the brain stays on its configured default. snake_case to match
   *  the serde-deserialized Rust `ChatRequest`. */
  model?: string | null;
  /** Long-context variant (the picker's "1M" rows) → Anthropic-family
   *  brains add the 1M-context beta header. */
  long_context?: boolean;
  /** Cross-agent permission / autonomy mode for this turn (the composer's
   *  Approvals chip). Omit / `default` → the agent's own gating. CLI brains
   *  map it onto the real per-CLI approval flag. snake_case to match the
   *  serde-deserialized Rust `ChatRequest`. */
  approval?: ApprovalPolicy | null;
};

/** Per-turn token accounting for the chat context-fill meter. `input_tokens`
 *  is the prompt the provider billed (history + system + tools); `output_tokens`
 *  is what the model generated. Best-effort — a turn from a provider that
 *  doesn't report usage never carries one and the meter stays hidden. Mirrors
 *  the Rust `TokenUsage`. */
export type BrainTokenUsage = {
  input_tokens: number;
  output_tokens: number;
};

/** One event from a `brain_chat_turn` stream. Wire shape matches the
 *  Rust `ChatChunk` enum, with `kind` as the serde discriminator. */
export type BrainChatChunk =
  | { kind: "text"; block_idx: number; text: string }
  // Extended-thinking / reasoning delta — append to the collapsible reasoning
  // block at `block_idx`. Emitted only by brains that expose a chain-of-thought
  // stream (Anthropic extended thinking, Gemini `thought` parts) when the
  // caller opted into an effort level. Rendered as a muted, collapsed
  // "Thinking…" disclosure ABOVE the answer prose.
  | { kind: "reasoning"; block_idx: number; text: string }
  // Per-turn token accounting — emitted once, right before `end`, by brains
  // that report usage. Drives the context-fill meter in the chat header.
  | { kind: "usage"; input_tokens: number; output_tokens: number }
  | {
      kind: "tool_use";
      block_idx: number;
      tool_use_id: string;
      name: string;
      input: unknown;
    }
  // Emitted by the native brain's server-side tool loop after it runs a
  // board/page tool — keyed back to the originating tool_use so the card
  // shows its result. Ordinary brains never produce this.
  | { kind: "tool_result"; tool_use_id: string; content: string; is_error: boolean }
  | { kind: "end"; stop_reason?: string | null }
  | { kind: "error"; message: string };

/** Sign-in state for the Aura Pro brain (v0.2.31 task #352). Read from
 *  `~/.aura/credentials.json` — same file OnboardingDialog populates,
 *  so signing in once unlocks the picker. */
export type AuraProSignInState = {
  signed_in: boolean;
  user: string | null;
  cloud_origin: string | null;
};

/** Monthly token quota for the Aura Pro brain. Mirrors the cloud
 *  `QuotaView` returned by `GET /v1/brain/quota`. `monthly_token_limit`
 *  is `null` for the unlimited (enterprise) tier — the picker renders
 *  "∞" in that case instead of a fraction. */
export type AuraProQuota = {
  tier: string;
  active: boolean;
  monthly_token_limit: number | null;
  tokens_used_current_period: number;
  /** ISO-8601 timestamp the current 30-day window started. */
  period_started_at: string;
};

/** One concrete model a provider currently serves (`agent_models_list`). */
export type ModelInfo = {
  id: string;
  label: string;
  /** Provider's own recency signal (unix seconds); used to sort newest-first. */
  created?: number | null;
  /** Stable per-row key from the Aura catalog (unique within a family). */
  key?: string;
  /** Vendor display name ("Anthropic" / "Google" / "OpenAI"). */
  vendor?: string;
  /** Icon slug for `AgentIcon` ("claude" / "gemini" / "codex"). */
  brand?: string;
  /** Brand name shown next to the label ("Claude" / "Gemini" / "GPT"). */
  brandName?: string;
  /** 1M-context variant → `ChatRequest.long_context`. */
  longContext?: boolean;
  /** Recently-shipped → NEW pill. */
  isNew?: boolean;
};

/**
 * Live model catalog sourced from each provider's `/models` endpoint — the
 * stable authority the picker uses instead of a hardcoded list. `families`
 * is keyed by vendor family (`anthropic` / `openai` / `gemini`); a family
 * absent from `families` but present in `errors` (e.g. no API key) means the
 * picker falls back to its curated static list for that family.
 */
export type ModelCatalog = {
  /** Unix seconds the catalog was fetched (cache-age + 24h TTL). */
  fetched_at: number;
  /** True when served from the on-disk cache rather than a live fetch. */
  cached: boolean;
  families: Record<string, ModelInfo[]>;
  errors: Record<string, string>;
};

export type NoteListInput = {
  repoRoot: string;
  scope?: NoteScope;
  bucket?: string;
};

export type NoteWriteInput = {
  repoRoot: string;
  scope: NoteScope;
  bucket?: string;
  id?: string;
  body: string;
  title?: string;
  author?: string;
  visibility?: string;
  /** Lock toggle. Omit to leave the existing lock untouched (a normal
   *  body save passes undefined so it never clears a lock). */
  locked?: boolean;
  tags?: string[];
  /** Folder membership. Omit (or pass null) to leave the page's folder
   *  untouched on a body save — folder moves go through `noteSetFolder`. */
  folder?: string | null;
};

/** Emitted by the agent_mutation_guard backend when a workspace file
 *  is created/modified/removed while an agent PTY is alive and no
 *  `aura_log_intent` row within the freshness window covers the path.
 *  Listened to by `UnattributedChangesBanner`. */
export type UnattributedMutation = {
  /** Absolute path the OS watcher saw. */
  path: string;
  /** "create" | "modify" | "remove" */
  kind: "create" | "modify" | "remove";
  /** Single agent id if only one agent is alive; "" when ambiguous. */
  agent_id: string;
  /** Comma-separated list of agent ids alive at detection time. */
  live_agents: string;
  /** Detection time, unix seconds. */
  ts: number;
  /** `path:ts` — stable id for React keying + dedupe. */
  event_id: string;
};

/** Result of `aura_ensure_tracked` — whether the just-opened repo is now a
 *  live Aura repo, wired for intent capture. Drives the quiet "now tracking"
 *  confirmation and the non-git one-click enable notice. */
export type AuraTrackStatus = {
  repo_root: string;
  /** A git repo at all? Aura can't track without git. */
  is_git: boolean;
  /** Capture is on (`.aura/` + hooks) after this call. */
  tracked: boolean;
  /** True only when THIS call flipped it on (show the toast once). */
  newly_enabled: boolean;
  /** Agent CLIs wired (MCP + hooks) so edits here log intent. */
  wired: boolean;
  /** Human line for the non-git / error case; null on success. */
  detail: string | null;
};

export const api = {
  auraStatus: () => invoke<AuraStatus>("aura_status"),
  homeDir: () => invoke<string>("home_dir"),
  currentDir: () => invoke<string>("current_dir"),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  /** Read any file's raw bytes as base64 + a guessed media type — the
   *  binary-safe sibling of `readFile`, used to turn an OS-dropped screenshot
   *  into an inline chat image attachment. Rejects files over 20 MB. */
  readFileBase64: (path: string) =>
    invoke<FileBase64>("read_file_base64", { path }),
  /** Read the Code Atlas for a repo (plain-English meaning of every symbol),
   *  shaped for the editor hover and folded with meaning-change tracking. */
  readAtlas: (repoRoot: string) =>
    invoke<AtlasHover>("read_atlas", { repoRoot }),
  writeFile: (path: string, contents: string) =>
    invoke<void>("write_file", { path, contents }),
  fsCreateFile: (path: string) => invoke<string>("fs_create_file", { path }),
  fsCreateFolder: (path: string) => invoke<string>("fs_create_folder", { path }),
  fsRename: (from: string, to: string) =>
    invoke<string>("fs_rename", { from, to }),
  fsDelete: (path: string) => invoke<void>("fs_delete", { path }),
  fsRevealInFinder: (path: string) =>
    invoke<void>("fs_reveal_in_finder", { path }),
  editorsList: () => invoke<EditorInfo[]>("editors_list"),
  editorOpen: (path: string, editorId: string) =>
    invoke<void>("editor_open", { path, editorId }),
  fsFindFiles: (repoRoot: string) =>
    invoke<string[]>("fs_find_files", { repoRoot }),
  fsGrepContent: (
    repoRoot: string,
    query: string,
    opts?: GrepOpts,
  ) => invoke<GrepResult>("fs_grep_content", { repoRoot, query, opts }),
  fsReplaceInFiles: (
    repoRoot: string,
    paths: string[],
    query: string,
    replacement: string,
    opts?: GrepOpts,
  ) =>
    invoke<ReplaceReport>("fs_replace_in_files", {
      repoRoot,
      paths,
      query,
      replacement,
      opts,
    }),
  fsGrepSymbol: (repoRoot: string, name: string) =>
    invoke<SymbolHit[]>("fs_grep_symbol", { repoRoot, name }),
  appBundleLocation: () => invoke<AppLocation>("app_bundle_location"),
  gitStatus: (repoRoot: string) =>
    invoke<Record<string, string>>("git_status", { repoRoot }),
  /** One file's working-tree patch. `sinceBase` (worktrees only) shows the
   *  file's full change from the worktree's fork base → working tree (committed
   *  + uncommitted) instead of just vs HEAD; omitted/false keeps vs-HEAD. */
  gitDiff: (repoRoot: string, file: string, sinceBase?: boolean) =>
    invoke<string>("git_diff", { repoRoot, file, sinceBase: sinceBase ?? null }),
  /** One-sentence, plain-language "what changed" for a single working-tree
   *  file — the human-readable half of the file-insight strip. Uses whichever
   *  model the user has reachable; falls back to a deterministic line when
   *  none is, and caches by diff content-hash so the model runs at most once
   *  per distinct edit. Never throws on a missing model. */
  summarizeFileChange: (repoRoot: string, path: string) =>
    invoke<ChangeSummary>("summarize_file_change", { repoRoot, path }),
  /** Plain-language before/what/why for one file's change — the split-diff's
   *  "what it used to do" (before) + "what changed" (what) columns and the
   *  reasoning band (why + how it works now). `commit` scopes it to a past
   *  commit's change; omit for the live working-tree edit. Model-backed with a
   *  deterministic fallback, cached by (path, diff-hash, angle). Never throws
   *  on a missing model. */
  explainChange: (repoRoot: string, path: string, commit?: string) =>
    invoke<ChangeExplanation>("explain_change", { repoRoot, path, commit: commit ?? null }),
  /** Same before/what/why explanation for a diff the caller already holds — one
   *  file's raw unified diff across a PR's base..head range (from `gh pr diff`),
   *  which has no single commit to point at. Cached by the diff's content-hash. */
  explainChangeDiff: (repoRoot: string, path: string, diff: string) =>
    invoke<ChangeExplanation>("explain_change_diff", { repoRoot, path, diff }),
  /** Per-piece plain-language meaning for each changed symbol in a file — the
   *  "New is this" / "Previous was this" node blurbs. The file-level
   *  before/what/why can't speak for each of several pieces, so this describes
   *  each on its own. Model-backed with a per-piece deterministic fallback
   *  (mined from that piece's own diff lines), cached by (path, diff-hash,
   *  symbol). `commit` scopes it to a past commit; omit for the working-tree
   *  edit. Never throws on a missing model. */
  explainSymbols: (
    repoRoot: string,
    path: string,
    symbols: ChangedSymbol[],
    commit?: string,
  ) =>
    invoke<SymbolExplanation[]>("explain_symbols", {
      repoRoot,
      path,
      commit: commit ?? null,
      symbols,
    }),
  /** Patch a single commit applied to one file (no commit-message header).
   *  Used by Trace Changes to show a committed run's real diff once
   *  `git diff HEAD` reports the file as clean. */
  gitDiffAtCommit: (repoRoot: string, sha: string, file: string) =>
    invoke<string>("git_diff_at_commit", { repoRoot, sha, file }),
  /** One file's NET change from a baseline commit to its live working-tree
   *  state (`git diff <base> -- <path>`). Used by a native Aura chat session,
   *  which never commits — it edits the tree and stamps a per-turn baseline —
   *  so its Changes tab diffs against that baseline (correct whether the work
   *  is still uncommitted or was later committed). */
  gitDiffBase: (repoRoot: string, base: string, file: string) =>
    invoke<string>("git_diff_base", { repoRoot, base, file }),
  /** Per-file stats for one commit (status + added/deleted line counts) for
   *  the History detail's "Files changed" list. From one
   *  `git show --numstat --name-status`. */
  gitCommitFileStats: (repoRoot: string, sha: string) =>
    invoke<GitCommitFileStat[]>("git_commit_file_stats", { repoRoot, sha }),
  gitBranch: (repoRoot: string) =>
    invoke<string>("git_branch", { repoRoot }),
  /** Local + remote-tracking branches for the footer switcher, newest
   *  commit first. Current branch flagged; `origin/HEAD` pointer skipped. */
  gitBranches: (repoRoot: string) =>
    invoke<GitBranchInfo[]>("git_branches", { repoRoot }),
  /** Rich branch rows for the Cmd-K switcher — author, last-moved time,
   *  subject, and ahead/behind vs upstream, all from one `for-each-ref`. */
  gitBranchesRich: (repoRoot: string) =>
    invoke<GitBranchRich[]>("git_branches_rich", { repoRoot }),
  /** Checkout an existing branch. A remote ref (`origin/x`) DWIMs into a
   *  local tracking branch. Rejects with git's stderr on failure. */
  gitCheckout: (repoRoot: string, branch: string) =>
    invoke<void>("git_checkout", { repoRoot, branch }),
  /** Create + switch to a new branch from HEAD (`git checkout -b`). */
  gitCreateBranch: (repoRoot: string, name: string) =>
    invoke<void>("git_create_branch", { repoRoot, name }),
  gitRemoteOrigin: (repoRoot: string) =>
    invoke<string>("git_remote_origin", { repoRoot }),
  gitLastCommitAge: (repoRoot: string) =>
    invoke<number>("git_last_commit_age", { repoRoot }),
  gitShowHead: (repoRoot: string, file: string) =>
    invoke<string>("git_show_head", { repoRoot, file }),
  gitBlameLines: (repoRoot: string, file: string) =>
    invoke<BlameLine[]>("git_blame_lines", { repoRoot, file }),
  cliDetect: (name: string) =>
    invoke<{ installed: boolean; path: string | null; version: string | null }>(
      "cli_detect",
      { name },
    ),
  /** Task #229 — check the installed `aura` CLI against the version the
   *  shell expects. Powers the footer chip in `StatusBar`. Returns
   *  status `"ok" | "outdated" | "missing" | "unknown"`. */
  auraCliVersionCheck: () =>
    invoke<{
      installed: string | null;
      expected: string;
      path: string | null;
      status: "ok" | "outdated" | "missing" | "unknown";
      raw: string | null;
    }>("aura_cli_version_check"),
  /** Install the `aura` CLI bundled with this desktop release in place, so
   *  the on-PATH binary matches the app after an update. Atomic rename +
   *  signature-preserving. Returns a fresh version check. Rejects when there
   *  is no bundled binary (dev build) — callers treat that as a silent no-op.
   *  Pass `interactive: true` from explicit user clicks: when the install
   *  dir is root-owned (e.g. /usr/local/bin) that authorizes the macOS
   *  admin-password prompt; the silent default instead rejects with a
   *  "needs authorization" marker the toast turns into an Authorize button. */
  auraCliInstallBundled: (interactive?: boolean) =>
    invoke<{
      installed: string | null;
      expected: string;
      path: string | null;
      status: "ok" | "outdated" | "missing" | "unknown";
      raw: string | null;
    }>("aura_cli_install_bundled", { interactive: interactive ?? false }),
  claudeAuthStatus: () =>
    invoke<{
      logged_in: boolean;
      email: string | null;
      auth_method: string | null;
      api_provider: string | null;
      subscription_type: string | null;
      org_name: string | null;
    }>("claude_auth_status"),
  claudeAuthLogin: (method: "claudeai" | "console") =>
    invoke<number>("claude_auth_login", { method }),
  claudeAuthLogout: () => invoke<void>("claude_auth_logout"),
  codexAuthStatus: () =>
    invoke<{
      logged_in: boolean;
      method: string | null;
      /** "logged_in" | "logged_out" | "broken" | "missing" */
      state: string;
      /** Human-readable reason when broken/missing. */
      detail: string | null;
      /** Copy-run command that repairs a missing/broken install. */
      fix_command: string | null;
      /** Codex/ChatGPT credentials exist on disk even if the CLI is down. */
      has_credentials: boolean;
    }>("codex_auth_status"),
  codexAuthLogin: () => invoke<number>("codex_auth_login"),
  codexAuthLoginApiKey: (apiKey: string) =>
    invoke<number>("codex_auth_login_api_key", { apiKey }),
  openMacosPrivacyPane: (pane: string) =>
    invoke<void>("open_macos_privacy_pane", { pane }),
  gitStatusV2: (repoRoot: string) =>
    invoke<GitStatusEntry[]>("git_status_v2", { repoRoot }),
  gitStage: (repoRoot: string, paths: string[]) =>
    invoke<string>("git_stage", { repoRoot, paths }),
  gitUnstage: (repoRoot: string, paths: string[]) =>
    invoke<string>("git_unstage", { repoRoot, paths }),
  gitCommit: (repoRoot: string, message: string) =>
    invoke<string>("git_commit", { repoRoot, message }),
  gitDiscard: (repoRoot: string, paths: string[]) =>
    invoke<string>("git_discard", { repoRoot, paths }),
  gitPush: (repoRoot: string, setUpstream: boolean) =>
    invoke<string>("git_push", { repoRoot, setUpstream }),
  gitPull: (repoRoot: string) =>
    invoke<string>("git_pull", { repoRoot }),
  gitFetch: (repoRoot: string) =>
    invoke<string>("git_fetch", { repoRoot }),
  gitSync: (repoRoot: string) =>
    invoke<string>("git_sync", { repoRoot }),
  // Create a new project on disk (New Project screen). Both return the
  // absolute root to hand to loadProjectAt.
  gitClone: (url: string, parentDir: string, name?: string) =>
    invoke<NewRepo>("git_clone", { url, parentDir, name: name ?? null }),
  gitInit: (parentDir: string, name: string) =>
    invoke<NewRepo>("git_init", { parentDir, name }),
  scaffoldTemplate: (parentDir: string, name: string, template: string) =>
    invoke<NewRepo>("scaffold_template", { parentDir, name, template }),
  // Seed the bundled "Recipe Box" sample project on first launch. Idempotent —
  // returns the existing root if already seeded. `ambientSessionId` is the live
  // sample chat to focus so Build opens on a real conversation.
  seedSampleProject: () => invoke<SeededSample>("seed_sample_project"),
  // Front the OS emoji / character picker (macOS Character Viewer). The picked
  // glyph is inserted into whatever text field is focused in the webview — the
  // caller focuses a capture input first, then reads the inserted character.
  openSystemEmojiPicker: () => invoke<void>("open_system_emoji_picker"),
  gitAheadBehind: (repoRoot: string) =>
    invoke<AheadBehind>("git_ahead_behind", { repoRoot }),
  gitShowCommit: (repoRoot: string, sha: string) =>
    invoke<string>("git_show_commit", { repoRoot, sha }),
  gitWorktreeList: (repoRoot: string) =>
    invoke<WorktreeEntry[]>("git_worktree_list", { repoRoot }),

  // ── branch-vs-branch comparison (F2 Compare Worktrees) ─────────────
  // Compare two refs in the same repo without checking either out. The
  // shell uses this to render side-by-side diffs of N parallel agent
  // attempts (each on its own worktree branch) so the user can pick a
  // winner and merge that branch back.
  gitBranchDiffFiles: (repoRoot: string, baseRef: string, headRef: string) =>
    invoke<BranchDiffFile[]>("git_branch_diff_files", {
      repoRoot,
      baseRef,
      headRef,
    }),
  gitBranchDiffFile: (
    repoRoot: string,
    baseRef: string,
    headRef: string,
    file: string,
  ) =>
    invoke<string>("git_branch_diff_file", {
      repoRoot,
      baseRef,
      headRef,
      file,
    }),
  gitMergeBranch: (repoRoot: string, branch: string, message?: string) =>
    invoke<string>("git_merge_branch", {
      repoRoot,
      branch,
      message: message ?? null,
    }),

  // ── managed worktrees (~/.aura/worktrees/<projectId>/<branch>/) ──
  // Higher-level surface than gitWorktreeAdd/Remove: Aura picks the
  // path, types the start-point resolution (no ambiguity between
  // "origin/foo" the local branch vs "origin/foo" the remote-tracking
  // ref), and atomic-safe removes via rename+detached-rm. Used by the
  // Manager loop to isolate each task in its own worktree.
  worktreeResolveRef: (repoRoot: string, raw: string) =>
    invoke<ResolvedRef>("worktree_resolve_ref", { repoRoot, raw }),
  worktreeCreateManaged: (repoRoot: string, branch: string, startRaw: string) =>
    invoke<ManagedWorktree>("worktree_create_managed", {
      repoRoot,
      branch,
      startRaw,
    }),
  worktreeRemoveManaged: (repoRoot: string, worktreePath: string) =>
    invoke<void>("worktree_remove_managed", { repoRoot, worktreePath }),
  worktreeResolvePath: (repoRoot: string, branch: string) =>
    invoke<string>("worktree_resolve_path", { repoRoot, branch }),

  // ── Lanes (AURA-81) — auto-isolated worktree per agent ──────────────
  // Launching a new agent transparently provisions an isolated "lane": a
  // managed worktree on an auto-named `lane/*` branch, with the agent's
  // PTY opened with cwd = lane path. Each lane gets its own working tree,
  // index, HEAD and cwd while sharing the git object DB + the git-tracked
  // meaning/memory files — so two Claude/Gemini/Codex sessions run in
  // parallel without manual `git worktree add` or branch-switching.
  // Mirrors `aura-shell/src-tauri/src/cmd_lane.rs`.

  /** Spawn a fresh lane: create a managed worktree on a new
   *  `lane/{agent}-{uuid8}` branch off HEAD, then open the agent's PTY
   *  inside it. Returns the Lane descriptor (incl. the live `termId`). */
  laneSpawn: (repoRoot: string, agent: string, label?: string) =>
    invoke<Lane>("lane_spawn", { repoRoot, agent, label: label ?? null }),
  /** Active lanes for this workspace — every `lane/*` worktree joined
   *  with any live agent session running in it (`termId` set when the
   *  lane's agent is still running, null when only the worktree survives). */
  laneList: (repoRoot: string) => invoke<Lane[]>("lane_list", { repoRoot }),
  /** Tear down a lane (close its agent + remove the worktree + branch).
   *  Dirty-guard: when the lane has uncommitted work and `force` is
   *  false, returns `{ kind: "dirty", changedFiles }` and removes
   *  nothing — re-call with force=true to discard anyway. */
  laneDiscard: (repoRoot: string, laneId: string, force = false) =>
    invoke<LaneDiscardResult>("lane_discard", { repoRoot, laneId, force }),

  // Parity W8 — launch manifest. One round-trip provisions a managed
  // worktree AND spawns the requested agent PTYs inside it. Worktree
  // failure rejects; per-agent spawn failures land in `errors` so a
  // partial fleet still launches. Drive the optimistic in-flight tile
  // from this call's lifecycle (see workspaceCreateStore).
  workspaceLaunch: (
    repoRoot: string,
    branch: string,
    startRaw: string,
    agents: LaunchAgentSpec[],
    cols?: number,
    rows?: number,
  ) =>
    invoke<WorkspaceLaunchManifest>("workspace_launch", {
      repoRoot,
      branch,
      startRaw,
      // Rust deserializes the snake_case field names on LaunchAgentSpec.
      agents: agents.map((a) => ({
        agent_id: a.agentId,
        profile_name: a.profileName ?? null,
        model: a.model ?? null,
        effort: a.effort ?? null,
      })),
      cols: cols ?? null,
      rows: rows ?? null,
    }),

  // Agent CLI surface — discovery + spawn. Streaming variant emits
  // `agent-stream:<channel>` line-by-line and `agent-done:<channel>`
  // with the exit code; subscribe via `@tauri-apps/api/event` listen().
  agentDiscover: () => invoke<AgentInfo[]>("agent_discover"),
  /** Real skills/commands/rules every installed agent carries on disk —
   *  scanned from `~/.claude/skills`, `~/.codex/prompts`, `~/.cursor/rules`,
   *  etc. plus the project-local copies under `repoRoot`. */
  agentSkillsList: (repoRoot: string) =>
    invoke<AgentSkill[]>("agent_skills_list", { repoRoot }),
  agentSend: (
    agentId: string,
    prompt: string,
    repoRoot: string,
    continueSession: boolean,
  ) => invoke<string>("agent_send", { agentId, prompt, repoRoot, continueSession }),
  agentSendStreaming: (
    agentId: string,
    prompt: string,
    repoRoot: string,
    continueSession: boolean,
    channel: string,
  ) =>
    invoke<void>("agent_send_streaming", {
      agentId,
      prompt,
      repoRoot,
      continueSession,
      channel,
    }),

  // Interactive agent PTY surface. Frontend listens to `agent-pty:<id>` for raw
  // bytes (xterm.js consumes them directly) and `agent-block:<id>` for
  // BlockUpdate deltas (the UI view applies them in order). By default
  // agentPtyOpen reattaches to a live (agent, root) pair for restored
  // tabs; pass forceNew=true for an explicit second Claude/Codex/etc.
  agentPtyOpen: (
    agentId: string,
    repoRoot: string,
    cols: number,
    rows: number,
    /** Optional claude session id — when set, claude is spawned with
     *  `--resume <id>` so the interactive REPL continues the same
     *  conversation the bubble UI was showing. */
    resumeSessionId?: string,
    forceNew?: boolean,
    /** Optional agent profile name. When set, the child is spawned with
     *  `HOME=~/.aura/agent-profiles/<name>/` so Claude/Gemini/Codex see
     *  a fresh login state. Used by "Isolated session…" picker. */
    profileName?: string,
    /** Composer Approvals chip → the agent's real permission flag for the
     *  interactive REPL (claude `--permission-mode`, gemini `--approval-mode`,
     *  codex sandbox). "bypassPermissions" launches the wrapped agent with
     *  full autonomy so it acts like a normal Claude Code session instead of
     *  asking the user to run every command. Omit/"default" → no flag. */
    permissionMode?: PermissionMode,
  ) =>
    invoke<AgentSessionHandle>("agent_pty_open", {
      agentId,
      repoRoot,
      cols,
      rows,
      resumeSessionId: resumeSessionId ?? null,
      forceNew: forceNew ?? false,
      profileName: profileName ?? null,
      permissionMode: permissionMode ?? null,
    }),
  /** Live coding-agent PTY sessions in `repoRoot`, most-recently-active
   *  first. Powers the "Start in agent → hand to a running session"
   *  submenu. */
  agentPtyList: (repoRoot: string) =>
    invoke<LiveAgentSession[]>("agent_pty_list", { repoRoot }),
  agentPtySendPrompt: (sessionId: string, prompt: string) =>
    invoke<void>("agent_pty_send_prompt", { sessionId, prompt }),
  agentPtyWrite: (sessionId: string, data: number[]) =>
    invoke<void>("agent_pty_write", { sessionId, data }),
  agentPtyResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("agent_pty_resize", { sessionId, cols, rows }),
  agentPtyReplay: (sessionId: string) =>
    invoke<BlockEnvelope[]>("agent_pty_replay", { sessionId }),
  /** Raw byte replay so xterm can backfill the agent's welcome screen
   *  when the listener attaches after spawn. Returns [] if unknown. */
  agentPtyReplayBytes: (sessionId: string) =>
    invoke<number[]>("agent_pty_replay_bytes", { sessionId }),
  /** Current native window title (OSC 0/2) the agent set, or null. The
   *  agent-event store calls this once on attach so a row that mounted
   *  after the title was set still shows it; deltas arrive live on the
   *  `agent-title:<sid>` event channel. */
  agentPtyTitle: (sessionId: string) =>
    invoke<string | null>("agent_pty_title", { sessionId }),
  agentPtyIsAlive: (sessionId: string) =>
    invoke<boolean>("agent_pty_is_alive", { sessionId }),
  /** Idle/alive snapshot for the stale-watchdog chip. `idle_ms` ticks
   *  up while the child writes nothing; `alive` is the same try_wait
   *  check `agentPtyIsAlive` does. Frontend polls every few seconds
   *  and renders "Stale · Reconnect | Stop" when idle_ms >= 45_000
   *  while alive — the case where the agent's API/auth/etc. has hung
   *  without the CLI noticing. */
  agentPtyIdleStatus: (sessionId: string) =>
    invoke<AgentPtyIdleStatus>("agent_pty_idle_status", { sessionId }),
  agentPtyClose: (sessionId: string) =>
    invoke<void>("agent_pty_close", { sessionId }),
  /** Enumerate every live agent PTY the shell could resume. Called on
   *  startup after an auto-update relaunch: daemon-owned sessions
   *  (kind = "daemon") survive shell restarts, so the frontend can
   *  surface them as reattach candidates. In-process sessions
   *  (kind = "in_process") never appear in a freshly-launched shell;
   *  they're returned only so a pre-relaunch UI listing has the same
   *  shape as the post-relaunch one. */
  ptyListAlive: () => invoke<LivePtySession[]>("pty_list_alive"),
  /** Pre-relaunch handshake. Invoked from updater.ts immediately
   *  before `relaunch()` so the aura-pty-daemon (if running) can
   *  acknowledge how many sessions it will keep alive across the
   *  restart. Returns the count; throws when the daemon is
   *  unreachable so callers can warn the user. */
  ptyPreRelaunchSignal: () => invoke<number>("pty_pre_relaunch_signal"),

  // ─ Terminal panel (VS Code parity) ──────────────────────────────────
  /** Live PLAIN-shell sessions (daemon-hosted) the panel can reconnect
   *  to after a restart. Empty when the daemon is off. */
  ptyListAlivePlain: () => invoke<LivePlainPtySession[]>("pty_list_alive_plain"),
  /** Raw scrollback bytes retained for a live plain session, so a
   *  remounting xterm backfills the screen instead of starting blank. */
  ptyReplayBytes: (id: string) => invoke<number[]>("pty_replay_bytes", { id }),
  /** Persist a terminal's serialized scrollback for COLD restore (no
   *  live process). `repoRoot` keys the on-disk dir; `text` is the
   *  xterm SerializeAddon dump, encoded to bytes (the backend gzips). */
  ptyScrollbackSave: (repoRoot: string, termId: string, text: string) =>
    invoke<void>("pty_scrollback_save", {
      repoRoot,
      termId,
      data: Array.from(new TextEncoder().encode(text)),
    }),
  /** Load cold-restore scrollback for a tab. Returns "" on miss. */
  ptyScrollbackLoad: (repoRoot: string, termId: string) =>
    invoke<string>("pty_scrollback_load", { repoRoot, termId }),
  /** GC scrollback files whose termId is no longer in the live tab set. */
  ptyScrollbackPrune: (repoRoot: string, keepTermIds: string[]) =>
    invoke<void>("pty_scrollback_prune", { repoRoot, keepTermIds }),
  /** Recent commands captured from this terminal's OSC-133 marks. */
  ptyRecentCommands: (id: string) =>
    invoke<RecentCommand[]>("pty_recent_commands", { id }),
  terminalProfileList: () => invoke<TerminalProfile[]>("terminal_profile_list"),
  terminalProfileGet: (id: string) =>
    invoke<TerminalProfile | null>("terminal_profile_get", { id }),
  terminalProfileDefault: () =>
    invoke<string | null>("terminal_profile_default"),
  terminalProfileSetDefault: (id: string) =>
    invoke<void>("terminal_profile_set_default", { id }),

  // ─ Profiles ─────────────────────────────────────────────────────────
  // Agent profile = isolated HOME (~/.aura/agent-profiles/<name>/) so the
  // spawned CLI sees a fresh login state. Git profile = named
  // {user_name,user_email,signing_key?} bound to a workspace; PTY spawn
  // injects GIT_AUTHOR_*/COMMITTER_* env when set.
  // OpenAI-compatible adapter — Ollama / HF Inference / Together / Groq
  // / OpenRouter / any self-hosted vLLM. Profiles live in
  // `~/.aura/agents/openai-compat.json`; `openai_compat_chat` streams
  // `openai-compat:chunk:<profile_name>` events as the upstream SSE
  // arrives. See `cmd_openai_compat.rs` for the wire contract.
  openaiCompatProfilesList: () =>
    invoke<OpenAiCompatProfile[]>("openai_compat_profiles_list"),
  openaiCompatProfileSave: (profile: OpenAiCompatProfile) =>
    invoke<OpenAiCompatProfile[]>("openai_compat_profile_save", { profile }),
  openaiCompatProfileRemove: (name: string) =>
    invoke<OpenAiCompatProfile[]>("openai_compat_profile_remove", { name }),
  openaiCompatTest: (name: string) =>
    invoke<OpenAiCompatTestResult>("openai_compat_test", { name }),
  openaiCompatChat: (
    profileName: string,
    turnId: string,
    messages: OpenAiCompatChatMessage[],
  ) =>
    invoke<void>("openai_compat_chat", {
      profileName,
      turnId,
      messages,
    }),
  openaiCompatCancel: (profileName: string, turnId: string) =>
    invoke<void>("openai_compat_cancel", { profileName, turnId }),

  agentProfileList: () =>
    invoke<AgentProfile[]>("agent_profile_list"),
  agentProfileCreate: (name: string, label?: string) =>
    invoke<AgentProfile>("agent_profile_create", { name, label: label ?? null }),
  agentProfileDelete: (name: string) =>
    invoke<void>("agent_profile_delete", { name }),
  gitProfileList: () => invoke<GitProfile[]>("git_profile_list"),
  gitProfileUpsert: (profile: GitProfile) =>
    invoke<GitProfile>("git_profile_upsert", { profile }),
  gitProfileDelete: (id: string) =>
    invoke<void>("git_profile_delete", { id }),
  workspaceProfileGet: (repoRoot: string) =>
    invoke<WorkspaceBinding>("workspace_profile_get", { repoRoot }),
  workspaceProfileSet: (
    repoRoot: string,
    binding: WorkspaceBinding,
    scope: "repo" | "global",
  ) =>
    invoke<WorkspaceBinding>("workspace_profile_set", {
      repoRoot,
      binding,
      scope,
    }),

  // Native `/resume` data source — lists past Claude Code sessions for
  // a workspace by reading ~/.claude/projects/<encoded-cwd>/*.jsonl.
  // Sorted newest-first. Used by ResumeDialog to render a picker
  // without spawning a TUI.
  claudeListSessions: (repoRoot: string) =>
    invoke<ClaudeSession[]>("claude_list_sessions", { repoRoot }),

  // Latest Claude subscription usage (5-hour + weekly rate-limit %) the CLI
  // statusline recorded. `null` when there's no recent reading. Real data —
  // read from `~/.aura/usage/statusline.jsonl`, never estimated.
  claudeUsageSnapshot: () =>
    invoke<ClaudeUsageSnapshot | null>("claude_usage_snapshot"),

  // Read a Claude Code session JSONL and reduce it to the same
  // StreamEvent shape the live wire emits, so the bubble view can
  // replay a resumed conversation in-pane without re-running claude.
  // `limit` keeps only the last N events (0 = unbounded).
  claudeLoadSession: (filePath: string, limit = 500) =>
    invoke<StreamEvent[]>("claude_load_session", { filePath, limit }),

  // Live-tail a Claude Code session JSONL file. Spawns a backend task
  // that polls the file every 500ms and emits parsed StreamEvents on
  // the `claude-session:<sessionId>` Tauri channel. Used by PtySurface
  // to keep the chat-bubble UI view in sync with what the user sees in
  // the raw terminal.
  claudeSessionWatch: (sessionId: string, filePath: string) =>
    invoke<void>("claude_session_watch", { sessionId, filePath }),
  claudeSessionUnwatch: (sessionId: string) =>
    invoke<void>("claude_session_unwatch", { sessionId }),

  // Prior conversation for a resumed agent tab. The CLIs load context on
  // --resume but don't replay turns visually, so we read their own
  // transcript file and show it as a collapsible pre-roll above the PTY.
  agentHistoryPreroll: (agentId: string, repoRoot: string, sessionId: string) =>
    invoke<PrerollTurn[]>("agent_history_preroll", {
      agentId,
      repoRoot,
      sessionId,
    }),

  // Stream-mode agent surface — non-interactive one-shot per turn that
  // emits typed JSONL events on `agent-stream:<agent>@<root>`. This is
  // the default for the Composer "Send" button; it produces the clean
  // bubble UI used by Cline / Continue / opencode. Multi-turn = pass
  // back the session_id from the previous turn's `system_init` event.
  agentStreamSend: (
    agentId: string,
    repoRoot: string,
    prompt: string,
    resumeSession: string | null,
    attachments?: ImageAttachment[],
    permissionMode?: PermissionMode,
    effort?: ReasoningEffort | null,
    fast?: boolean,
  ) =>
    invoke<TurnHandle>("agent_stream_send", {
      agentId,
      repoRoot,
      prompt,
      resumeSession,
      attachments: attachments ?? null,
      permissionMode: permissionMode ?? null,
      effort: effort ?? null,
      fast: fast ?? null,
    }),
  agentStreamInterrupt: (channel: string) =>
    invoke<boolean>("agent_stream_interrupt", { channel }),
  permissionRespond: (
    promptId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
  ) =>
    invoke<void>("permission_respond", {
      promptId,
      decision,
      updatedInput: updatedInput ?? null,
    }),

  // Aura engine surface
  auraRecentBlocks: (limit: number) =>
    invoke<AuraBlock[]>("aura_recent_blocks", { limit }),
  auraCli: (repoRoot: string, args: string[]) =>
    invoke<CliResult>("aura_cli", { repoRoot, args }),
  // ── Semantic CI ───────────────────────────────────────────────────────
  // Run the declared .aura/pipelines for a trigger and parse the JSON the CLI
  // emits into typed PipelineRuns for the Checks surface. Mirrors how
  // ReviewDialog drives `pr-review --json`. Returns [] on any parse/CLI error
  // so the pane shows the empty state rather than throwing.
  getChecks: async (
    repoRoot: string,
    trigger: CiTrigger,
    base?: string,
  ): Promise<CiPipelineRun[]> => {
    const args = ["ci", "run", "--trigger", trigger, "--json"];
    if (base) {
      args.push("--base", base);
    }
    const res = await invoke<CliResult>("aura_cli", { repoRoot, args });
    try {
      const parsed = JSON.parse(res.stdout) as CiPipelineRun[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },
  // Write a .github/workflows/aura.yml that runs the SAME pipeline in the
  // cloud on every PR — the "Run these in the cloud" affordance in the pane.
  exportChecks: (repoRoot: string, out?: string) =>
    invoke<CliResult>("aura_cli", {
      repoRoot,
      args: out ? ["ci", "export", "--out", out] : ["ci", "export"],
    }),
  // ── No-MCP capture gate (Settings → Capture) ──────────────────────────
  // Per-repo capture state: capture is on exactly when Aura's git hooks are
  // installed in this workspace (distinct from auraStatus, which reports the
  // global ~/.aura blockstore). Read-only probe; enable/disable run through
  // `aura enable` / `aura disable` via auraCli so the hook-install logic lives
  // only in the CLI's HookInstaller. The desktop twin of the VS Code gate.
  captureStatus: (repoRoot: string) =>
    invoke<CaptureStatus>("aura_capture_status", { repoRoot }),
  captureEnable: (repoRoot: string) =>
    invoke<CliResult>("aura_cli", { repoRoot, args: ["enable"] }),
  captureDisable: (repoRoot: string) =>
    invoke<CliResult>("aura_cli", { repoRoot, args: ["disable"] }),
  // collab=true → `aura live start --collab`: the whole-file CRDT becomes
  // the sole disk writer (M1) so the tree syncs without git. The desktop
  // Go Live always passes true; plain function-body live-sync (collab
  // omitted/false) stays a terminal-only mode.
  auraLiveStart: (repoRoot: string, collab = false) =>
    invoke<AuraLiveProcessStatus>("aura_live_start", { repoRoot, collab }),
  auraLiveStop: (repoRoot: string) =>
    invoke<AuraLiveProcessStatus>("aura_live_stop", { repoRoot }),
  auraLiveStatus: (repoRoot: string) =>
    invoke<AuraLiveProcessStatus>("aura_live_status", { repoRoot }),
  // Cross-machine presence for the Go Live peers list — reads the cloud
  // roster the live daemon heartbeats into (sentinel claims are local-only).
  auraLivePeers: (repoRoot: string) =>
    invoke<AuraLivePeersResult>("aura_live_peers", { repoRoot }),
  // Team Radar (awareness plane). The CLI does the scoring + noise-damping;
  // this just ferries the JSON. `includePossible` adds the weak callgraph
  // ripple tier (off by default, mirroring `radar conflicts --all`).
  auraRadar: (repoRoot: string, includePossible = false) =>
    invoke<RadarView>("aura_radar", { repoRoot, includePossible }),
  auraLogIntent: (
    repoRoot: string,
    intent: string,
    agentId?: string,
    changeset?: IntentChangeset,
    claudeSessionId?: string,
  ) =>
    invoke<number>("aura_log_intent", {
      repoRoot,
      intent,
      agentId,
      changeset: changeset ?? null,
      claudeSessionId: claudeSessionId ?? null,
    }),
  // `aura_intent_recent` returns the raw intent log, which now also carries
  // autonomous agent-event captures (agent_id/source "hook_auto") — one row
  // per agent tool call recorded by the safety control plane (doc 23), e.g.
  // "running Read on foo.png" or "running Bash on screencapture …". Those are
  // telemetry, not sessions/intents, so we strip them at the data boundary.
  // Every Trace surface (Sessions, Overview, aura card, intent split/merge)
  // funnels through this method, so one filter here keeps them all clean.
  //
  // We ALSO strip Aura's own bookkeeping out of every changeset here: `.aura/…`
  // intent logs and `.entire/…` object-store shards are not part of the
  // project's story, and counting them bloats every file count / churn total /
  // sparkline with thousands of phantom lines (a single commit can show
  // +387540 lines dominated by `.entire/…/full.jsonl` shards). Doing it once at
  // the boundary means the Timeline, Sessions, SessionDetail, contributions
  // scatter, Time machine, edit panel — every consumer of `changeset.files` —
  // sees only real code without each having to re-filter.
  auraIntentRecent: (repoRoot: string, limit?: number) =>
    invoke<IntentRow[]>("aura_intent_recent", {
      repoRoot,
      limit: limit ?? null,
    }).then((rows) =>
      rows
        .filter(
          (r) =>
            r.agent_id !== AUTO_CAPTURE_AGENT_ID &&
            r.source !== AUTO_CAPTURE_AGENT_ID,
        )
        .map((r) => stripToolMetadataFromRow(r)),
    ),
  auraIntentCoverage: (repoRoot: string, dirtyPaths: string[]) =>
    invoke<IntentCoverage>("aura_intent_coverage", { repoRoot, dirtyPaths }),
  auraIntentAttribute: (
    repoRoot: string,
    filePaths: string[],
    intentTs?: number,
  ) =>
    invoke<number>("aura_intent_attribute", {
      repoRoot,
      filePaths,
      intentTs: intentTs ?? null,
    }),
  auraIntentSplit: (
    repoRoot: string,
    intentTs: number,
    keepFiles: string[],
    moveFiles: string[],
    newIntent: string,
  ) =>
    invoke<number>("aura_intent_split", {
      repoRoot,
      intentTs,
      keepFiles,
      moveFiles,
      newIntent,
    }),
  auraIntentMerge: (repoRoot: string, intentTsA: number, intentTsB: number) =>
    invoke<number>("aura_intent_merge", { repoRoot, intentTsA, intentTsB }),
  /** Read aura strict-mode posture from `~/.aura/credentials.json`.
   *  "off" = guard disabled, "on" = enabled, "locked" = passcode set
   *  (only a human with the passcode can flip it back). Used by the
   *  StatusBar pill, SessionInfoCard pill, and the commit guard. */
  auraStrictMode: () => invoke<StrictModeInfo>("aura_strict_mode"),
  /** Take a durable snapshot of `filePath` so `aura rewind` can recover
   *  it. Fired non-blocking from `agentStreamStore.applyEvent` whenever
   *  Claude triggers an Edit/Write/MultiEdit tool — failures are
   *  logged-only so a snapshot miss never stalls the live stream. */
  auraSnapshot: (repoRoot: string, filePath: string) =>
    invoke<void>("aura_snapshot", { repoRoot, filePath }),

  // ── Agent Mutation Guard (v0.2.11+) ───────────────────────────────
  // Boots a per-workspace notify watcher that flags any FS mutation
  // that happens while an agent PTY is alive AND no `aura_log_intent`
  // covers the path within the freshness window. Emits
  // `aura:agent-mutation-unattributed` with `UnattributedMutation`
  // rows; the UnattributedChangesBanner consumes them.
  agentGuardStart: (repoRoot: string) =>
    invoke<void>("agent_guard_start", { repoRoot }),
  agentGuardStop: (repoRoot: string) =>
    invoke<void>("agent_guard_stop", { repoRoot }),
  /** Restore `filePath` from its most-recent `.aura/snapshots/*.json`
   *  blob. Returns the snapshot id used. Errors if no snapshot exists
   *  for that file. Called by the banner's "Revert" action. */
  agentGuardRevertFromSnapshot: (repoRoot: string, filePath: string) =>
    invoke<string>("agent_guard_revert_from_snapshot", { repoRoot, filePath }),
  /** Banner "Accept" action: takes a post-hoc snapshot and appends an
   *  intent row claiming the file. Returns the intent timestamp. */
  agentGuardAcceptWithIntent: (
    repoRoot: string,
    filePath: string,
    intent: string,
    agentId?: string,
  ) =>
    invoke<number>("agent_guard_accept_with_intent", {
      repoRoot,
      filePath,
      intent,
      agentId,
    }),
  /** Manager-side self-heal: when one-or-more mutations land without
   *  intent, ask the most recent agent CLI in this repo to call
   *  `aura_log_intent`. The backend coalesces a list of files into a
   *  single PTY prompt and applies a per-session cooldown so the agent
   *  isn't spammed when many files change at once. Returns the nudged
   *  session (or `null` if no live session was found — frontend then
   *  escalates immediately). `skipped: true` means the cooldown was
   *  active and no prompt was written. */
  agentGuardSelfHealNudge: (
    repoRoot: string,
    files: Array<{ path: string; kind: "create" | "modify" | "remove" }>,
  ) =>
    invoke<{
      session_id: string;
      agent_id: string;
      skipped: boolean;
      file_count: number;
    } | null>("agent_guard_self_heal_nudge", { repoRoot, files }),
  /** Poll after a self-heal nudge: did the agent log intent that now
   *  covers this file? True = silently dismiss; false = escalate to
   *  the red banner. */
  agentGuardIntentCovers: (repoRoot: string, filePath: string) =>
    invoke<boolean>("agent_guard_intent_covers", { repoRoot, filePath }),

  /** Make an opened repo a live Aura repo — silent + idempotent, safe to
   *  call on every repo focus. Turns on passive capture (`aura enable`),
   *  wires the agent CLIs (MCP + hooks) so any agent editing here logs
   *  intent, and keeps Aura's footprint out of `git status` via
   *  `.git/info/exclude`. For a non-git folder, returns `is_git:false` +
   *  a `detail` line the UI turns into a one-click enable notice. */
  auraEnsureTracked: (repoRoot: string) =>
    invoke<AuraTrackStatus>("aura_ensure_tracked", { repoRoot }),
  /** The non-git escape hatch: the user's click IS the consent to create
   *  git history here. Runs `git init`, then the normal ensure pass. */
  auraGitInitAndTrack: (repoRoot: string) =>
    invoke<AuraTrackStatus>("aura_git_init_and_track", { repoRoot }),

  // Op log + undo (jj-style). Every mutating engine call writes a
  // record to `.aura/op_log.jsonl` with an opaque `undo_payload`.
  // `aura_undo_last` reverses the most recent un-undone op (or a
  // specific one by id) and stamps `undone_at` on it.
  auraOpRecent: (repoRoot: string, limit?: number) =>
    invoke<OpEntry[]>("aura_op_recent", { repoRoot, limit: limit ?? null }),
  auraUndoLast: (repoRoot: string, opId?: string) =>
    invoke<string>("aura_undo_last", { repoRoot, opId: opId ?? null }),

  // jj-style ConflictedNode store at .aura/conflicts.jsonl. These
  // are durable AST-level conflict objects that survive ribbon
  // dismissal — distinct from `aura_list_conflicts` which scans
  // sentinel + git markers as transient signals.
  auraConflictsList: (repoRoot: string) =>
    invoke<ConflictedNode[]>("aura_conflicts_list", { repoRoot }),
  auraConflictsRecord: (repoRoot: string, args: RecordConflictArgs) =>
    invoke<ConflictedNode>("aura_conflicts_record", { repoRoot, args }),
  auraConflictsResolve: (repoRoot: string, args: ResolveConflictArgs) =>
    invoke<ConflictedNode>("aura_conflicts_resolve", { repoRoot, args }),

  // jj-style change_id: stable id for a "logical change" that survives
  // commit-sha rotation (amend, sign, re-sign). Derived shell-locally
  // from intent + tree hash; ProvenanceReplay shows commits grouped
  // by change_id stripe.
  auraChangesResolve: (repoRoot: string, commitSha: string) =>
    invoke<ChangeIdRow>("aura_changes_resolve", { repoRoot, commitSha }),
  auraChangesList: (repoRoot: string, commitShas: string[]) =>
    invoke<ChangeIdRow[]>("aura_changes_list", { repoRoot, commitShas }),

  // Deterministic per-file change notes (what / why / where it affects) for a
  // commit, derived from the AST diff + reverse call graph. No AI tokens.
  auraChangeNote: (repoRoot: string, sha?: string) =>
    invoke<ChangeNoteReport>("aura_change_note", { repoRoot, sha }),

  /** Blast radius for one symbol — who depends on it + which user-facing
   *  features ride on it, from `aura impact <symbol> <file> --json`. Powers the
   *  "N things depend on this" pre-flight before a surgical Rewind. `file` may
   *  be repo-relative or absolute. Deterministic — no AI tokens. */
  auraSymbolImpact: (repoRoot: string, symbol: string, file: string) =>
    invoke<SymbolImpact>("aura_symbol_impact", { repoRoot, symbol, file }),

  // ── Slash-command structured backends (/doctor /zones /taste /review) ──
  // Each runs the matching `aura … --json` subcommand (or reads local state)
  // and returns the engine's report verbatim, so the chat slash layer can
  // format a clean plain-language card instead of dumping raw CLI text. The
  // schemas live in the engine; the TS types below mirror them.

  // /doctor — REPO-HEALTH doctor (`aura doctor --json`): a read-only report
  // (stuck sessions, orphaned/oversized snapshots, hooks, shadow branch,
  // signing key, cloud rotation drift, skill ledger, replay orphans,
  // plugins). JSON mode performs NO repairs. On a large repo the
  // shadow-checkpoint walk can take a few seconds.
  auraDoctorJson: (repoRoot: string) =>
    invoke<DoctorReport>("aura_doctor_json", { repoRoot }),

  // The staged intent gate — `aura verify-intent --staged --json`. Compares
  // the approved baseline tree against the git index and returns the same
  // verdict the pre-commit hook acts on. `null` means this repository has no
  // approved contract, which is a pass, not a failure.
  verifyIntentStaged: (repoRoot: string) =>
    invoke<IntentVerdict | null>("verify_intent_staged", { repoRoot }),

  // What the agent was authorised to change, recorded before it ran.
  intentContractShow: (repoRoot: string) =>
    invoke<IntentContract | null>("intent_contract_show", { repoRoot }),

  // Put one deleted symbol back from the approved baseline, stage it, and
  // re-verify. Leaves every other edit the agent made in place — the point is
  // that the requested cleanup survives while the unrequested deletion does not.
  restoreDeletedSymbol: (repoRoot: string, symbol: string) =>
    invoke<RestoreResult>("restore_deleted_symbol", { repoRoot, symbol }),

  // Widen the contract deliberately. The amendment is recorded next to the
  // code, which is what makes it different from skipping the hook.
  approveSymbolRemoval: (repoRoot: string, symbol: string) =>
    invoke<IntentVerdict>("approve_symbol_removal", { repoRoot, symbol }),

  // A test result somebody recorded, not one we ran. `null` when nobody did,
  // so the verification screen can stay silent rather than print a number it
  // never saw.
  recordedTestSummary: (repoRoot: string) =>
    invoke<string | null>("recorded_test_summary", { repoRoot }),

  // /zones — local sentinel zones/claims for this repo ("who claimed what"),
  // read straight off .aura/sentinel/zones (no network, no cloud session).
  // Same shape as `zoneList`; named for the slash layer.
  auraZonesJson: (repoRoot: string) =>
    invoke<ZoneRule[]>("aura_zones_json", { repoRoot }),

  // /taste — learned project taste rules (`aura taste list --json`): the
  // mined coding-pattern rules with statement, language, layer, confidence,
  // accept weights, status, and approval flag.
  auraTasteRules: (repoRoot: string) =>
    invoke<TasteRule[]>("aura_taste_rules", { repoRoot }),

  // /review — semantic PR review (`aura pr-review --base <base> --json`):
  // plain-language summary + humanized findings (layer violations, security,
  // drift, deletions) + per-file change intent + raw violation streams and
  // risk score. `base` defaults to "main". When the tree has no changes the
  // engine returns `{ status: "no_changes" }`.
  auraReviewJson: (repoRoot: string, base?: string) =>
    invoke<ReviewReport>("aura_review_json", { repoRoot, base }),

  // graphify port: project-wide knowledge graph (file/symbol/doc nodes
  // + calls/imports/mentions edges + label-propagation communities +
  // god/surprise flags). Cached in `.aura/kg/graph.json`; rebuild
  // when HEAD sha advances or `force=true`.
  auraKgBuild: (repoRoot: string, force: boolean) =>
    invoke<KgGraph>("aura_kg_build", { repoRoot, force }),
  auraKgLoad: (repoRoot: string) =>
    invoke<KgGraph | null>("aura_kg_load", { repoRoot }),

  // Wave C — AuraWatch background tap.
  aurawatchStart: (repoRoot: string, mode: WatchMode, preferred?: string | null) =>
    invoke<WatchStatus>("aurawatch_start", { repoRoot, mode, preferred }),
  aurawatchStop: (repoRoot: string) =>
    invoke<void>("aurawatch_stop", { repoRoot }),
  aurawatchStatus: (repoRoot: string) =>
    invoke<WatchStatus | null>("aurawatch_status", { repoRoot }),
  aurawatchSetMode: (repoRoot: string, mode: WatchMode) =>
    invoke<WatchStatus>("aurawatch_set_mode", { repoRoot, mode }),
  // Explicit "which AI fills in reasons" pick. `preferred` is
  // `agent:<kind>` for an installed coding-agent CLI, or a backend kind
  // string; null/empty clears the pick and reverts to auto-detection.
  aurawatchSetBackend: (repoRoot: string, preferred?: string | null) =>
    invoke<WatchStatus>("aurawatch_set_backend", { repoRoot, preferred }),
  aurawatchDetect: () => invoke<BackendDetection>("aurawatch_detect"),
  aurawatchNudgeAccept: (
    nudgeId: string,
    channel: string,
    text: string,
    repoRoot: string,
    agentId: string,
  ) =>
    invoke<void>("aurawatch_nudge_accept", {
      nudgeId,
      channel,
      text,
      repoRoot,
      agentId,
    }),
  aurawatchNudgeDismiss: (nudgeId: string) =>
    invoke<void>("aurawatch_nudge_dismiss", { nudgeId }),

  // .aura/* file-system surface (work-pane data sources)
  auraListWaves: (repoRoot: string) =>
    invoke<WaveFile[]>("aura_list_waves", { repoRoot }),
  auraReadImpacts: (repoRoot: string) =>
    invoke<ImpactAlert[]>("aura_read_impacts", { repoRoot }),
  auraResolveImpact: (repoRoot: string, alertId: string) =>
    invoke<void>("aura_resolve_impact", { repoRoot, alertId }),
  auraListSnapshots: (repoRoot: string) =>
    invoke<SnapshotEntry[]>("aura_list_snapshots", { repoRoot }),
  auraReadOrchestrate: (repoRoot: string) =>
    invoke<OrchAgent[]>("aura_read_orchestrate", { repoRoot }),
  auraListConflicts: (repoRoot: string) =>
    invoke<ConflictItem[]>("aura_list_conflicts", { repoRoot }),
  /** Diff totals for the footer chip. `sinceBase` (worktrees only) widens the
   *  count to ALL work since the worktree forked from its base — committed AND
   *  uncommitted — instead of just uncommitted-vs-HEAD. Omitted/false keeps the
   *  uncommitted-vs-HEAD behavior (the main checkout has no fork base). */
  gitDiffStats: (repoRoot: string, sinceBase?: boolean) =>
    invoke<DiffStats>("git_diff_stats", { repoRoot, sinceBase: sinceBase ?? null }),
  /** Per-file +/- counts. By default vs HEAD plus untracked files counted as
   *  pure additions (right-rail Changes panel `+12 -3` per row). `sinceBase`
   *  (worktrees only) widens to base→working-tree so committed work shows too. */
  gitDiffStatsPerFile: (repoRoot: string, sinceBase?: boolean) =>
    invoke<FileDiffStat[]>("git_diff_stats_per_file", {
      repoRoot,
      sinceBase: sinceBase ?? null,
    }),
  auraReadIntentLog: (repoRoot: string) =>
    invoke<IntentEntry[]>("aura_read_intent_log", { repoRoot }),
  // Cursor-paginated intent log. `beforeTs` is the boundary returned by
  // the previous page (the page's `oldest_ts`). Pass `agent` to filter to
  // a single agent_id — the backend short-circuits on it without round-
  // tripping the rest of the file.
  auraReadIntentLogV2: (
    repoRoot: string,
    limit: number,
    beforeTs?: number,
    agent?: string,
  ) =>
    invoke<IntentLogPage>("aura_read_intent_log_v2", {
      repoRoot,
      limit,
      beforeTs: beforeTs ?? null,
      agent: agent ?? null,
    }),
  auraCountIntentsToday: (repoRoot: string, agent?: string, sinceTs?: number) =>
    invoke<number>("aura_count_intents_today", {
      repoRoot,
      agent: agent ?? null,
      sinceTs: sinceTs ?? null,
    }),
  auraListSnapshotsV2: (repoRoot: string, limit: number, beforeMtime?: number) =>
    invoke<SnapshotPage>("aura_list_snapshots_v2", {
      repoRoot,
      limit,
      beforeMtime: beforeMtime ?? null,
    }),
  auraCountSnapshotsToday: (repoRoot: string, sinceTs?: number) =>
    invoke<number>("aura_count_snapshots_today", {
      repoRoot,
      sinceTs: sinceTs ?? null,
    }),
  auraReadAuditLogV2: (repoRoot: string, limit: number, beforeTs?: number) =>
    invoke<AuditLogPage>("aura_read_audit_log_v2", {
      repoRoot,
      limit,
      beforeTs: beforeTs ?? null,
    }),
  auraCountAuditUnacked: (repoRoot: string) =>
    invoke<number>("aura_count_audit_unacked", { repoRoot }),
  auraUsageSummary: (repoRoot: string) =>
    invoke<UsageSummary>("aura_usage_summary", { repoRoot }),
  promptsList: (agent?: string) =>
    invoke<SavedPrompt[]>("prompts_list", { agent: agent ?? null }),
  promptsSave: (input: {
    id?: string;
    name: string;
    description?: string;
    body: string;
    agent?: string;
  }) =>
    invoke<SavedPrompt>("prompts_save", {
      id: input.id ?? null,
      name: input.name,
      description: input.description ?? null,
      body: input.body,
      agent: input.agent ?? null,
    }),
  promptsDelete: (id: string) => invoke<void>("prompts_delete", { id }),
  promptsRecordUse: (id: string) =>
    invoke<void>("prompts_record_use", { id }),
  /** Run `aura usage <period> --json --project` against `repoRoot` and
   *  return a typed slice of the report — total cost + token splits +
   *  per-model breakdown. Used by ManagerSurface to surface live token
   *  spend without piping through a dedicated Tauri command. */
  auraUsageReport: async (
    repoRoot: string,
    period: "today" | "week" | "month" | "all" = "today",
  ): Promise<UsageReport | null> => {
    try {
      const res = await invoke<CliResult>("aura_cli", {
        repoRoot,
        args: ["usage", period, "--json", "--project"],
      });
      if (res.status !== 0 || !res.stdout.trim()) return null;
      const json = JSON.parse(res.stdout) as RawUsageReport;
      return {
        period: json.period,
        totalCostUsd: json.total.cost_usd,
        totalInputTokens: json.total.input_tokens,
        totalOutputTokens: json.total.output_tokens,
        totalCacheReadTokens: json.total.cache_read_tokens,
        sessionCount: json.total.sessions,
        byModel: (json.by_model ?? []).map((m) => ({
          model: m.model,
          inputTokens: m.input_tokens,
          outputTokens: m.output_tokens,
          costUsd: m.cost_usd,
          sessions: m.sessions,
        })),
        byDeveloper: (json.by_developer ?? []).map((d) => ({
          month: d.month,
          developer: d.developer,
          handle: d.handle ?? "",
          agentId: d.agent_id,
          inputTokens: d.input_tokens,
          outputTokens: d.output_tokens,
          costUsd: d.cost_usd,
          sessions: d.sessions,
        })),
      };
    } catch {
      return null;
    }
  },
  gitRecentCommits: (repoRoot: string, limit: number) =>
    invoke<CommitEntry[]>("git_recent_commits", { repoRoot, limit }),
  /** Full all-branch commit topology for the Source Control graph rail. */
  gitCommitGraph: (repoRoot: string, limit: number) =>
    invoke<GraphCommit[]>("git_commit_graph", { repoRoot, limit }),
  gitContributors: (repoRoot: string) =>
    invoke<GitContributor[]>("git_contributors", { repoRoot }),

  // Cloud auth (device-code flow against aura-cloud). `provider` is an
  // optional OAuth hint (github | gitlab | google) the server forwards onto
  // the verify URL so the web sign-in can route straight to that provider.
  cloudAuthStart: (cloudUrl?: string, provider?: string) =>
    invoke<CloudStartResp>("cloud_auth_start", {
      cloudUrl: cloudUrl ?? null,
      provider: provider ?? null,
    }),
  cloudAuthPoll: (deviceCode: string, cloudUrl?: string) =>
    invoke<CloudPollResp>("cloud_auth_poll", {
      deviceCode,
      cloudUrl: cloudUrl ?? null,
    }),
  cloudAuthStatus: () => invoke<CloudAuthStatus>("cloud_auth_status"),
  cloudAuthLogout: () => invoke<void>("cloud_auth_logout"),
  // Scan-to-pair: mint a QR the Aura mobile app scans to authenticate. The
  // desktop must already be signed in (it self-approves the device request).
  cloudPairCreate: (cloudUrl?: string) =>
    invoke<CloudPairResp>("cloud_pair_create", { cloudUrl: cloudUrl ?? null }),

  // Per-install anonymous identity + repo-derived room id (used by the
  // loginless WS chat — every clone of the same upstream repo derives
  // the same id locally, so the cloud relay can fan messages out to all
  // peers without auth).
  deviceIdentity: () =>
    invoke<{ device_id: string; display_name: string; email: string }>(
      "device_identity",
    ),
  // Repo-aware identity — use this anywhere chat/voice/presence need to
  // appear under the same name (i.e. git log + chat + huddle parity).
  // Falls back to the global identity when the repo has no local
  // user.{name,email} set, so single-account users see no change.
  deviceIdentityForRepo: (repoRoot: string) =>
    invoke<{ device_id: string; display_name: string; email: string }>(
      "device_identity_for_repo",
      { repoRoot },
    ),
  deviceUpdate: (displayName?: string, email?: string) =>
    invoke<{ device_id: string; display_name: string; email: string }>(
      "device_update",
      { displayName: displayName ?? null, email: email ?? null },
    ),
  deviceRoomId: (repoRoot: string) =>
    invoke<string>("device_room_id", { repoRoot }),
  auraGlobalRoomId: () => invoke<string>("aura_global_room_id"),
  /**
   * The cloud bearer, if the user is signed in — for the room surfaces that
   * live in JS (chat/pages WebSockets, reaction + pages-collab REST) which
   * Rust can't attach a header to on their behalf. `null` when signed out.
   * Prefer the cached `roomTokenQuery` / `roomAuthHeaders` helpers in
   * `roomAuth.ts` over calling this directly.
   */
  cloudRoomToken: () => invoke<string | null>("cloud_room_token"),

  // Team + chat (file-backed, git-derived identity)
  teamLoad: (repoRoot: string) =>
    invoke<TeamManifest>("team_load", { repoRoot }),
  /** Auto-populate the roster from the repo's GitHub collaborators with
   *  edit rights, so people who can contribute show up before their first
   *  commit. Throttled (5 min) unless `force`; best-effort and degrades to
   *  the plain git-derived roster off GitHub / without `gh`. */
  teamSyncCollaborators: (repoRoot: string, force?: boolean) =>
    invoke<TeamManifest>("team_sync_collaborators", { repoRoot, force }),
  teamIdentity: (repoRoot: string) =>
    invoke<TeamIdentity>("team_identity", { repoRoot }),
  teamClaim: (repoRoot: string) =>
    invoke<TeamManifest>("team_claim", { repoRoot }),
  /** Promote/demote a member's advisory admin flag. Admin-only; refuses
   *  to strip the last admin or demote the repo owner. Returns the
   *  updated manifest. */
  teamSetAdmin: (repoRoot: string, targetEmail: string, admin: boolean) =>
    invoke<TeamManifest>("team_set_admin", { repoRoot, targetEmail, admin }),
  /** Hand admin to another member and step down, atomically. Admin-only.
   *  The recipient's seat is marked claimed. Returns the updated manifest. */
  teamTransferAdmin: (repoRoot: string, toEmail: string) =>
    invoke<TeamManifest>("team_transfer_admin", { repoRoot, toEmail }),
  identityOverrideGet: (repoRoot: string) =>
    invoke<IdentityOverride | null>("identity_override_get", { repoRoot }),
  identityOverrideSet: (
    repoRoot: string,
    handle: string,
    name: string,
    email: string,
  ) =>
    invoke<void>("identity_override_set", {
      repoRoot,
      handle,
      name,
      email,
    }),
  identityOverrideClear: (repoRoot: string) =>
    invoke<void>("identity_override_clear", { repoRoot }),
  /** Every self-picked profile photo, keyed by lowercased email → `data:` URL.
   *  Resolve a member against this first, then their GitHub avatar, then the
   *  animal monogram. Local to this machine; never in a repo. */
  identityAvatarsGet: () =>
    invoke<Record<string, string>>("identity_avatars_get"),
  /** Attach a photo to `email` from a file the user picked. Returns the stored
   *  `data:` URL so the caller can show it without re-fetching the whole map. */
  identityAvatarSetFromPath: (email: string, path: string) =>
    invoke<string>("identity_avatar_set_from_path", { email, path }),
  /** Drop a person's photo — they fall back to GitHub avatar / animal again. */
  identityAvatarClear: (email: string) =>
    invoke<void>("identity_avatar_clear", { email }),
  teamAliasAdd: (
    repoRoot: string,
    targetHandle: string,
    aliasEmail: string,
  ) =>
    invoke<TeamManifest>("team_alias_add", {
      repoRoot,
      targetHandle,
      aliasEmail,
    }),
  /** Drop a previously-linked alias. Mirrors `teamAliasAdd` with the
   *  same admin/self-owner authorisation; removing an absent alias is
   *  idempotently successful. */
  teamAliasRemove: (
    repoRoot: string,
    targetHandle: string,
    aliasEmail: string,
  ) =>
    invoke<TeamManifest>("team_alias_remove", {
      repoRoot,
      targetHandle,
      aliasEmail,
    }),
  /** Resolve an arbitrary email through the team's primary+alias map.
   *  Returns the canonical handle, or null when nobody claims the
   *  address (caller should fall back to the email-local-part default).
   *  Used by receive-side routing (typing/reactions) to attribute
   *  inbound events to the right roster entry. */
  canonicalHandleForEmail: (repoRoot: string, email: string) =>
    invoke<string | null>("canonical_handle_for_email", { repoRoot, email }),
  /** Propose likely-duplicate member groups (one human enrolled under two+
   *  emails / a GitHub collaborator seat) for the roster's review banner. The
   *  auto-merge only fuses on globally-unique links; this weak-signal layer
   *  surfaces name / email-stem matches for a human to confirm. Read-only. */
  teamIdentitySuggestDuplicates: (repoRoot: string) =>
    invoke<DuplicateSuggestion[]>("team_identity_suggest_duplicates", {
      repoRoot,
    }),
  /** Confirm a suggestion — fold every `mergedEmails` row into `survivorEmail`
   *  via the alias path, then collapse. Admin, or one of the involved people. */
  teamIdentityConfirmDuplicate: (
    repoRoot: string,
    survivorEmail: string,
    mergedEmails: string[],
  ) =>
    invoke<TeamManifest>("team_identity_confirm_duplicate", {
      repoRoot,
      survivorEmail,
      mergedEmails,
    }),
  /** Reject a suggestion — record that the two emails are DIFFERENT people so
   *  the pair is never suggested again. Never merges anything. */
  teamIdentityRejectDuplicate: (
    repoRoot: string,
    emailA: string,
    emailB: string,
  ) =>
    invoke<TeamManifest>("team_identity_reject_duplicate", {
      repoRoot,
      emailA,
      emailB,
    }),
  teamStatusGet: () => invoke<TeamStatus>("team_status_get"),
  teamStatusSet: (activityText: string | null, statusEmoji: string | null) =>
    invoke<TeamStatus>("team_status_set", {
      activityText,
      statusEmoji,
    }),
  // Set (or clear, by passing null) the channel slug this desktop is
  // currently in voice on. Triggers an immediate presence beacon so
  // teammates see the join/leave without waiting for the periodic tick.
  teamVoiceSet: (repoRoot: string, channel: string | null) =>
    invoke<void>("team_voice_set", { repoRoot, channel }),
  /** Create a channel. Omit `opts` for an open channel (legacy 2-arg
   *  behaviour). Pass `{ visibility: "private", members }` to seed a
   *  private channel with an allow-list; the creator is auto-added. */
  teamChannelCreate: (
    repoRoot: string,
    name: string,
    opts?: { visibility?: "open" | "private"; members?: string[] },
  ) =>
    invoke<TeamManifest>("team_channel_create", {
      repoRoot,
      name,
      visibility: opts?.visibility ?? null,
      members: opts?.members ?? null,
    }),
  /** Update a channel's visibility and/or topic. Each is independently
   *  optional (null leaves it unchanged). Admin/channel-admin only. */
  teamChannelUpdate: (
    repoRoot: string,
    slug: string,
    opts: { visibility?: "open" | "private"; topic?: string | null },
  ) =>
    invoke<TeamManifest>("team_channel_update", {
      repoRoot,
      slug,
      visibility: opts.visibility ?? null,
      topic: opts.topic ?? null,
    }),
  /** Add an email to a private channel's allow-list. Admin/channel-admin only. */
  teamChannelMemberAdd: (repoRoot: string, slug: string, email: string) =>
    invoke<TeamManifest>("team_channel_member_add", { repoRoot, slug, email }),
  /** Remove an email from a private channel's allow-list. Admin/channel-admin only. */
  teamChannelMemberRemove: (repoRoot: string, slug: string, email: string) =>
    invoke<TeamManifest>("team_channel_member_remove", { repoRoot, slug, email }),
  /** Promote/demote a channel-level admin. Promoting on a private channel
   *  also adds the member to the allow-list. Admin/channel-admin only. */
  teamChannelAdminSet: (
    repoRoot: string,
    slug: string,
    email: string,
    isAdmin: boolean,
  ) =>
    invoke<TeamManifest>("team_channel_admin_set", {
      repoRoot,
      slug,
      email,
      isAdmin,
    }),
  /** Pin a custom URL tab onto a channel header. Any member (Slack-bookmark
   *  semantics); http(s) only, max 6 per channel. */
  teamChannelTabAdd: (repoRoot: string, slug: string, label: string, url: string) =>
    invoke<TeamManifest>("team_channel_tab_add", { repoRoot, slug, label, url }),
  /** Remove a custom tab by id. Any member, mirroring add. */
  teamChannelTabRemove: (repoRoot: string, slug: string, tabId: string) =>
    invoke<TeamManifest>("team_channel_tab_remove", { repoRoot, slug, tabId }),
  /** Delete a non-core channel (drops slug, meta, backing log). Admin only. */
  teamChannelDelete: (repoRoot: string, slug: string) =>
    invoke<TeamManifest>("team_channel_delete", { repoRoot, slug }),
  chatList: (
    repoRoot: string,
    channel: string,
    afterTs?: number,
    limit?: number,
  ) =>
    invoke<ChatMessage[]>("chat_list", {
      repoRoot,
      channel,
      afterTs: afterTs ?? null,
      limit: limit ?? null,
    }),
  chatSend: (args: ChatSendArgs) =>
    invoke<ChatMessage>("chat_send", {
      args: {
        repo_root: args.repoRoot,
        channel: args.channel,
        body: args.body,
        from_handle: args.fromHandle ?? null,
        from_name: args.fromName ?? null,
        thread_parent: args.threadParent ?? null,
        is_agent: args.isAgent ?? null,
      },
    }),
  chatThread: (repoRoot: string, channel: string, parentId: string) =>
    invoke<ChatMessage[]>("chat_thread", { repoRoot, channel, parentId }),
  chatOutboxStatus: (repoRoot: string, channel: string) =>
    invoke<OutboxEntry[]>("chat_outbox_status", { repoRoot, channel }),
  chatResend: (repoRoot: string, channel: string, msgId: string) =>
    invoke<void>("chat_resend", { repoRoot, channel, msgId }),
  chatSubscribeSince: (repoRoot: string, channel: string, sinceSeq: number | null) =>
    invoke<ChatMessage[]>("chat_subscribe_since", { repoRoot, channel, sinceSeq: sinceSeq ?? null }),
  chatOutboxDrainKickoff: (repoRoot: string) =>
    invoke<void>("chat_outbox_drain_kickoff", { repoRoot }),
  chatDoctor: (repoRoot: string) =>
    invoke<ChatDoctorReport>("chat_doctor", { repoRoot }),
  chatUploadAttachment: (repoRoot: string, filePath: string) =>
    invoke<ChatAttachment>("chat_upload_attachment", { repoRoot, filePath }),
  chatUploadAttachmentBytes: (
    repoRoot: string,
    bytesBase64: string,
    filename: string,
    mime: string,
  ) =>
    invoke<ChatAttachment>("chat_upload_attachment_bytes", {
      repoRoot,
      bytesBase64,
      filename,
      mime,
    }),
  chatUploadVoiceNote: (
    repoRoot: string,
    bytesBase64: string,
    filename: string,
    mime: string,
  ) =>
    invoke<ChatAttachment>("chat_upload_voice_note", {
      repoRoot,
      bytesBase64,
      filename,
      mime,
    }),

  // Soundboard — short audio clips played into a live LiveKit huddle.
  // Storage is per-repo under ~/.aura/soundboard/<repo-hash>/.
  soundboardList: (repoRoot: string) =>
    invoke<SoundboardClip[]>("soundboard_list", { repoRoot }),
  soundboardUpload: (
    repoRoot: string,
    name: string,
    ext: string,
    bytes: number[],
  ) =>
    invoke<SoundboardClip>("soundboard_upload", {
      repoRoot,
      name,
      ext,
      bytes,
    }),
  soundboardRead: (repoRoot: string, clipId: string) =>
    invoke<number[]>("soundboard_read", { repoRoot, clipId }),
  soundboardDelete: (repoRoot: string, clipId: string) =>
    invoke<void>("soundboard_delete", { repoRoot, clipId }),

  // Slack-canvas-style per-channel + team-wide notes. Plain markdown
  // files at `.aura/team/channels/<channel>.notes.md` and
  // `.aura/team/notes.md`. Committed via normal git — no cloud sync.
  channelNotesRead: (repoRoot: string, channel: string) =>
    invoke<NoteDoc>("channel_notes_read", { repoRoot, channel }),
  channelNotesWrite: (repoRoot: string, channel: string, body: string) =>
    invoke<NoteDoc>("channel_notes_write", { repoRoot, channel, body }),
  teamNotesRead: (repoRoot: string) =>
    invoke<NoteDoc>("team_notes_read", { repoRoot }),
  teamNotesWrite: (repoRoot: string, body: string) =>
    invoke<NoteDoc>("team_notes_write", { repoRoot, body }),

  // Timed-feed notes (v0.2.11). Scope is one of:
  //   "team"            — committed team-wide feed
  //   "channel:<name>"  — committed per-channel feed
  //   "user:<handle>"   — local-only personal scratchpad (~/.aura/notes/…)
  notesFeedList: (repoRoot: string, scope: string) =>
    invoke<NoteEntry[]>("notes_feed_list", { repoRoot, scope }),
  notesFeedAdd: (
    repoRoot: string,
    scope: string,
    body: string,
    authorHandle: string,
    authorName: string,
  ) =>
    invoke<NoteEntry>("notes_feed_add", {
      repoRoot,
      scope,
      body,
      authorHandle,
      authorName,
    }),
  notesFeedDelete: (repoRoot: string, scope: string, noteId: string) =>
    invoke<void>("notes_feed_delete", { repoRoot, scope, noteId }),

  // Human-task tracker (per-repo `.aura/tasks/tasks.json`)
  tasksList: (repoRoot: string) =>
    invoke<Task[]>("tasks_list", { repoRoot }),
  tasksCreate: (repoRoot: string, input: CreateTaskInput) =>
    invoke<Task>("tasks_create", { repoRoot, input }),
  tasksUpdate: (repoRoot: string, input: UpdateTaskInput) =>
    invoke<Task>("tasks_update", { repoRoot, input }),
  tasksDelete: (repoRoot: string, id: string) =>
    invoke<void>("tasks_delete", { repoRoot, id }),
  /** QQ.1 — Upsert a task by `(external_source, external_id)`. The
   *  TaskImportModal calls this once per source row; `created` in the
   *  result distinguishes new vs patched so the summary can read
   *  "imported N · updated M". */
  tasksUpsertExternal: (repoRoot: string, input: UpsertExternalTaskInput) =>
    invoke<UpsertExternalTaskResult>("tasks_upsert_external", {
      repoRoot,
      input,
    }),
  /** #218 — Pull task mutations teammates published over the live chat
   *  rail and LWW-merge them into local `tasks.json`. Returns
   *  `changed: true` when something landed so the caller can refetch
   *  `tasksList` (which re-runs the heal pipeline this apply bypasses).
   *  No-op for solo repos. */
  tasksSyncPoll: (repoRoot: string) =>
    invoke<TaskSyncPollResult>("tasks_sync_poll", { repoRoot }),

  // Sprints (per-repo `.aura/tasks/sprints.json`)
  sprintsList: (repoRoot: string) =>
    invoke<Sprint[]>("sprints_list", { repoRoot }),
  sprintsCreate: (repoRoot: string, input: SprintInput) =>
    invoke<Sprint>("sprints_create", { repoRoot, input }),
  sprintsUpdate: (repoRoot: string, input: SprintInput) =>
    invoke<Sprint>("sprints_update", { repoRoot, input }),
  sprintsDelete: (repoRoot: string, id: string) =>
    invoke<void>("sprints_delete", { repoRoot, id }),

  // Mint an A2A bead from a completed task. Returns the bead id, or
  // throws when the bead substrate isn't wired yet (see R.1 Phase 2).
  tasksMintBead: (repoRoot: string, taskId: string, content: string) =>
    invoke<string>("tasks_mint_bead", {
      repoRoot,
      input: { task_id: taskId, content },
    }),

  // Saved views (`.aura/tasks/views.json`) — OO.2 Phase 2.
  taskViewsList: (repoRoot: string) =>
    invoke<TaskView[]>("task_views_list", { repoRoot }),
  taskViewsUpsert: (repoRoot: string, input: TaskViewInput) =>
    invoke<TaskView>("task_views_upsert", { repoRoot, input }),
  taskViewsDelete: (repoRoot: string, id: string) =>
    invoke<void>("task_views_delete", { repoRoot, id }),
  taskViewsRename: (repoRoot: string, id: string, name: string) =>
    invoke<TaskView>("task_views_rename", {
      repoRoot,
      input: { id, name },
    }),

  // OO.3 — State catalog (`.aura/tasks/task_states.json`). The five
  // canonical defaults seed on first read; custom states slot in via
  // `position` between them without renumbering.
  taskStatesList: (repoRoot: string) =>
    invoke<TaskState[]>("task_states_list", { repoRoot }),
  taskStatesUpsert: (repoRoot: string, input: TaskStateInput) =>
    invoke<TaskState>("task_states_upsert", { repoRoot, input }),
  /** Deleting a state migrates its tasks to the closest sibling in the
   *  same `group`, falling back to `unstarted`. Default states are
   *  protected — the backend returns an error rather than silently
   *  no-op'ing. */
  taskStatesDelete: (repoRoot: string, id: string) =>
    invoke<void>("task_states_delete", { repoRoot, id }),

  // OO.3 — Label catalog (`.aura/tasks/task_labels.json`). Legacy
  // free-form `Task.labels` strings auto-import on first `tasks_list`
  // call; these wrappers let the UI manage the catalog explicitly.
  taskLabelsList: (repoRoot: string) =>
    invoke<TaskLabel[]>("task_labels_list", { repoRoot }),
  taskLabelsUpsert: (repoRoot: string, input: TaskLabelInput) =>
    invoke<TaskLabel>("task_labels_upsert", { repoRoot, input }),
  /** Deleting a label detaches it from every task; the legacy
   *  `Task.labels` array is rebuilt from the surviving catalog. */
  taskLabelsDelete: (repoRoot: string, id: string) =>
    invoke<void>("task_labels_delete", { repoRoot, id }),

  // ── OO.4 — Plane Cycles + Modules ─────────────────────────────────
  tasksCyclesList: (repoRoot: string) =>
    invoke<Cycle[]>("tasks_cycles_list", { repoRoot }),
  tasksCyclesUpsert: (repoRoot: string, input: CycleInput) =>
    invoke<Cycle>("tasks_cycles_upsert", { repoRoot, input }),
  tasksCyclesDelete: (repoRoot: string, id: string) =>
    invoke<void>("tasks_cycles_delete", { repoRoot, id }),
  tasksCycleAssign: (repoRoot: string, cycleId: string, taskId: string) =>
    invoke<void>("tasks_cycle_assign", { repoRoot, cycleId, taskId }),
  tasksCycleUnassign: (repoRoot: string, cycleId: string, taskId: string) =>
    invoke<void>("tasks_cycle_unassign", { repoRoot, cycleId, taskId }),
  /** BEAD-I phase 4 — Close a sprint: status → completed, `velocity`
   *  frozen on the cycle. The caller moves incomplete tasks first
   *  (assign → next / unassign → backlog) and computes the delivered
   *  figure from the done set. Returns the updated cycle. */
  tasksCycleClose: (repoRoot: string, id: string, velocity: number) =>
    invoke<Cycle>("tasks_cycle_close", { repoRoot, id, velocity }),
  tasksModulesList: (repoRoot: string) =>
    invoke<Module[]>("tasks_modules_list", { repoRoot }),
  tasksModulesUpsert: (repoRoot: string, input: ModuleInput) =>
    invoke<Module>("tasks_modules_upsert", { repoRoot, input }),
  tasksModulesDelete: (repoRoot: string, id: string) =>
    invoke<void>("tasks_modules_delete", { repoRoot, id }),
  tasksModuleAssign: (repoRoot: string, moduleId: string, taskId: string) =>
    invoke<void>("tasks_module_assign", { repoRoot, moduleId, taskId }),
  tasksModuleUnassign: (repoRoot: string, moduleId: string, taskId: string) =>
    invoke<void>("tasks_module_unassign", { repoRoot, moduleId, taskId }),

  // ── OO.5 — Sub-issues ─────────────────────────────────────────────
  /** Walk every descendant of `rootId` depth-first. Includes the root
   *  itself as the first entry so the caller can render a single
   *  tree. Returns an empty array when the root id is unknown. */
  tasksSubtree: (repoRoot: string, rootId: string) =>
    invoke<Task[]>("tasks_subtree", { repoRoot, rootId }),

  // ── OO.5 — Relations ──────────────────────────────────────────────
  tasksRelationsList: (repoRoot: string, taskId?: string) =>
    invoke<TaskRelation[]>("tasks_relations_list", {
      repoRoot,
      taskId: taskId ?? null,
    }),
  tasksRelationsForTask: (repoRoot: string, taskId: string) =>
    invoke<TaskRelation[]>("tasks_relations_for_task", { repoRoot, taskId }),
  tasksRelationsCreate: (
    repoRoot: string,
    source: string,
    target: string,
    kind: TaskRelationKind,
  ) =>
    invoke<TaskRelation>("tasks_relations_create", {
      repoRoot,
      source,
      target,
      kind,
    }),
  tasksRelationsDelete: (repoRoot: string, relationId: string) =>
    invoke<void>("tasks_relations_delete", { repoRoot, relationId }),

  // ── OO.5 — Activity log ───────────────────────────────────────────
  /** Newest-first list of activity events for a single task. When
   *  `limit` is set, returns the latest N rows; otherwise returns
   *  everything. */
  tasksActivityList: (repoRoot: string, taskId: string, limit?: number) =>
    invoke<TaskActivity[]>("tasks_activity_list", {
      repoRoot,
      taskId,
      limit: limit ?? null,
    }),
  /** Drop every activity row for the supplied task. Used by the task-
   *  delete path so deleted tasks don't leave stranded audit rows. */
  tasksActivityClear: (repoRoot: string, taskId: string) =>
    invoke<void>("tasks_activity_clear", { repoRoot, taskId }),

  // ── OO.5 — Comments ───────────────────────────────────────────────
  tasksCommentsList: (repoRoot: string, taskId: string) =>
    invoke<TaskComment[]>("tasks_comments_list", { repoRoot, taskId }),
  tasksCommentsCreate: (
    repoRoot: string,
    taskId: string,
    body: string,
    options?: { parentCommentId?: string | null; authorHandle?: string },
  ) =>
    invoke<TaskComment>("tasks_comments_create", {
      repoRoot,
      taskId,
      body,
      parentCommentId: options?.parentCommentId ?? null,
      authorHandle: options?.authorHandle ?? null,
    }),
  tasksCommentsUpdate: (repoRoot: string, id: string, body: string) =>
    invoke<TaskComment>("tasks_comments_update", { repoRoot, id, body }),
  tasksCommentsDelete: (repoRoot: string, id: string) =>
    invoke<void>("tasks_comments_delete", { repoRoot, id }),

  // ── OO.5 — Bulk operations ────────────────────────────────────────
  tasksBulkStateChange: (
    repoRoot: string,
    ids: string[],
    stateId: string,
  ) =>
    invoke<BulkOpResult>("tasks_bulk_state_change", {
      repoRoot,
      ids,
      stateId,
    }),
  tasksBulkAssign: (repoRoot: string, ids: string[], assigneeIds: string[]) =>
    invoke<BulkOpResult>("tasks_bulk_assign", {
      repoRoot,
      ids,
      assigneeIds,
    }),
  tasksBulkLabel: (repoRoot: string, ids: string[], labelIds: string[]) =>
    invoke<BulkOpResult>("tasks_bulk_label", { repoRoot, ids, labelIds }),
  tasksBulkArchive: (repoRoot: string, ids: string[]) =>
    invoke<BulkOpResult>("tasks_bulk_archive", { repoRoot, ids }),
  tasksBulkDelete: (repoRoot: string, ids: string[]) =>
    invoke<BulkOpResult>("tasks_bulk_delete", { repoRoot, ids }),

  // Team markdown notes
  notesList: (input: NoteListInput) =>
    invoke<NoteSummary[]>("notes_list", {
      input: {
        repo_root: input.repoRoot,
        scope: input.scope ?? null,
        bucket: input.bucket ?? null,
      },
    }),
  notesRead: (
    repoRoot: string,
    scope: NoteScope,
    bucket: string,
    id: string,
  ) =>
    invoke<Note>("notes_read", {
      input: { repo_root: repoRoot, scope, bucket, id },
    }),
  notesWrite: (input: NoteWriteInput) =>
    invoke<Note>("notes_write", {
      input: {
        repo_root: input.repoRoot,
        scope: input.scope,
        bucket: input.bucket ?? "",
        id: input.id ?? null,
        body: input.body,
        title: input.title ?? null,
        author: input.author ?? null,
        visibility: input.visibility ?? null,
        locked: input.locked ?? null,
        tags: input.tags ?? null,
        // null ⇒ leave the existing folder untouched (a body save never
        // re-files a page); folder moves use noteSetFolder instead.
        folder: input.folder ?? null,
      },
    }),
  notesDelete: (
    repoRoot: string,
    scope: NoteScope,
    bucket: string,
    id: string,
  ) =>
    invoke<void>("notes_delete", {
      input: { repo_root: repoRoot, scope, bucket, id },
    }),
  /** Find all notes that contain `[[title]]` references (case-insensitive). */
  notesBacklinks: (repoRoot: string, title: string) =>
    invoke<NoteSummary[]>("notes_backlinks", {
      input: { repo_root: repoRoot, title },
    }),
  /** Substring search across all notes; orders by match count + recency. */
  notesSearch: (repoRoot: string, query: string, limit?: number) =>
    invoke<NoteSearchHit[]>("notes_search", {
      input: { repo_root: repoRoot, query, limit: limit ?? null },
    }),
  /** #219 — pull shared-page mutations off the live rail and LWW-merge them
   *  into the local notes tree. Returns `changed:true` when the Pages list
   *  should be refetched. No-op for solo repos. */
  pagesSyncPoll: (repoRoot: string) =>
    invoke<PageSyncPollResult>("pages_sync_poll", { repoRoot }),

  // Page folders — lightweight, named + colored grouping for Pages. Flat
  // camelCase args (matches notesArchive / notesSetParent convention).
  noteFoldersList: (repoRoot: string, scope: NoteScope, bucket: string) =>
    invoke<Folder[]>("note_folders_list", { repoRoot, scope, bucket }),
  noteFolderCreate: (
    repoRoot: string,
    scope: NoteScope,
    bucket: string,
    name: string,
    color: string,
    parent?: string | null,
  ) =>
    invoke<Folder>("note_folder_create", {
      repoRoot,
      scope,
      bucket,
      name,
      color,
      parent: parent ?? null,
    }),
  noteFolderRename: (
    repoRoot: string,
    scope: NoteScope,
    bucket: string,
    id: string,
    name: string,
  ) =>
    invoke<Folder>("note_folder_rename", {
      repoRoot,
      scope,
      bucket,
      id,
      name,
    }),
  noteFolderSetColor: (
    repoRoot: string,
    scope: NoteScope,
    bucket: string,
    id: string,
    color: string,
  ) =>
    invoke<Folder>("note_folder_set_color", {
      repoRoot,
      scope,
      bucket,
      id,
      color,
    }),
  noteFolderReorder: (
    repoRoot: string,
    scope: NoteScope,
    bucket: string,
    orderedIds: string[],
  ) =>
    invoke<Folder[]>("note_folder_reorder", {
      repoRoot,
      scope,
      bucket,
      orderedIds,
    }),
  /** Delete a folder; its pages move to root (never deleted). Returns the ids
   *  of pages moved to root. */
  noteFolderDelete: (
    repoRoot: string,
    scope: NoteScope,
    bucket: string,
    id: string,
  ) => invoke<string[]>("note_folder_delete", { repoRoot, scope, bucket, id }),
  /** Move a page into a folder (id) or back to root (null). */
  noteSetFolder: (
    repoRoot: string,
    scope: NoteScope,
    bucket: string,
    pageId: string,
    folderId: string | null,
  ) =>
    invoke<Note>("note_set_folder", {
      repoRoot,
      scope,
      bucket,
      pageId,
      folderId,
    }),

  // Brain (v0.2.30 KK.3) — chat backend picker. The actual streaming
  // lives in the manager-stream channel; these are settings-side cmds.
  brainListDescriptors: () =>
    invoke<BrainDescriptor[]>("brain_list_descriptors"),
  brainGetSettings: () => invoke<BrainSettings>("brain_get_settings"),
  brainSetActive: (providerId: string) =>
    invoke<void>("brain_set_active", { input: { provider_id: providerId } }),
  /** Toggle ledger-driven auto-routing (see {@link BrainSettings.auto_route}). */
  brainSetAutoRoute: (enabled: boolean) =>
    invoke<void>("brain_set_auto_route", { input: { enabled } }),
  brainKeychainSet: (providerId: string, apiKey: string) =>
    invoke<void>("brain_keychain_set", {
      input: { provider_id: providerId, api_key: apiKey },
    }),
  brainKeychainDelete: (providerId: string) =>
    invoke<void>("brain_keychain_delete", {
      input: { provider_id: providerId },
    }),
  brainKeychainHas: (providerId: string) =>
    invoke<boolean>("brain_keychain_has", {
      input: { provider_id: providerId },
    }),
  /**
   * Register (or update) a custom OpenAI-compatible endpoint —
   * Kimi/Moonshot, Gemini-via-OpenAI-compat, OpenRouter, ollama, etc.
   * (WW-B0). Writes `model` + `extra.base_url` to brain_settings.json
   * and stashes `apiKey` in the OS keychain (never in plaintext; pass
   * `""` to clear, omit to leave any existing key untouched). Returns
   * the resolved `openai_compat:<slug>` provider_id, ready for
   * {@link brainSetActive} / `managerSetBrainOverride`.
   */
  brainUpsertProvider: (opts: {
    slug: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    /** `"api_key"` for Azure OpenAI (uses the `api-key:` header); omit for
     *  standard `Authorization: Bearer` endpoints. */
    authStyle?: "bearer" | "api_key";
    /** Azure OpenAI `api-version` query param (e.g. `2024-08-01-preview`). */
    apiVersion?: string;
    setActive?: boolean;
  }) =>
    invoke<{ provider_id: string }>("brain_upsert_provider", {
      input: {
        slug: opts.slug,
        base_url: opts.baseUrl,
        model: opts.model,
        api_key: opts.apiKey ?? null,
        auth_style: opts.authStyle ?? null,
        api_version: opts.apiVersion ?? null,
        set_active: opts.setActive ?? false,
      },
    }),
  /** Forget a custom `openai_compat:*` endpoint (config + key). */
  brainRemoveProvider: (providerId: string) =>
    invoke<void>("brain_remove_provider", {
      input: { provider_id: providerId },
    }),
  /**
   * Configure a cloud singleton brain — AWS Bedrock or Google Vertex AI —
   * that needs more than a single API key. Non-secret fields (Bedrock:
   * `region` / `access_key_id` / `session_token`; Vertex: `project_id` /
   * `location`) go to `brain_settings.json`; the credential (AWS secret
   * access key / the service-account JSON) goes to the OS keychain. Pass
   * `secret: ""` to clear it, omit to leave it in place.
   */
  brainConfigureCloud: (opts: {
    providerId: "bedrock" | "vertex";
    model?: string;
    extra: Record<string, string>;
    secret?: string;
    setActive?: boolean;
  }) =>
    invoke<void>("brain_configure_cloud", {
      input: {
        provider_id: opts.providerId,
        model: opts.model ?? null,
        extra: opts.extra,
        secret: opts.secret ?? null,
        set_active: opts.setActive ?? false,
      },
    }),
  /** Read back a cloud brain's saved config (never the credential itself). */
  brainCloudConfigGet: (providerId: "bedrock" | "vertex") =>
    invoke<BrainCloudConfig>("brain_cloud_config_get", { providerId }),

  // Aura Pro brain (v0.2.31 task #352) — managed/subscription backend.
  // No keychain row: sign-in state + quota live in cloud-auth land
  // (~/.aura/credentials.json + the `/v1/brain/quota` endpoint), and
  // the BrainSettings UI special-cases the `aura_pro` row to render
  // these instead of an API-key field.
  auraProIsSignedIn: () =>
    invoke<AuraProSignInState>("aura_pro_is_signed_in"),
  auraProQuota: () => invoke<AuraProQuota>("aura_pro_quota"),

  // Brain-trait chat surface (v0.2.31 LL.0). Sibling of `managerChat` —
  // bypasses the legacy `manager-stream:<sid>` MCP/CLI path for native
  // brains and streams `BrainChatChunk`s directly on
  // `manager-chat-chunk:<sid>`. CLI wrappers stay on the legacy path
  // (their UX is a terminal, not a chat bubble).
  brainActiveInfo: () => invoke<ActiveBrainInfo>("brain_active_info"),
  /**
   * Stream one chat turn through a brain (WW-B1). `brainOverride`, when
   * set, runs this turn through that specific provider_id (the
   * chat-header BrainPicker's choice) instead of the global active brain
   * — for this turn only, leaving the global default untouched. Pair it
   * with {@link managerSetBrainOverride} so the choice also persists on
   * the session for reload + the legacy path.
   */
  brainChatTurn: (
    sessionId: string,
    userMessage: string,
    contextJson?: BrainChatContext | null,
    brainOverride?: string | null,
    repoRoot?: string | null,
  ) =>
    invoke<void>("brain_chat_turn", {
      sessionId,
      userMessage,
      contextJson: contextJson ?? null,
      brainOverride: brainOverride ?? null,
      // The repo/worktree root the user is actually in. The backend spawns a
      // CLI-wrapper brain's subprocess here (so a worktree chat runs inside
      // the worktree) and roots the native tool loop on it. `null` → backend
      // falls back to the session's bound project list.
      repoRoot: repoRoot ?? null,
    }),
  brainChatCancel: (sessionId: string) =>
    invoke<void>("brain_chat_cancel", { sessionId }),
  /**
   * List every brain the chat-header BrainPicker can swap to (WW-B1) —
   * static singletons (Aura Pro, Claude, …), installed CLI wrappers, and
   * each user-registered `openai_compat:<slug>` endpoint. `active` marks
   * the globally-active brain. Same source as the Settings picker, so
   * the two never drift.
   */
  managerListBrains: () => invoke<BrainChoice[]>("manager_list_brains"),
  /**
   * Live model catalog from each provider's `/models` endpoint — the
   * picker's stable source instead of a hardcoded list. Cached on disk for
   * 24h; pass `force` to bypass the cache and refetch. Per-family resilient:
   * a missing key / down provider only blanks that family (recorded in
   * `errors`), and the picker shows its curated static list for it.
   */
  agentModelsList: (force?: boolean) =>
    invoke<ModelCatalog>("agent_models_list", { force: force ?? false }),
  /**
   * Set (or clear) a session's mid-conversation brain override (WW-B1).
   * Pass a `provider_id` from {@link managerListBrains} to swap the
   * session onto that brain; pass `null` to clear back to the active
   * brain. Persists on the session so the swap survives reload. The
   * native path also needs the same id passed per-turn via
   * {@link brainChatTurn}; this is the durable record.
   */
  managerSetBrainOverride: (sessionId: string, providerId: string | null) =>
    invoke<void>("manager_set_brain_override", { sessionId, providerId }),
  /**
   * Assemble the carryover payload for a brain swap (WW-B3). Shells
   * `aura carryover --json` and returns the typed {@link AuraCarryover}
   * the receiving brain reads to continue the work at the exact point of
   * interruption. Fire this ONLY at the explicit swap moment — it spawns
   * the CLI and walks AST checkpoints, far too heavy for the hot send
   * path (per-turn selection is {@link managerSetBrainOverride}). The
   * payload is secret-redacted by default since the new brain may be a
   * cloud model. `mode` is `"full"` or `"semantic"` (default semantic);
   * `targetAgent` names the brain being handed to (drives the header).
   */
  brainCarryover: (
    repoRoot: string,
    mode: "full" | "semantic" = "semantic",
    targetAgent = "",
  ) =>
    invoke<AuraCarryover>("brain_carryover", {
      repoRoot,
      mode,
      targetAgent,
    }),

  // ── Orchestrator Mode (v0.2.31 LL.1, task #340) ───────────────────────
  // Manager-of-managers fan-out. Dispatch a wave of specialist lanes —
  // each runs through one Brain::chat in its own context window and
  // returns a summary back to the parent. Live progress arrives on
  // `orchestrator-wave:<wave_id>` events.
  orchestratorDispatchWave: (plan: WavePlan) =>
    invoke<WaveOutcome>("orchestrator_dispatch_wave", { plan }),
  orchestratorLaneStatus: (laneId: string) =>
    invoke<LaneOutcome | null>("orchestrator_lane_status", { laneId }),
  orchestratorCancelLane: (laneId: string) =>
    invoke<boolean>("orchestrator_cancel_lane", { laneId }),
  orchestratorListActive: () =>
    invoke<LaneOutcome[]>("orchestrator_list_active"),
  orchestratorWaveStatus: (waveId: string) =>
    invoke<WaveOutcome | null>("orchestrator_wave_status", { waveId }),

  // ── Automations — "When this happens → do that" recipes ──────────────
  // Backed by `<repo>/.aura/automations.json`. They fire while Aura (or your
  // Aura Runner) is on, through the same real Crew / notes / tasks / reviewer
  // paths the rest of the app uses.
  automationsList: (repoRoot: string) =>
    invoke<Automation[]>("automations_list", { repoRoot }),
  automationCreate: (repoRoot: string, input: AutomationInput) =>
    invoke<Automation>("automation_create", { repoRoot, input }),
  automationUpdate: (repoRoot: string, id: string, input: AutomationInput) =>
    invoke<Automation>("automation_update", { repoRoot, id, input }),
  automationDelete: (repoRoot: string, id: string) =>
    invoke<boolean>("automation_delete", { repoRoot, id }),
  automationSetEnabled: (repoRoot: string, id: string, enabled: boolean) =>
    invoke<Automation>("automation_set_enabled", { repoRoot, id, enabled }),
  automationRunNow: (repoRoot: string, id: string) =>
    invoke<AutomationRunRecord>("automation_run_now", { repoRoot, id }),

  auraSemanticOutline: (repoRoot: string, file: string) =>
    invoke<OutlineNode[]>("aura_semantic_outline", { repoRoot, file }),

  // Daemon surface
  daemonStatus: () => invoke<DaemonStatus>("daemon_status"),
  daemonSpawn: () => invoke<string>("daemon_spawn"),
  daemonListSessions: () => invoke<SessionInfo[]>("daemon_list_sessions"),
  daemonOpenSession: (workspace: string, agent?: string) =>
    invoke<string>("daemon_open_session", { workspace, agent }),
  daemonCloseSession: (id: string) =>
    invoke<void>("daemon_close_session", { id }),
  daemonHandover: (agent: string) =>
    invoke<string>("daemon_handover", { agent }),
  daemonClaimZone: (path: string) =>
    invoke<string>("daemon_claim_zone", { path }),
  daemonSendMessage: (target: string, body: string) =>
    invoke<string>("daemon_send_message", { target, body }),
  daemonListBlocks: (limit: number) =>
    invoke<DaemonBlock[]>("daemon_list_blocks", { limit }),

  // Sentinel inbox + agent presence — disk-backed (.aura/sentinel/*).
  // The CLI's SentinelManager owns writes from the agent side; we tail
  // the same directory so the desktop sees what every agent sees.
  sentinelInbox: (repoRoot: string) =>
    invoke<SentinelMessage[]>("sentinel_inbox", { repoRoot }),
  sentinelAgents: (repoRoot: string) =>
    invoke<SentinelAgent[]>("sentinel_agents", { repoRoot }),
  sentinelSend: (
    repoRoot: string,
    fromAgent: string,
    fromSession: string,
    toSession: string,
    content: string,
  ) =>
    invoke<SentinelMessage>("sentinel_send", {
      repoRoot,
      fromAgent,
      fromSession,
      toSession,
      content,
    }),
  sentinelMarkRead: (repoRoot: string, messageId: string, readerSession: string) =>
    invoke<void>("sentinel_mark_read", { repoRoot, messageId, readerSession }),

  // ── cross-worktree control plane (the Workspaces page) ──────────────
  //
  // The whole board for a repository: every checkout, the agents standing
  // in each, what they hold, and where two of them have converged on the
  // same symbol. `repoRoot` may be ANY checkout — the engine resolves the
  // shared plane back to the main one itself.
  //
  // `withGitStatus: false` skips the per-checkout git work (dirty count,
  // drift from trunk, HEAD date) and returns in milliseconds; the page
  // paints that first and swaps in the full board when it lands.
  worktreePlane: (repoRoot: string, withGitStatus?: boolean) =>
    invoke<WorktreePlane>("worktree_plane", { repoRoot, withGitStatus }),
  /** Send a line to one checkout by name (`main` for the main checkout),
   *  or to every agent holding a claim when `toWorktree` is omitted. */
  worktreeSay: (repoRoot: string, message: string, toWorktree?: string) =>
    invoke<WorktreeSayResult>("worktree_say", { repoRoot, message, toWorktree }),

  // ── publishing a plain folder (the no-repo gate) ────────────────────
  repoState: (dir: string) => invoke<RepoState>("repo_state", { dir }),
  /** Both hosts, always — one you're signed out of comes back with the
   *  command that fixes it, rather than silently missing. */
  repoHosts: (dir: string) => invoke<HostProvider[]>("repo_hosts", { dir }),
  repoNameFree: (provider: string, owner: string, name: string) =>
    invoke<boolean>("repo_name_free", { provider, owner, name }),
  repoPublish: (
    dir: string,
    provider: string,
    owner: string,
    name: string,
    isPrivate: boolean,
  ) =>
    invoke<PublishResult>("repo_publish", {
      dir,
      provider,
      owner,
      name,
      private: isPrivate,
    }),

  // Zone rules — read straight off .aura/sentinel/zones; claim/release
  // shell out to the `aura zones …` CLI so the rules-engine + cloud-sync
  // side effects stay in one place.
  zoneList: (repoRoot: string) =>
    invoke<ZoneRule[]>("zone_list", { repoRoot }),
  zoneClaim: (
    repoRoot: string,
    patterns: string[],
    mode?: "warn" | "block",
    label?: string,
  ) => invoke<string>("zone_claim", { repoRoot, patterns, mode, label }),
  zoneRelease: (repoRoot: string, zoneId: string) =>
    invoke<string>("zone_release", { repoRoot, zoneId }),

  // Workspace file watcher — recursive notify watch rooted at the
  // current project. Pairs with the `fs:changed` event on the React
  // side (subscribed in App.tsx) so external editor saves invalidate
  // the matching open buffer.
  watchRepo: (repoRoot: string) =>
    invoke<void>("watch_repo", { repoRoot }),
  unwatchRepo: (repoRoot: string) =>
    invoke<void>("unwatch_repo", { repoRoot }),

  // Aura Manager — in-process orchestrator. `manager_start` stages a
  // plan in AwaitingApproval; `manager_resume` flips to Running and
  // the loop dispatches tasks via the agent registry. Subscribe to
  // `manager:<sid>` events for live ManagerSession snapshots; the
  // backend also emits `agent-stream:<channel>` for each in-flight
  // task (channel = `manager-<sid>-<task_id>`).
  managerStart: (args: ManagerStartArgs) =>
    invoke<string>("manager_start", { args }),
  /** Spin up a chat-only Manager session seeded with a freeform prompt
   *  as the objective. Used when the user picks "Aura Manager" from the
   *  agent picker — the session has no tasks until Track B's chat
   *  router decomposes the prompt or a follow-up message. */
  managerChatStart: (repoRoot: string, prompt: string) =>
    invoke<string>("manager_chat_start", { repoRoot, prompt }),
  /** Cross-agent continuity — hydrate a native Aura chat session from a
   *  Claude Code / Gemini CLI transcript. Reads the agent's own on-disk
   *  session (`agentId` ∈ {"claude","gemini"}, `agentSessionId` = the
   *  CLI's session id), maps every historical turn into ChatTurns
   *  (assistant turns tagged with the originating brain so the bubble
   *  shows the right brand mark), and returns the new manager session id
   *  to open in the chat view. */
  managerImportAgentSession: (
    agentId: string,
    repoRoot: string,
    agentSessionId: string,
  ) =>
    invoke<string>("manager_import_agent_session", {
      agentId,
      repoRoot,
      agentSessionId,
    }),
  /** Fork a chat session at a point in its history — clones every turn up
   *  to and including `upToIndex` (an index into `session.chat`) into a
   *  fresh Manager session, leaving the original untouched. Returns the new
   *  session id. Used by the per-message "More → Fork" affordance so the
   *  user can branch a conversation into a new tab or its own window. */
  managerForkSession: (sessionId: string, upToIndex: number) =>
    invoke<string>("manager_fork_session", { sessionId, upToIndex }),
  /** "Open this chat in Claude Code" — prepare a Claude Code session the user
   *  can resume in a terminal (`claude --resume <session_id>`). When the chat
   *  already ran on the Claude CLI backend, returns that real session as-is
   *  (`synthesized: false`); otherwise it serializes the Aura conversation
   *  into a fresh, valid Claude Code transcript and returns that
   *  (`synthesized: true`). `claude_installed` is false when the CLI isn't on
   *  PATH, so the caller can explain instead of spawning a doomed terminal. */
  chatExportToClaudeCode: (sessionId: string) =>
    invoke<ClaudeExport>("chat_export_to_claude_code", { sessionId }),
  /** "Open this chat in <agent>" — prepare a continuation target for an Aura
   *  chat in ANY registry agent (claude / gemini / codex / cursor / kimi / …).
   *  Returns either a `resume_arg` to feed the agent's real resume command
   *  (claude/gemini/codex have on-disk resumable sessions we write in their
   *  native format) or a `primer` to seed a fresh session (handoff agents with
   *  no resumable store). `mode` says which; `installed` is false when the
   *  agent's CLI isn't on PATH so the caller can explain instead of spawning a
   *  doomed terminal. */
  chatExportForAgent: (agentId: string, sessionId: string) =>
    invoke<AgentExport>("chat_export_for_agent", { agentId, sessionId }),
  /** Loop-unify: read the unified ready_view over the shared `aura-loop`
   *  graph (ready / blocked / working / done partition + counts). Same
   *  on-disk truth the CLI's `aura loop run` consumes, so chat and runner
   *  never drift. */
  loopReadyView: (repoRoot: string) =>
    invoke<ReadyViewDto>("loop_ready_view", { repoRoot }),
  /** Project the human task board (incl. Jira-imported cards) into the loop
   *  graph idempotently, reconciling dependencies into edges. */
  loopSyncBoard: (repoRoot: string) =>
    invoke<LoopSyncResult>("loop_sync_board", { repoRoot }),
  /** Claim the ready set and fan it out through the native Aura brain (the
   *  same dispatcher the Orchestrator uses). `max` caps the batch; `goal`/
   *  `crew` narrow the run to one subtree (a goal node's Run button passes its
   *  goal, a crew's Run passes its crew). */
  loopRunNative: (
    repoRoot: string,
    max?: number,
    goal?: string,
    crew?: string,
  ) => invoke<LoopRunResult>("loop_run_native", { repoRoot, max, goal, crew }),
  /** Manual node control — release (`submitted`) or otherwise re-stamp a
   *  node's lifecycle state from the panel. */
  loopSetStatus: (repoRoot: string, nodeId: string, status: string) =>
    invoke<LoopTask>("loop_set_status", { repoRoot, nodeId, status }),
  /** Cloud roundtrip (P1): pull cloud-worked results home + push finished local
   *  work up, in one call. `pull`/`push` gate the legs (both false = both). Thin
   *  desktop face of `aura loop cloud-sync`; returns `{repo, pulled, pushed,
   *  notes}`. Requires the user to be signed in to cloud (`cloudAuthStatus`). */
  loopCloudSync: (repoRoot: string, pull = false, push = false) =>
    invoke<CloudSyncResult>("loop_cloud_sync", { repoRoot, pull, push }),
  /** Cloud roundtrip (P1): hand a job to the always-on cloud runner — mints a
   *  submitted task on the shared A2A board (scoped to this repo's origin) that
   *  a runner drains. `agent` is the bare provider id ("claude"); an optional
   *  acceptance line makes it provable. Returns the cloud task `{id, status}`. */
  loopCloudSend: (
    repoRoot: string,
    text: string,
    agent: string,
    acceptance?: string,
  ) =>
    invoke<CloudSendResult>("loop_cloud_send", {
      repoRoot,
      text,
      agent,
      acceptance: acceptance ?? null,
    }),
  /** Connect-a-machine: mint a one-time runner-registry token on the signed-in
   *  cloud account so a brand-new box can join your board. Shells the bundled
   *  `aura runner register` (same `recall_cloud_creds` path as sign-in). `repo`
   *  optionally scopes the runner to one repo; omitted = org-wide (drains every
   *  project). Requires cloud sign-in. */
  runnerProvision: (name: string, repo?: string) =>
    invoke<RunnerProvision>("runner_provision", { name, repo: repo ?? null }),
  /** W-B: park work out of the ready set. One task (`nodeId`) or a whole
   *  `goal`/`crew` subtree. Returns the ids actually paused. */
  loopPause: (
    repoRoot: string,
    opts: { nodeId?: string; goal?: string; crew?: string },
  ) =>
    invoke<string[]>("loop_pause", {
      repoRoot,
      nodeId: opts.nodeId,
      goal: opts.goal,
      crew: opts.crew,
    }),
  /** W-B: un-park work back into the ready set. Mirror of `loopPause`.
   *  Returns the ids re-armed. */
  loopResume: (
    repoRoot: string,
    opts: { nodeId?: string; goal?: string; crew?: string },
  ) =>
    invoke<string[]>("loop_resume", {
      repoRoot,
      nodeId: opts.nodeId,
      goal: opts.goal,
      crew: opts.crew,
    }),
  /** W-B: the crew's run history, newest first (`.aura/crew/runs.jsonl`).
   *  `limit` caps the list (default 25). */
  loopRuns: (repoRoot: string, limit?: number) =>
    invoke<RunRecord[]>("loop_runs", { repoRoot, limit }),
  /** W-C: every crew (registry ∪ live graph), "main" first, each with its
   *  live ready/working/done/paused tally for the crew switcher. */
  loopCrews: (repoRoot: string) =>
    invoke<CrewRow[]>("loop_crews", { repoRoot }),
  /** W-C: mint a crew (idempotent on the slugged title) and optionally move
   *  the named nodes onto it. Returns the crew's identity row + counts. */
  loopCrewSpawn: (
    repoRoot: string,
    title: string,
    description?: string,
    taskIds?: string[],
  ) =>
    invoke<CrewRow>("loop_crew_spawn", {
      repoRoot,
      title,
      description,
      taskIds,
    }),
  /** Plan a goal into a dependency graph: the active brain decomposes the
   *  goal into 3–8 tasks with parallel/sequential/join edges, then those
   *  land as real loop nodes on the graph (so the canvas draws them). The
   *  same on-disk `.aura/a2a/` graph the runner consumes — no mock plan. */
  loopPlanGoal: (repoRoot: string, goal: string) =>
    invoke<PlanGoalResult>("loop_plan_goal", { repoRoot, goal }),
  /** Plan an order over the tasks you ALREADY have that sit in no order: the
   *  active brain works out the real dependencies between them and wires those
   *  "waiting on" edges onto the existing nodes (nothing new is minted), so the
   *  flat pile reorganises into a connected flow on the canvas. */
  loopPlanOrder: (repoRoot: string) =>
    invoke<PlanOrderResult>("loop_plan_order", { repoRoot }),
  /** Reality-check the queue BEFORE planning/running: flag tasks that look
   *  already finished (a finished task shares the name, or a recent commit
   *  delivered it), duplicates of another pending task, or empty stubs. Honest
   *  name/placeholder signals only — never a guess the code is done. `commits`
   *  widens the finished-work evidence window (default 40). */
  loopReview: (repoRoot: string, commits?: number) =>
    invoke<LoopTaskFlag[]>("loop_review", { repoRoot, commits }),
  /** Existing goals new tasks could attach to instead of starting a
   *  disconnected island — each with the tail steps to hang the new work
   *  after. Empty when nothing's grouped under a goal yet. */
  loopAttachTargets: (repoRoot: string) =>
    invoke<LoopAttachTarget[]>("loop_attach_targets", { repoRoot }),
  managerStatus: (sessionId: string) =>
    invoke<ManagerSession>("manager_status", { sessionId }),
  /** List Aura chat sessions, newest first. Pass `repoRoot` to scope the
   *  list to the open workspace — sessions bound to other workspaces are
   *  excluded so `/resume` can't surface or reopen them. Omit for a global
   *  list (e.g. the running-agents status pill). */
  managerList: (repoRoot?: string | null) =>
    invoke<ManagerSummary[]>("manager_list", { repoRoot: repoRoot ?? null }),
  /** Search message bodies across native Aura conversations in every
   *  workspace. Used by the global Command Palette conversation lane. */
  managerSearch: (query: string, limit = 40) =>
    invoke<ManagerSearchHit[]>("manager_search", { query, limit }),
  /** Replay a native Aura chat session as the same {@link StreamEvent}
   *  stream the Trace transcript renderer consumes for Claude Code JSONL
   *  sessions. Native manager sessions persist to
   *  `~/.aura/manager-sessions/<id>.json` (no JSONL `file_path`), so the
   *  detail pane feeds the transcript pane through this instead of a file
   *  read — each persisted `ChatTurn` maps to UserPrompt / AssistantText +
   *  ToolUse/ToolResult events. */
  managerLoadTranscript: (sessionId: string) =>
    invoke<StreamEvent[]>("manager_load_transcript", { sessionId }),
  /** The Changes-tab changeset for a native Aura chat session — the files it
   *  edited directly + each file's net diff from the session's first baseline.
   *  Empty `files` for an orchestrator-only session (its changes live in the
   *  child agent sessions). Drives SessionDetailPane's Changes tab, which has no
   *  intent-log `changeset` for native chat rows. */
  managerSessionChangeset: (repoRoot: string, sessionId: string) =>
    invoke<IntentChangeset>("manager_session_changeset", {
      repoRoot,
      sessionId,
    }),
  managerResume: (sessionId: string) =>
    invoke<void>("manager_resume", { sessionId }),
  managerPause: (sessionId: string) =>
    invoke<void>("manager_pause", { sessionId }),
  managerCancel: (sessionId: string) =>
    invoke<void>("manager_cancel", { sessionId }),
  managerOverride: (
    sessionId: string,
    taskId: number,
    mode: ManagerOverrideMode,
    agentId?: string,
  ) =>
    invoke<void>("manager_override", {
      sessionId,
      taskId,
      mode,
      agentId: agentId ?? null,
    }),
  managerCompleteManual: (sessionId: string, taskId: number, output: string) =>
    invoke<void>("manager_complete_manual", { sessionId, taskId, output }),
  /** Bucket F2 — record the user's thumbs vote on a terminal task.
   *  Mutates `pending_skill.user_rating`; the row is committed to
   *  `~/.aura/agent_skills.json` later by the brain self-eval grader.
   *  `rating` must be `-1` (thumbs-down) or `+1` (thumbs-up). Calling
   *  on a non-terminal task is a silent no-op. */
  managerRateTask: (sessionId: string, taskId: number, rating: -1 | 1) =>
    invoke<void>("manager_rate_task", { sessionId, taskId, rating }),
  /** Bucket G3 — user clicked the SkillBadge dropdown and picked a
   *  different provider for one todo on a pending plan. The override
   *  is honored at Build-time mint; if the plan is no longer pending
   *  the call silently no-ops. */
  managerOverrideTodoAgent: (
    sessionId: string,
    planId: string,
    todoIdx: number,
    agentId: string,
  ) =>
    invoke<void>("manager_override_todo_agent", {
      sessionId,
      planId,
      todoIdx,
      agentId,
    }),
  /** Render the exact prompt the runtime would build for `taskId` —
   *  upstream relay summaries inlined, 8KB cap. Used by Track D's edge
   *  hover to show users what's actually being piped between agents. */
  managerPreviewPrompt: (sessionId: string, taskId: number) =>
    invoke<string>("manager_preview_prompt", { sessionId, taskId }),
  /** Append a chat turn to a Manager session. Used by the chat surface
   *  to record both the user's prompt and the Manager's narration. */
  managerAppendChat: (
    sessionId: string,
    role: ChatRole,
    text: string,
  ) => invoke<void>("manager_append_chat", { sessionId, role, text }),
  /** Send a user message to the Manager brain. Appends the turn server-
   *  side then fires the Anthropic-backed agentic loop. UI subscribes to
   *  `manager-stream:<sid>` for streaming text deltas and tool_use cards
   *  while the loop runs; the snapshot on `manager:<sid>` updates as the
   *  brain mutates the session (chat turns, spawned tasks, etc). */
  managerChat: (
    sessionId: string,
    message: string,
    attachments?: Array<{ media_type: string; data_base64: string; name?: string | null }>,
  ) =>
    invoke<void>("manager_chat", { sessionId, message, attachments: attachments ?? null }),
  /** Edit a previously-sent user turn at `turnIndex` and resend from there.
   *  Drops every chat turn from `turnIndex` onwards, appends a fresh user
   *  turn with `message`, then re-runs the brain. When `restoreCode` is
   *  set, also reverts every project file modified since the original
   *  turn back to its snapshotted state at that point. */
  managerChatEditResend: (
    sessionId: string,
    turnIndex: number,
    message: string,
    restoreCode: boolean,
  ) =>
    invoke<void>("manager_chat_edit_resend", {
      sessionId,
      turnIndex,
      message,
      restoreCode,
    }),
  /** Submit the user's answer to the currently pending `ask_user`
   *  question. `questionId` is the tool_use_id from the QuestionAsked
   *  delta. The brain resumes its loop with the answer threaded as a
   *  tool_result. */
  managerAnswerQuestion: (
    sessionId: string,
    questionId: string,
    answer: string,
  ) =>
    invoke<void>("manager_answer_question", { sessionId, questionId, answer }),
  /** Resolve a PlanCard. Build starts execution, revise returns written
   *  feedback to the planning brain, and cancel abandons the plan. */
  managerDecidePlan: (
    sessionId: string,
    planId: string,
    decision: "build" | "revise" | "cancel",
    notifyTeam?: boolean,
    parallelism?: PlanParallelism,
    feedback?: string,
  ) =>
    invoke<void>("manager_decide_plan", {
      sessionId,
      planId,
      decision,
      feedback: feedback ?? null,
      notifyTeam: notifyTeam ?? false,
      parallelism: parallelism ?? null,
    }),
  /** Inventory blocker #3 (2026-05-20 audit) — record an explicit human
   *  approval on the pending plan. Distinct from Build: this only stamps
   *  `approved_by` + `approved_at` and persists; the plan stays pending
   *  until the user (or a teammate) clicks Build. Returns the stamped
   *  pair so the PlanCard can render the row immediately without
   *  waiting for the next session snapshot. */
  managerApprovePlan: (
    sessionId: string,
    planId: string,
    approver: string,
  ) =>
    invoke<PlanApproval>("manager_approve_plan", {
      sessionId,
      planId,
      approver,
    }),
  /** What backend powers a given Manager session — `null` if no chat
   *  has run yet (backend is auto-picked on first turn). */
  managerBrainInfo: (sessionId: string) =>
    invoke<BrainBackendInfo | null>("manager_brain_info", { sessionId }),
  /** What backend would be picked if a fresh Manager session opened
   *  right now. Used to show "Aura Manager (Claude Code)" in the picker
   *  before the user even sends a message. */
  managerBrainDetect: () =>
    invoke<BrainBackendInfo | null>("manager_brain_detect"),
  /** Replace a Manager session's task list and optionally flip it to
   *  Running. Frontend calls this after parsing `aura plan` output. */
  managerSetTasks: (
    sessionId: string,
    tasks: ManagerTaskSpec[],
    autoResume: boolean,
  ) => invoke<void>("manager_set_tasks", { sessionId, tasks, autoResume }),

  // Project registry — `~/.aura/projects.json`. The Manager loop reads
  // this independently of whatever workspace is active in the renderer.
  projectsRegister: (root: string, label?: string) =>
    invoke<ProjectEntry>("projects_register", { root, label: label ?? null }),
  projectsList: () => invoke<ProjectEntry[]>("projects_list"),
  projectsGet: (id: string) => invoke<ProjectEntry | null>("projects_get", { id }),

  // Settings — backs SettingsDialog tabs. Keys/strict/telemetry round-
  // trip via `~/.aura/credentials.json`; agents tab edits `agents.toml`.
  settingsLoad: () => invoke<SettingsView>("settings_load"),
  settingsSetProviderKey: (provider: string, key: string) =>
    invoke<void>("settings_set_provider_key", { provider, key }),
  settingsSetActiveProvider: (provider: string) =>
    invoke<void>("settings_set_active_provider", { provider }),
  settingsSetTelemetry: (enabled: boolean) =>
    invoke<void>("settings_set_telemetry", { enabled }),
  settingsSetDevMode: (enabled: boolean) =>
    invoke<void>("settings_set_dev_mode", { enabled }),
  settingsSetLocalEmbeddings: (enabled: boolean) =>
    invoke<void>("settings_set_local_embeddings", { enabled }),
  /** Override the parent directory for managed worktrees. Empty path
   *  clears the override and restores the `~/.aura/worktrees` default. */
  settingsSetWorktreeBase: (path: string) =>
    invoke<void>("settings_set_worktree_base", { path }),
  settingsDisableStrictUnlocked: () =>
    invoke<void>("settings_disable_strict_unlocked"),
  settingsAgentsTomlList: () =>
    invoke<AgentsTomlEntry[]>("settings_agents_toml_list"),
  settingsAgentsTomlUpsert: (entry: AgentsTomlEntry) =>
    invoke<void>("settings_agents_toml_upsert", { entry }),
  settingsAgentsTomlRemove: (id: string) =>
    invoke<void>("settings_agents_toml_remove", { id }),
  /** Secret-redacted Claude Code / Codex / Gemini preference sync. Auth
   *  stores are never read; pull creates adjacent timestamped backups. */
  settingsAgentConfigsStatus: () =>
    invoke<AgentConfigSyncStatus>("settings_agent_configs_status"),
  settingsAgentConfigsPush: () =>
    invoke<AgentConfigSyncStatus>("settings_agent_configs_push"),
  settingsAgentConfigsPull: () =>
    invoke<AgentConfigApplyResult>("settings_agent_configs_pull"),
  settingsTelemetryShow: () =>
    invoke<TelemetryView>("settings_telemetry_show"),
  settingsTelemetryClear: () =>
    invoke<void>("settings_telemetry_clear"),
  /** Non-secret UI prefs at `~/.aura/settings.toml`. `null` when the file
   *  doesn't exist yet — caller migrates from legacy localStorage then
   *  writes the first TOML. Backed by `cmd_settings_prefs.rs`. */
  settingsPrefsLoad: () =>
    invoke<AppSettings | null>("settings_prefs_load"),
  settingsPrefsSave: (settings: AppSettings) =>
    invoke<void>("settings_prefs_save", { settings }),
  /** Switch the floating HUD's shape live ("capsule" | "sidebar" | "minimal").
   *  Backed by `hud::hud_set_mode`; the HUD drives the matching CSS itself. */
  hudSetMode: (mode: string) => invoke<void>("hud_set_mode", { mode }),
  /** Set the HUD window's uniform opacity (0.2–1.0). `hud::hud_set_opacity`. */
  hudSetOpacity: (opacity: number) =>
    invoke<void>("hud_set_opacity", { opacity }),
  /** Flip the persistent HUD master switch live. When off, ⌘⇧A / tray /
   *  programmatic summons are no-ops and a visible HUD is hidden now.
   *  `hud::hud_set_enabled`. */
  hudSetEnabled: (enabled: boolean) =>
    invoke<void>("hud_set_enabled", { enabled }),
  /** Summon the floating HUD (⌘⇧A) — used to preview while tuning it in
   *  Settings → HUD. `hud::hud_show`. */
  hudShow: () => invoke<void>("hud_show"),

  // Clipboard tray — durable workspace clipboard at ~/.aura/clips/
  // Pasted images and dragged-in files survive reloads so agents can
  // read them by absolute path.
  clipsList: () => invoke<ClipEntry[]>("clips_list"),
  clipsSaveImage: (name: string, dataB64: string) =>
    invoke<ClipEntry>("clips_save_image", { name, dataB64 }),
  clipsSaveFile: (origPath: string) =>
    invoke<ClipEntry>("clips_save_file", { origPath }),
  clipsReadDataUrl: (id: string) => invoke<string>("clips_read_dataurl", { id }),
  // Push an image clip into the OS clipboard so a follow-up Ctrl+V to
  // a TUI agent attaches it as an image instead of just typing the
  // file path. Used by drag-onto-agent-terminal flow.
  clipsCopyImageToOs: (id: string) => invoke<void>("clips_copy_image_to_os", { id }),

  // Mobile remote — LAN web server. Phone in the same network hits
  // the URL, types prompts that route into the active session.
  remoteStart: () => invoke<RemoteStatus>("remote_start"),
  remoteStop: () => invoke<RemoteStatus>("remote_stop"),
  remoteStatus: () => invoke<RemoteStatus>("remote_status"),
  remoteSetSnapshot: (snapshot: unknown) =>
    invoke<void>("remote_set_snapshot", { snapshot }),

  // Cloud relay — outbound WS to auravcs.com. Phones over the public
  // internet hit `https://auravcs.com/remote/m/<code>` and pair with
  // this desktop. See `cmd_remote_relay.rs` for the protocol.
  remoteRelayStart: () => invoke<RemoteRelayStatus>("remote_relay_start"),
  remoteRelayStop: () => invoke<RemoteRelayStatus>("remote_relay_stop"),
  remoteRelayStatus: () => invoke<RemoteRelayStatus>("remote_relay_status"),
  clipsRemove: (id: string) => invoke<void>("clips_remove", { id }),
  clipsClear: () => invoke<void>("clips_clear"),

  // Agent provider registry (Stage 4A) — surfaced in the Agents tab.
  agentsList: () => invoke<AgentDescriptor[]>("agents_list"),
  agentsReload: () => invoke<AgentDescriptor[]>("agents_reload"),

  // Memory + Sessions (5D) — direct fs reader/writer over .aura/memory.json
  // and .aura/sessions/*. Memory is a single JSON with sectioned arrays;
  // each session is one JSON file keyed by session_id.
  auraMemoryView: (repoRoot: string) =>
    invoke<MemoryView>("aura_memory_view", { repoRoot }),
  auraMemoryWriteEntry: (
    repoRoot: string,
    section: string,
    content: string,
    tags: string[],
  ) =>
    invoke<MemoryEntry>("aura_memory_write_entry", {
      repoRoot,
      section,
      content,
      tags,
    }),
  auraMemoryForgetEntry: (repoRoot: string, id: string) =>
    invoke<boolean>("aura_memory_forget_entry", { repoRoot, id }),
  // Import Claude Code's per-repo memory into Aura's memory. Shells the
  // `aura memory import-claude-code --json` CLI (W3 reconcile = idempotent);
  // dryRun reports what would import without writing.
  auraMemoryImportClaudeCode: (repoRoot: string, dryRun = false) =>
    invoke<ClaudeImportReport>("aura_memory_import_claude_code", {
      repoRoot,
      dryRun,
    }),
  auraSessionList: (repoRoot: string, limit = 50) =>
    invoke<SessionSummary[]>("aura_session_list", { repoRoot, limit }),
  auraSessionRead: (repoRoot: string, sessionId: string) =>
    invoke<unknown>("aura_session_read", { repoRoot, sessionId }),

  // Local crashlytics — panic hook writes JSON dumps to
  // ~/.aura/aura-shell-crashes/<ts>.json. Frontend lists them on launch
  // via CrashRecoveryToast.
  auraCrashReportsList: () =>
    invoke<CrashSummary[]>("aura_crash_reports_list"),
  auraCrashReportRead: (path: string) =>
    invoke<string>("aura_crash_report_read", { path }),
  auraCrashReportsClear: (beforeTsMs: number) =>
    invoke<number>("aura_crash_reports_clear", { beforeTsMs }),

  // Anonymous product telemetry (PostHog EU). All three are consent- and
  // key-gated in telemetry.rs: a no-op until the first-run prompt is answered,
  // and a no-op forever in builds with no PostHog key baked in. We never put
  // code, paths, prompts, repo names, email, or name on the wire.
  telemetryConsentGet: () =>
    invoke<TelemetryConsent>("telemetry_consent_get"),
  telemetrySetConsent: (product: boolean, crash: boolean) =>
    invoke<TelemetryConsent>("telemetry_set_consent", { product, crash }),
  /** Record a namespaced product event (e.g. `feature_used` with
   *  `{ feature: "crew_run" }`). Props must be safe scalars only. */
  telemetryTrack: (event: string, props?: Record<string, unknown>) =>
    invoke<void>("telemetry_track", { event, props: props ?? null }),

  // PR workspace (Stage 7A) — `gh` CLI passthrough enriched with
  // matching .aura/reviews/*.json risk score so the PR card surfaces
  // Aura's verdict next to GitHub's.
  prList: (repoRoot: string) => invoke<PrSummary[]>("pr_list", { repoRoot }),
  /** Open GitHub issues available as workspace launch context. */
  githubIssueList: (repoRoot: string) =>
    invoke<GithubIssue[]>("github_issue_list", { repoRoot }),
  /** Create a PR from the selected worktree branch. The backend pushes the
   *  branch first, then returns the concrete PR so Aura can open it. */
  prCreate: (input: {
    repoRoot: string;
    headBranch?: string | null;
    title: string;
    body: string;
    baseBranch?: string | null;
    draft: boolean;
  }) => invoke<PrCreated>("pr_create", input),
  /** Edit title, description, target branch, and draft state natively. */
  prEdit: (input: {
    repoRoot: string;
    prNumber: number;
    title: string;
    body: string;
    baseBranch?: string | null;
    draft: boolean;
  }) => invoke<void>("pr_edit", input),
  /** GitHub viewer login (`gh api user --jq .login`). Empty string if
   *  unauthenticated. Cached by caller — Inbox uses this to highlight
   *  PRs authored by the user vs awaiting their review. */
  prWhoami: (repoRoot: string) => invoke<string>("pr_whoami", { repoRoot }),
  /** All repo labels (`gh label list --json name,color,description --limit 200`).
   *  Used by the label picker to show the universe of choices. */
  prLabelsList: (repoRoot: string) =>
    invoke<PrLabel[]>("pr_labels_list", { repoRoot }),
  /** Replace the labels on a PR with `names`. Backend diffs against
   *  current and shells `gh pr edit --add-label / --remove-label`. */
  prLabelsSet: (repoRoot: string, prNumber: number, names: string[]) =>
    invoke<void>("pr_labels_set", { repoRoot, prNumber, names }),
  /** Edit a PR's title and/or body (`gh pr edit`). Pass `null` for a field
   *  to leave it unchanged, so the title and body can be saved independently. */
  prUpdate: (
    repoRoot: string,
    prNumber: number,
    title: string | null,
    body: string | null,
  ) => invoke<void>("pr_update", { repoRoot, prNumber, title, body }),
  prDetail: (repoRoot: string, prNumber: number) =>
    invoke<PrDetail>("pr_detail", { repoRoot, prNumber }),
  /** Flatten every status check on a PR (`gh pr view --json
   *  statusCheckRollup`) into one row per check — GitHub Actions runs,
   *  external CI status contexts, everything. Each row carries a plain
   *  bucket ("success" | "failure" | "pending") the Checks tab colors by,
   *  plus a `url` to the run's logs. Same rollup `pr_list` already reads,
   *  surfaced per-check instead of only summarized to a chip. */
  prChecks: (repoRoot: string, number: number) =>
    invoke<PrCheck[]>("pr_checks", { repoRoot, number }),
  /** Vercel deploy status for a PR's head commit, or null when Vercel isn't
   *  configured (`[vercel]` in `~/.aura/integrations.toml`) or has no
   *  deployment for the commit yet. Drives the deploy chip above the checks
   *  list. Deliberately soft — never blocks the checks view. */
  prVercelStatus: (repoRoot: string, prNumber: number) =>
    invoke<VercelDeployment | null>("pr_vercel_status", { repoRoot, prNumber }),
  // Stage 7B: comments
  prCommentsList: (repoRoot: string, prNumber: number) =>
    invoke<PrComment[]>("pr_comments_list", { repoRoot, prNumber }),
  prCommentPost: (
    repoRoot: string,
    prNumber: number,
    file: string,
    line: number,
    body: string,
    side?: "RIGHT" | "LEFT",
    startLine?: number,
  ) =>
    invoke<PrComment>("pr_comment_post", {
      repoRoot,
      prNumber,
      file,
      line,
      body,
      side: side ?? null,
      startLine: startLine ?? null,
    }),
  prCommentPostIssue: (repoRoot: string, prNumber: number, body: string) =>
    invoke<PrComment>("pr_comment_post_issue", { repoRoot, prNumber, body }),
  prCommentReply: (
    repoRoot: string,
    prNumber: number,
    inReplyTo: number,
    body: string,
  ) =>
    invoke<PrComment>("pr_comment_reply", {
      repoRoot,
      prNumber,
      inReplyTo,
      body,
    }),
  prCommentResolve: (repoRoot: string, threadNodeId: string) =>
    invoke<void>("pr_comment_resolve", { repoRoot, threadNodeId }),
  // Stage 8M: emoji reactions
  prReactionAdd: (
    repoRoot: string,
    commentNodeId: string,
    content: ReactionContent,
  ) => invoke<void>("pr_reaction_add", { repoRoot, commentNodeId, content }),
  prReactionRemove: (
    repoRoot: string,
    commentNodeId: string,
    content: ReactionContent,
  ) => invoke<void>("pr_reaction_remove", { repoRoot, commentNodeId, content }),
  // Stage 7D: approval / merge / stack
  prApprove: (repoRoot: string, prNumber: number, body?: string) =>
    invoke<void>("pr_approve", { repoRoot, prNumber, body: body ?? null }),
  prRequestChanges: (repoRoot: string, prNumber: number, body: string) =>
    invoke<void>("pr_request_changes", { repoRoot, prNumber, body }),
  prCommentReview: (repoRoot: string, prNumber: number, body: string) =>
    invoke<void>("pr_comment_review", { repoRoot, prNumber, body }),
  prMerge: (
    repoRoot: string,
    prNumber: number,
    strategy: "squash" | "merge" | "rebase",
    deleteBranch: boolean,
  ) => invoke<void>("pr_merge", { repoRoot, prNumber, strategy, deleteBranch }),
  prStack: (repoRoot: string, prNumber: number) =>
    invoke<PrStackNode[]>("pr_stack", { repoRoot, prNumber }),
  // Resource usage popover — CPU + memory totals + per-process breakdown
  // for the aura family (shell, pty daemon, mcp companion, agent CLIs).
  resourceSnapshot: () => invoke<ResourceSnapshot>("resource_snapshot"),

  // Plugin host (W0.3) — thin façade over plugin_host::Registry. Drives
  // the Settings → Plugins surface and the future marketplace list.
  pluginList: () => invoke<PluginRow[]>("plugin_list"),
  pluginRescan: () => invoke<PluginRescanResult>("plugin_rescan"),
  pluginEnable: (kind: PluginKind, id: string) =>
    invoke<void>("plugin_enable", { kind, id }),
  pluginDisable: (kind: PluginKind, id: string) =>
    invoke<void>("plugin_disable", { kind, id }),
  pluginContributes: () =>
    invoke<PluginContributesRow[]>("plugin_contributes"),

  // Commons builtin-app fetch proxy. First-party builtin apps (Reddit, …)
  // are trusted Aura code, but every network read still funnels through this
  // host-allowlisted command so the surface can never reach an arbitrary
  // host. `app` selects the allowlist; only public, credential-free URLs are
  // permitted. Resolves with the response body text or rejects on a
  // disallowed host / network error (never the app's whole crash).
  commonsAppFetch: (app: string, url: string) =>
    invoke<{ status: number; body: string; truncated: boolean }>(
      "commons_app_fetch",
      { app, url },
    ),

  // Plugin secrets broker (P2). Write-only from the renderer's point of
  // view — status reports existence, never values. Values land in the
  // OS keychain and only resurface inside the MCP child's environment.
  pluginSecretsStatus: (bundle: string) =>
    invoke<PluginSecretRow[]>("plugin_secrets_status", { bundle }),
  pluginSecretSet: (bundle: string, key: string, value: string) =>
    invoke<void>("plugin_secret_set", { bundle, key, value }),
  pluginSecretClear: (bundle: string, key: string) =>
    invoke<void>("plugin_secret_clear", { bundle, key }),

  // Plugin proxy (P1 runtime) — Rust-side capability enforcement. The
  // renderer's bridge ACL is the first gate; these re-check against the
  // registry so a renderer compromise can't mint fs/net access.
  pluginAssetRead: (pluginId: string, path: string) =>
    invoke<{ body: string }>("plugin_asset_read", { pluginId, path }),
  pluginProxyFsRead: (pluginId: string, repoRoot: string, path: string) =>
    invoke<string>("plugin_proxy_fs_read", { pluginId, repoRoot, path }),
  pluginProxyNetFetch: (pluginId: string, req: PluginNetFetchRequest) =>
    invoke<PluginNetFetchResponse>("plugin_proxy_net_fetch", {
      pluginId,
      req,
    }),
  pluginKvGet: (pluginId: string, key: string) =>
    invoke<unknown>("plugin_kv_get", { pluginId, key }),
  pluginKvSet: (pluginId: string, key: string, value: unknown) =>
    invoke<void>("plugin_kv_set", { pluginId, key, value }),

  // Plugin Exchange (Commons W1) — share signed bundles with the team
  // over the chat rail. Publish requires a Verified local signature;
  // install verifies ed25519 before any byte can load.
  pluginExchangePublish: (repoRoot: string, dir: string) =>
    invoke<ExchangeListing>("plugin_exchange_publish", { repoRoot, dir }),
  pluginExchangePoll: (repoRoot: string) =>
    invoke<ExchangePollResult>("plugin_exchange_poll", { repoRoot }),
  pluginExchangeList: (repoRoot: string) =>
    invoke<ExchangeRow[]>("plugin_exchange_list", { repoRoot }),
  pluginExchangeInstall: (repoRoot: string, publishId: string) =>
    invoke<ExchangeInstallResult>("plugin_exchange_install", {
      repoRoot,
      publishId,
    }),
  pluginExchangeTrust: (repoRoot: string, publishId: string) =>
    invoke<void>("plugin_exchange_trust", { repoRoot, publishId }),
  pluginExchangeUnpublish: (repoRoot: string, publishId: string) =>
    invoke<void>("plugin_exchange_unpublish", { repoRoot, publishId }),

  // Plugin realtime (Commons W3a) — rail-backed plugin↔plugin messaging
  // gated on capability `realtime:channel[:topic-glob]`. Send returns
  // the event as carried so the runtime can loopback-emit it; poll is
  // ephemeral (a null cursor fast-forwards, never replays history).
  pluginRtSend: (
    pluginId: string,
    repoRoot: string,
    topic: string,
    payload: unknown,
  ) =>
    invoke<PluginRtEvent>("plugin_rt_send", {
      pluginId,
      repoRoot,
      topic,
      payload,
    }),
  pluginRtPoll: (pluginId: string, repoRoot: string, sinceSeq: number | null) =>
    invoke<PluginRtPollResult>("plugin_rt_poll", {
      pluginId,
      repoRoot,
      sinceSeq,
    }),

  // Commons Lounge (W2) — emoji reactions on ship-log entries. Durable
  // (full-history fetch, seq-ordered toggle replay), unlike the realtime
  // lane above. `loungeReact` returns the row for optimistic apply.
  loungeReact: (
    repoRoot: string,
    eventId: string,
    emoji: string,
    add: boolean,
  ) =>
    invoke<LoungeReactionRow>("lounge_react", {
      repoRoot,
      eventId,
      emoji,
      add,
    }),
  loungeReactions: (repoRoot: string) =>
    invoke<LoungeReactionsResult>("lounge_reactions", { repoRoot }),

  // MCP servers (post-W4 pivot — see `cmd_mcp_servers.rs`). Configs at
  // `~/.aura/mcp/<name>.json`. `mcpToolsList` spawns each enabled server
  // once to read its tools catalog; the renderer caches the result.
  mcpServersList: () => invoke<McpServerEntry[]>("mcp_servers_list"),
  mcpServersAdd: (input: {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    description?: string | null;
    // Wave C — optional remote-transport fields. Empty strings are
    // treated as None by the backend, so callers can pass through
    // form values verbatim without three-way null/undefined logic.
    serverUrl?: string | null;
    oauthClientId?: string | null;
    oauthScope?: string | null;
  }) =>
    invoke<McpServerEntry>("mcp_servers_add", {
      name: input.name,
      command: input.command,
      args: input.args,
      env: input.env,
      description: input.description ?? null,
      serverUrl: input.serverUrl ?? null,
      oauthClientId: input.oauthClientId ?? null,
      oauthScope: input.oauthScope ?? null,
    }),
  mcpServersRemove: (name: string) =>
    invoke<void>("mcp_servers_remove", { name }),
  mcpServersToggle: (name: string, enabled: boolean) =>
    invoke<McpServerEntry>("mcp_servers_toggle", { name, enabled }),
  /** Wave A — patch the env block on an existing MCP server. Empty
   *  values clear a key; absent keys leave previous values intact.
   *  Used by AuthSetupModal so users can paste tokens without touching
   *  the command/args. */
  mcpServersUpdateEnv: (name: string, env: Record<string, string>) =>
    invoke<McpServerEntry>("mcp_servers_update_env", { name, env }),
  /** Wave B — kick off an interactive auth dance for an mcp-remote /
   *  remote-URL server. Backend spawns the configured command, streams
   *  stderr to Tauri events (`mcp:auth_log:<name>`, `mcp:auth_url:<name>`),
   *  and returns the exit code + captured log once the child exits or
   *  hits the 5min timeout. */
  mcpServersAuthRun: (name: string) =>
    invoke<McpAuthRunResult>("mcp_servers_auth_run", { name }),
  /** Wave C — patch remote-transport fields on an existing MCP server
   *  config. Empty strings clear a field; absent keys preserve the
   *  current value (same semantics as mcpServersUpdateEnv). */
  mcpServersUpdateUrl: (
    name: string,
    patch: {
      serverUrl?: string;
      oauthClientId?: string;
      oauthScope?: string;
    },
  ) =>
    invoke<McpServerEntry>("mcp_servers_update_url", {
      name,
      serverUrl: patch.serverUrl ?? null,
      oauthClientId: patch.oauthClientId ?? null,
      oauthScope: patch.oauthScope ?? null,
    }),
  /** Wave C — run the native OAuth 2.1 + PKCE flow against the server's
   *  configured remote URL. Opens the authorize URL in the user's
   *  browser, listens on a loopback port for the callback, exchanges
   *  the code for tokens, and stores them in the OS keychain. Emits
   *  `mcp:auth_log:<name>` + `mcp:auth_url:<name>` events so the UI
   *  can stream progress + render a manual fallback link. */
  mcpServersOauthStart: (name: string) =>
    invoke<void>("mcp_servers_oauth_start", { name }),
  /** Wave C — purge the stored OAuth tokens for a server so the user
   *  can re-authenticate from scratch. No-op if no tokens are stored. */
  mcpServersOauthClear: (name: string) =>
    invoke<void>("mcp_servers_oauth_clear", { name }),
  mcpToolsList: () => invoke<McpServerToolList[]>("mcp_tools_list"),
  mcpToolInvoke: (
    server: string,
    tool: string,
    args: Record<string, unknown> | unknown,
  ) =>
    invoke<McpToolInvokeResult>("mcp_tool_invoke", {
      server,
      tool,
      args,
    }),
  /** QQ.2 — Scan Claude Code, Claude Desktop, Cursor, Windsurf, Cline,
   *  Zed, opencode, Gemini CLI + repo-local `.mcp.json` for already-
   *  configured MCP servers. Returns one row per discovered entry with
   *  `already_imported` set when Aura's catalog already has it. */
  mcpServersDiscoverAgents: (repoRoot?: string) =>
    invoke<DiscoveredMcp[]>("mcp_servers_discover_agents", {
      repoRoot: repoRoot ?? null,
    }),
  /** QQ.2 — Adopt N discovered servers into Aura's catalog. Skips any
   *  whose `already_imported` flag is set so a stale picker state
   *  doesn't double-write. Returns the list of newly created rows. */
  mcpServersImportDiscovered: (entries: DiscoveredMcp[]) =>
    invoke<McpServerEntry[]>("mcp_servers_import_discovered", {
      entries,
    }),

  // Per-developer LLM token spend (admin Team View). `scope` is "org" for
  // admins and "self" for regular members.
  cloudBillingUsageByMember: (month?: string) =>
    invoke<BillingUsageByMember>("cloud_billing_usage_by_member", {
      month: month ?? null,
    }),

  // Mint a LiveKit JWT for the per-channel huddle. Direct HTTP (not
  // tauri::invoke), so it carries the cloud bearer itself: `mint_token`
  // runs the same `room_auth` gate as chat, so once
  // AURA_ROOMS_REQUIRE_AUTH is on an unauthenticated or non-member mint is
  // rejected. Signed out → empty headers → legacy behaviour while the
  // server still allows it. See `aura-cloud/src/calls.rs`.
  callsToken: async (args: {
    roomId: string;
    channel: string;
    identity: string;
    displayName: string;
  }): Promise<CallToken> => {
    // A huddle that won't start is almost always a SERVER-side gap — LiveKit
    // URL/API-key/secret unset, or the SFU unreachable — not a client bug. The
    // old code threw `callsToken: 500`, which told the user nothing and read as
    // a generic "Huddle start failed". Surface the real reason: distinguish a
    // network failure (can't even reach the server) from an HTTP error, and on
    // an HTTP error fold in the server's own response body plus a plain-language
    // hint for the status codes that mean "voice isn't provisioned here".
    let r: Response;
    try {
      r = await fetch("https://auravcs.com/api/v1/call/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await roomAuthHeaders()),
        },
        body: JSON.stringify({
          room_id: args.roomId,
          channel: args.channel,
          identity: args.identity,
          display_name: args.displayName,
        }),
      });
    } catch (e) {
      throw new Error(
        `Couldn't reach the voice server${
          e instanceof Error && e.message ? ` (${e.message})` : ""
        }. Check your connection and that the huddle service is running.`,
      );
    }
    if (!r.ok) {
      let detail = "";
      try {
        const text = await r.text();
        if (text) {
          try {
            const j = JSON.parse(text) as { error?: string; message?: string };
            detail = j.error || j.message || text;
          } catch {
            detail = text;
          }
        }
      } catch {
        /* body unreadable — fall back to the status alone */
      }
      const provisioningHint =
        r.status === 404 || r.status === 501 || r.status === 503
          ? " Voice may not be enabled on this server (LiveKit isn't configured)."
          : "";
      throw new Error(
        `Couldn't start the huddle (${r.status})${
          detail ? `: ${detail.slice(0, 300)}` : ""
        }.${provisioningHint}`,
      );
    }
    return (await r.json()) as CallToken;
  },

  // ── Modes + Marketplace (v0.2.32 MM.1) ────────────────────────────
  //
  // Mirrors `cmd_modes.rs`. Modes are portable specialist personas
  // stored as YAML under `~/.aura/modes/`. Bundled defaults
  // (architect/code/debug) ship inside the binary; the marketplace
  // adds user-published modes. Every install is content-pinned with
  // blake3 so a silent upstream rewrite is detected on next refresh.
  modesMarketplaceList: () =>
    invoke<MarketplaceIndex>("modes_marketplace_list"),
  modesMarketplaceRefresh: () =>
    invoke<MarketplaceIndex>("modes_marketplace_refresh"),
  modesInstallFromUrl: (args: {
    url: string;
    expectedPin?: string | null;
    advancedAcknowledged?: boolean;
  }) =>
    invoke<ModeDescriptor>("modes_install_from_url", {
      args: {
        url: args.url,
        expected_pin: args.expectedPin ?? null,
        advanced_acknowledged: args.advancedAcknowledged ?? false,
      },
    }),
  modesListInstalled: () => invoke<ModeDescriptor[]>("modes_list_installed"),
  modesUninstall: (slug: string) =>
    invoke<void>("modes_uninstall", { slug }),
  modesEdit: (slug: string, yaml: string) =>
    invoke<ModeDescriptor>("modes_edit", { slug, yaml }),
  modesPublishToGist: (args: { slug: string; description?: string | null }) =>
    invoke<ModePublishResult>("modes_publish_to_gist", {
      args: {
        slug: args.slug,
        description: args.description ?? null,
      },
    }),
  modesSearch: (query: string) =>
    invoke<ModeDescriptor[]>("modes_search", { args: { query } }),
  modesEnable: (slug: string) => invoke<void>("modes_enable", { slug }),
  modesDisable: (slug: string) => invoke<void>("modes_disable", { slug }),
  modesCheckUpdates: () => invoke<ModeUpdateRow[]>("modes_check_updates"),
  modesValidateYaml: (yaml: string) =>
    invoke<ModeValidationReport>("modes_validate_yaml", { yaml }),

  /** Resolve a parked agent gate (destructive-op safety prompt). When the
   *  agent is blocked awaiting a human decision, this releases it:
   *  `allow=true` lets the tool call proceed, `allow=false` denies it with
   *  an optional human-readable `note` sent back to the agent. */
  agentGateResolve: (gateId: string, allow: boolean, note?: string) =>
    invoke<void>("agent_gate_resolve", { gateId, allow, note }),

  // ── VS Code extensions (Tier 0 — declarative content from Open VSX) ──────
  // Open VSX (Eclipse Foundation) is the only gallery a non-Microsoft product
  // may legally use; the Rust side host-pins downloads to it. No extension code
  // is ever executed — only themes / language-config / snippets / grammars are
  // read back through `vsixReadText` and applied to Monaco.

  /** Search the Open VSX gallery. Listing metadata only — no code fetched. */
  vsixSearch: (query: string, size?: number) =>
    invoke<OpenVsxHit[]>("vsix_search", { query, size }),
  /** Browse the gallery without a search term — curated rows by category
   *  ("Themes", "Programming Languages", "Snippets", …) and/or popularity.
   *  `sort` ∈ "downloads" | "rating" | "updated" | "relevance". */
  vsixBrowse: (
    category?: string | null,
    sort?: "downloads" | "rating" | "updated" | "relevance",
    size?: number,
  ) => invoke<OpenVsxHit[]>("vsix_browse", { category, sort, size }),
  /** Preview what an extension would actually contribute — read straight from
   *  the gallery manifest, WITHOUT downloading or extracting the `.vsix`. Lets
   *  Discover be honest before the user installs. */
  vsixPreviewContributes: (namespace: string, name: string) =>
    invoke<ContributesSummary>("vsix_preview_contributes", { namespace, name }),
  /** Install by namespace + name (+ optional version) from Open VSX. */
  vsixInstall: (namespace: string, name: string, version?: string) =>
    invoke<InstalledExtension>("vsix_install", { namespace, name, version }),
  /** Install from a local `.vsix` the user picked from disk. */
  vsixInstallFile: (path: string) =>
    invoke<InstalledExtension>("vsix_install_file", { path }),
  /** Every installed extension Aura currently knows about. */
  vsixList: () => invoke<InstalledExtension[]>("vsix_list"),
  /** Read a UTF-8 asset (manifest, theme/grammar/snippet file) jailed to the
   *  extension's own package root. */
  vsixReadText: (id: string, rel: string) =>
    invoke<string>("vsix_read_text", { id, rel }),
  /** Enable/disable an installed extension (disabled = router skips it). */
  vsixSetEnabled: (id: string, enabled: boolean) =>
    invoke<void>("vsix_set_enabled", { id, enabled }),
  /** Uninstall: drop the index entry and delete the bundle from disk. */
  vsixRemove: (id: string) => invoke<void>("vsix_remove", { id }),

  // ── Node extension host (Tier 2 — runs language extensions + their LSP) ──────
  // The sidecar is a single Node process (`resources/ext-host/host.js`) that runs
  // every enabled Node VS Code extension and bridges their language servers to
  // Monaco. The frontend drives it with JSON-line messages over `ext_host_send`
  // and listens to `ext-host:msg` / `ext-host:exit` / `ext-host:log` for replies.
  /** Spawn the host if not already running; returns the resolved node path. */
  extHostStart: () => invoke<string>("ext_host_start"),
  /** Push one JSON-encoded protocol message to the host's stdin. */
  extHostSend: (json: string) => invoke<void>("ext_host_send", { json }),
  /** True when the sidecar process is alive. */
  extHostStatus: () => invoke<boolean>("ext_host_status"),
  /** Kill the sidecar (e.g. when the last node extension is disabled). */
  extHostStop: () => invoke<void>("ext_host_stop"),
};

/** The GitHub owner (user or org) of a repo's `origin` remote, or `null`
 *  off GitHub. Used to render the owner's avatar on the workspace tile in
 *  place of a generic folder glyph (see `lib/repoAvatar.ts`). */
export async function repoGithubOwner(repoRoot: string): Promise<string | null> {
  return invoke("repo_github_owner", { repoRoot });
}

/** Per-project settings for the copies an agent works in — the startup /
 *  run / archive scripts, which branch new copies start from, and the
 *  out-of-git files (like `.env`) to seed into each fresh copy. All fields
 *  are null/empty when nothing has been configured for this project yet. */
export type RepoWorktreeSettings = {
  setup: string | null;
  run: string | null;
  archive: string | null;
  base: string | null;
  copyFiles: string[];
  namedScripts: Array<{ name: string; command: string }>;
};

/** Read this project's copy-and-scripts settings. Returns all-null /
 *  empty when nothing is configured. */
export async function repoWorktreeSettingsGet(
  repoRoot: string,
): Promise<RepoWorktreeSettings> {
  return invoke("repo_worktree_settings_get", { repoRoot });
}

/** Persist this project's copy-and-scripts settings. */
export async function repoWorktreeSettingsSet(
  repoRoot: string,
  settings: RepoWorktreeSettings,
): Promise<void> {
  return invoke("repo_worktree_settings_set", { repoRoot, settings });
}

export type CallToken = { url: string; token: string; room: string };

export type BillingMemberModelRow = {
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
};

export type BillingMemberRow = {
  developer_id: string;
  github_login: string;
  display_name: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  by_model: BillingMemberModelRow[];
};

export type BillingUsageByMember = {
  month: string;
  scope: "org" | "self";
  role: string;
  members: BillingMemberRow[];
  total_cost_usd: number;
};

// ── plugin host (W0.3) ──────────────────────────────────────────────
//
// Mirrors `cmd_plugin::PluginRow` on the Rust side. `kind` is the lower-
// case label the Rust facade emits — same string the enable/disable
// commands expect back. `install_dir` is the absolute path under
// `~/.aura/plugins/<scope>/<name>`, useful for the "Reveal in Finder"
// affordance in the Plugins panel.

export type PluginKind = "plugin" | "skill" | "mcp";

export type PluginRow = {
  id: string;
  kind: PluginKind;
  version: string;
  enabled: boolean;
  install_dir: string;
  capabilities_count: number;
  description: string | null;
  /** Install-bundle id (`@scope/name`) — the secrets namespace shared
   *  by every manifest in the bundle. Settings keys its secret rows by
   *  this. `null` when install_dir is too shallow to derive it. */
  bundle: string | null;
  /** Bundle signature verdict. Tampered bundles never appear in the
   *  list — the registry rejects them at scan time, so `invalid` has
   *  no row to badge. */
  signature: "unsigned" | "verified" | "unknown_key";
  /** Publisher label from the trust store when verified; the bare key
   *  id when the key is unknown; `null` when unsigned. */
  signed_by: string | null;
};

/** One secret row for the Settings → Plugins secrets editor. Values
 *  never cross the bridge — only existence (`set`). */
export type PluginSecretRow = {
  key: string;
  title: string | null;
  url: string | null;
  set: boolean;
  source: "declared" | "referenced";
};

export type PluginRescanResult = {
  loaded: number;
  rejected: PluginRescanRejection[];
};

// ── Plugin Exchange (Commons W1, #308) ───────────────────────────────
//
// Team plugin sharing over the live chat rail. Mirrors
// `plugin_exchange::{ExchangeRow, InstallResult}`. Listing fields are
// flattened into the row by serde.

export type ExchangePublisher = {
  key_id: string;
  public_key_b64: string;
  label: string;
  device_id: string;
  display: string;
};

export type ExchangeListing = {
  publish_id: string;
  bundle_id: string;
  version: string;
  name: string;
  description: string;
  capabilities: string[];
  publisher: ExchangePublisher;
  archive_sha256: string;
  ts: number;
};

export type ExchangeRow = ExchangeListing & {
  /** A bundle with this id exists in the local install root. */
  installed: boolean;
  /** The publisher's key is in this machine's trust store. */
  trusted: boolean;
  /** Published from this device. */
  mine: boolean;
};

export type ExchangePollResult = {
  changed: boolean;
  new_listings: string[];
  removed: string[];
  next_seq: number;
};

export type ExchangeInstallResult = {
  installed: boolean;
  /** Set when the publisher isn't trusted yet — show the fingerprint
   *  and offer an explicit Trust action (never auto-trust). */
  needs_trust?: { key_id: string; label: string };
  install_dir?: string;
};

export type PluginRtEvent = {
  topic: string;
  payload: unknown;
  from_device: string;
  from_display: string;
  ts: number;
};

export type PluginRtPollResult = {
  events: PluginRtEvent[];
  /** Highest rail seq seen — the cursor for the next poll. */
  next_seq: number | null;
};

// ── Commons Lounge (W2) ──────────────────────────────────────────────

/** One react/unreact toggle from the `__aura_ship_log` rail channel. */
export type LoungeReactionRow = {
  op: string;
  event_id: string;
  emoji: string;
  device_id: string;
  display: string;
  ts: number;
  /** Rail seq; null for the optimistic local echo. */
  seq: number | null;
};

export type LoungeReactionsResult = {
  rows: LoungeReactionRow[];
  /** This device's id — marks which reaction chips are "mine". */
  self_device: string;
};

export type PluginRescanRejection = {
  path: string;
  reason: string;
};

// ── MCP servers (post-W4 pivot) ──────────────────────────────────────
//
// Mirrors `cmd_mcp_servers::McpServerEntry`. `status` is best-effort —
// "unknown" until the first `mcpToolsList()` succeeds, then "ok" or
// "error: ...". Disabled servers always report "disabled".

export type McpServerEntry = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  description: string | null;
  status: string;
  // Wave C — remote transport + native OAuth fields. Mirror the Rust
  // McpServerEntry; `null` rather than `undefined` so serde-default
  // skipping shows up unambiguously on the wire.
  server_url: string | null;
  oauth_client_id: string | null;
  oauth_scope: string | null;
  /** True iff a token blob is stored in the OS keychain under
   *  (service: aura-mcp-oauth, account: name). Lets the UI tell
   *  "needs auth" from "already authenticated". */
  has_oauth_token: boolean;
  /** Set when this server comes from a plugin bundle (`aura.mcp.json`)
   *  rather than a `~/.aura/mcp/*.json` file. Plugin servers can be
   *  toggled but not removed/env-edited here — manage the bundle in
   *  Settings → Plugins. */
  plugin_id: string | null;
};

export type McpToolInfo = {
  server: string;
  name: string;
  description: string | null;
  /** JSON schema for the tool's input arguments. May be `null`. */
  input_schema: unknown;
};

export type McpServerToolList = {
  server: string;
  ok: boolean;
  error: string | null;
  tools: McpToolInfo[];
};

// QQ.2 — Discovered MCP entry from another agent's config. The picker
// surfaces these with their `source` label so users see which tool
// already trusts each token.
export type DiscoveredMcp = {
  name: string;
  source: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  already_imported: boolean;
  // Wave C — pre-stamped remote MCP URL when the source agent config
  // already knew it (Claude Desktop remote MCP entries, the canonical
  // `npx -y mcp-remote <url>` proxy, or explicit url/serverUrl/endpoint
  // fields). `null` for plain stdio entries — import path falls back
  // to scanning args.
  server_url: string | null;
};

// Wave B — outcome of an interactive auth run. `exitCode === 0` means
// the proxy completed OAuth and cached the token; null + `timedOut`
// true means we killed the child at the 5-min mark.
export type McpAuthRunResult = {
  exit_code: number | null;
  timed_out: boolean;
  log: string;
};

export type McpToolInvokeResult = {
  server: string;
  tool: string;
  ok: boolean;
  /** Pretty-printed text body — flattened from MCP `content[]`. */
  text: string;
  raw: unknown;
  error: string | null;
};

// Manifest `contributes` block per enabled native plugin. Other kinds
// (skill / mcp) don't contribute UI surfaces. Field names match the
// camelCase used in the JSON manifest schema — Rust serde preserves
// the rename annotations.

export type PluginSlashCommandContrib = {
  id: string;
  title: string;
  description?: string;
};

export type PluginRailTileContrib = {
  id: string;
  label: string;
  icon?: string;
  defaultPinned?: boolean;
};

export type PluginRightRailPanelContrib = {
  id: string;
  title: string;
  entry: string;
  linkedRailTile?: string;
};

export type PluginStatusPillContrib = {
  id: string;
  /** "worker:status" or another well-known render kind. */
  render: string;
};

export type PluginAppContrib = {
  id: string;
  title: string;
  /** HTML entry, relative to install_dir — loaded through the jailed
   *  asset reader and mounted as a sandboxed full-surface iframe. */
  entry: string;
  icon?: string;
};

export type PluginContributesRow = {
  plugin_id: string;
  version: string;
  /** Manifest worker entry, relative to install_dir. The runtime loads
   *  it via `pluginAssetRead` and spawns a blob Worker. */
  entry: string;
  install_dir: string;
  /** Raw capability strings — parsed into a CapabilitySet by the
   *  bridge before any host call is allowed through. */
  capabilities: string[];
  slash_commands: PluginSlashCommandContrib[];
  rail_tiles: PluginRailTileContrib[];
  right_rail_panels: PluginRightRailPanelContrib[];
  status_pills: PluginStatusPillContrib[];
  /** Full-surface mini-apps — open in the center WorkSurface, not the
   *  narrow rail. Listed by the Commons "Apps" launcher. */
  apps: PluginAppContrib[];
  /** Id of the MCP server bundled in the same install dir, when one
   *  exists and is enabled. The runtime routes the `mcp.call` host
   *  method exclusively to this server. */
  mcp_server_id: string | null;
};

export type PluginNetFetchRequest = {
  url: string;
  method?: string;
  headers?: [string, string][];
  body?: string;
};

export type PluginNetFetchResponse = {
  status: number;
  headers: [string, string][];
  body: string;
  truncated: boolean;
};

export type ProcessRow = {
  pid: number;
  name: string;
  cpu_percent: number;
  memory_mb: number;
};

export type ResourceSnapshot = {
  cpu_percent: number;
  used_memory_mb: number;
  total_memory_mb: number;
  app_share_percent: number;
  aura_memory_mb: number;
  processes: ProcessRow[];
};

// ── PR workspace (Stage 7A) ──────────────────────────────────────────

export type PrSummary = {
  number: number;
  title: string;
  state: string;
  author: string;
  head_ref: string;
  base_ref: string;
  is_draft: boolean;
  additions: number;
  deletions: number;
  created_at: string;
  updated_at: string;
  review_decision: string | null;
  url: string;
  aura_risk_score: number | null;
  aura_risk_label: string | null;
  /** "success" | "failure" | "pending" | null */
  checks_state: string | null;
  checks_total: number;
  checks_passing: number;
  checks_failing: number;
  checks_pending: number;
  /** True when gh viewer login matches the PR author. Drives Inbox
   *  bucketing (Drafts / Waiting reviewers / Returned-to-you / Approved). */
  is_authored_by_me: boolean;
  /** True when gh viewer is in `reviewRequests` for this PR. Drives
   *  "Needs your review" / "Waiting for author" buckets. */
  is_review_requested_for_me: boolean;
  /** Labels attached to this PR (Stage 8D). Includes name + GitHub
   *  colour hex without `#` prefix + optional description. */
  labels: PrLabel[];
};

export type PrCreated = {
  number: number;
  title: string;
  url: string;
};

export type GithubIssue = {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  labels: string[];
  url: string;
  created_at: string;
  updated_at: string;
};

export type PrLabel = {
  name: string;
  /** GitHub colour hex without `#` (e.g. `"a2eeef"`). Empty when
   *  GitHub didn't provide one. */
  color: string;
  description: string;
};

export type PrFileStat = {
  path: string;
  additions: number;
  deletions: number;
};

/** A plain-language finding card produced by the engine's `pr_humanize`
 *  layer — repetition folded into `count`, with where/why/what-to-do. */
export type AuraHumanFinding = {
  severity: "critical" | "warning" | "advisory" | "info";
  category: string;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  symbol?: string;
  count: number;
  suggestion?: string;
};

export type AuraChangedSymbol = {
  name: string;
  action: string;
  line?: number;
  kind?: string;
};

/** Per-file "what changed and why" — the captured intent paired with a change
 *  so a reviewer can decide without reading code. */
export type AuraChangeIntent = {
  file: string;
  what: string;
  symbols: AuraChangedSymbol[];
  why?: string;
  when?: number;
  who?: string;
};

export type AuraReviewPayload = {
  ts: number;
  base_branch: string;
  risk_score: number;
  risk_label: string;
  total_changes: number;
  invariant_violations: string[];
  blast_radius: string[];
  cross_branch_conflicts: string[];
  omni_graph_impact: string[];
  /** Advisory taste-engine violations (file: reason, rule, confidence).
   *  Optional — older review JSONs predate the field. */
  taste_findings?: string[];
  unverified_nodes: unknown;
  /** Plain-language one-paragraph overview. Optional — older binaries omit it. */
  summary?: string;
  /** Humanized, deduped finding cards. When present the UI renders these
   *  instead of parsing the raw `*_violations` arrays. */
  findings?: AuraHumanFinding[];
  /** Per-file intent behind the changes (what/why/where/when/who). */
  changes?: AuraChangeIntent[];
};

export type PrDetail = {
  number: number;
  title: string;
  state: string;
  body: string;
  author: string;
  head_ref: string;
  base_ref: string;
  is_draft: boolean;
  mergeable: string | null;
  additions: number;
  deletions: number;
  created_at: string;
  updated_at: string;
  review_decision: string | null;
  url: string;
  files: PrFileStat[];
  diff: string;
  /** v0.2.12 — populated when every diff strategy failed (gh non-zero +
   *  git fallback errored or timed out). UI surfaces this verbatim in
   *  the per-file "No diff body" fallback so users see the real cause
   *  instead of a generic empty state. */
  diff_error?: string | null;
  aura_review: AuraReviewPayload | null;
  reviewers: PrReviewer[];
  /** Stage 8J — assignee logins from `gh pr view --json assignees`. */
  assignees: string[];
  /** Stage 8J — populated only when state === "MERGED". */
  merged_by: string | null;
  merged_at: string | null;
  /** Stage 8J — closing-issue cross-references; surfaced in the
   *  right-rail Related tasks card. */
  related_issues: PrRelatedIssue[];
};

export type PrRelatedIssue = {
  number: number;
  title: string;
  url: string;
  /** "OPEN" | "CLOSED". */
  state: string;
};

/** One status check on a PR, flattened from GitHub's statusCheckRollup.
 *  `bucket` is the plain traffic-light the Checks tab groups + colors by;
 *  `raw` is GitHub's own word (SUCCESS / FAILURE / IN_PROGRESS / …) for the
 *  tooltip. `url` opens the run's logs; empty when GitHub gave no link. */
export type PrCheck = {
  name: string;
  /** "success" | "failure" | "pending" */
  bucket: string;
  raw: string;
  url: string;
  /** Workflow name for Actions runs; empty for external status contexts. */
  workflow: string;
  description: string;
};

export type PrReviewer = {
  login: string;
  /** "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" */
  state: string;
};

// ── Stage 7B / 7D ────────────────────────────────────────────────────

export type PrComment = {
  id: number;
  node_id: string;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
  /** Inline-only — issue comments have null path/line/side. */
  path: string | null;
  line: number | null;
  /** SS.3.2 — multi-line range. When set, `line` is the END of the
   *  range and `start_line` is the start. Single-line comments leave
   *  this null. Side is shared across the range (GitHub forbids mixed). */
  start_line: number | null;
  side: string | null;
  in_reply_to: number | null;
  is_issue_comment: boolean;
  thread_node_id: string | null;
  thread_resolved: boolean;
  /** Stage 8M — emoji reactions. Empty when GraphQL fetch failed. */
  reactions: PrCommentReaction[];
};

export type ReactionContent =
  | "THUMBS_UP"
  | "THUMBS_DOWN"
  | "LAUGH"
  | "HOORAY"
  | "CONFUSED"
  | "HEART"
  | "ROCKET"
  | "EYES";

export type PrCommentReaction = {
  content: ReactionContent;
  count: number;
  viewer_reacted: boolean;
};

export type PrStackNode = {
  number: number;
  title: string;
  head_ref: string;
  base_ref: string;
  author: string;
  state: string;
  is_draft: boolean;
  aura_risk_score: number | null;
  url: string;
  children: number[];
  parent: number | null;
  /** True when this branch's parent came from Graphite's local stack
   *  metadata (`refs/branch-metadata/`) rather than the GitHub base ref —
   *  the branch is part of a `gt`-managed stack. Lets the UI show a
   *  "Graphite stack" chip only when the stack is genuinely Graphite's. */
  gt_managed: boolean;
};

/** A Vercel deployment for a PR's head commit — the deploy chip on the PR
 *  checks view. Null from `prVercelStatus` when Vercel isn't configured or
 *  has no deployment for the commit yet. */
export type VercelDeployment = {
  /** Deployment id (`dpl_…`). */
  uid: string;
  /** Vercel readyState, uppercase: READY | BUILDING | ERROR | QUEUED |
   *  CANCELED | INITIALIZING | UNKNOWN. The UI maps this to plain language. */
  state: string;
  /** Deploy host (no scheme), e.g. `my-app-abc123.vercel.app`. */
  url: string | null;
  /** Link into the Vercel dashboard for this deployment's build logs. */
  inspector_url: string | null;
  /** `production` | `staging` | null (a preview deploy). */
  target: string | null;
  /** Creation time, unix-millis. */
  created_at_ms: number | null;
};

export type CrashSummary = {
  path: string;
  timestamp_ms: number;
  panic_message: string;
  location: string | null;
  session_id: string | null;
};

/** Anonymous product-telemetry consent (mirrors telemetry.rs). `decided`
 *  gates ALL sending until the first-run prompt is answered; `product` and
 *  `crash` are the two independent switches. */
export type TelemetryConsent = {
  decided: boolean;
  product: boolean;
  crash: boolean;
};

export type MemoryEntry = {
  id: string;
  content: string;
  tags: string[];
  added_by: string;
  added_at: number;
  // W2 provenance pass-through (stamped by aura-cli, declared in
  // cmd_memory.rs::MemoryEntry). serde uses skip_serializing_if, so the
  // keys are simply absent when unstamped — hence optional, snake_case
  // to match the wire format exactly. `embedding` is intentionally never
  // sent to the frontend.
  /** HEAD short sha at write time. */
  source_commit?: string;
  /** Code anchor, `<repo-relative-path>#<identifier>`. */
  source_symbol?: string;
  /** sha256 (hex) of the symbol's source text at write time. */
  source_symbol_hash?: string;
  /** Intent-log row id the memory was written under. */
  intent_id?: string;
  /** key_id that signed that intent row. */
  signer_key_id?: string;
  /** RFC3339 — when this fact became valid. */
  valid_from?: string;
  /** RFC3339 — reserved for supersession windows. */
  valid_to?: string;
};

export type MemorySection = {
  name: string;
  entries: MemoryEntry[];
};

export type MemoryView = {
  identity: string;
  stack: string[];
  sections: MemorySection[];
  last_updated: number;
};

/** Result of `aura memory import-claude-code --json` (mirror of
 *  cmd_memory.rs::ClaudeImportReport). `imported`/`updated`/`deduped` are
 *  the reconcile outcomes; `by_section` maps each Aura section to how many
 *  facts landed there. On a dry run nothing is written and `imported` is the
 *  upper bound. `found === false` + `message` cover the no-memory case. */
export type ClaudeImportReport = {
  imported: number;
  deduped: number;
  updated: number;
  total: number;
  by_section: Record<string, number>;
  dry_run: boolean;
  source_dir?: string | null;
  found?: boolean;
  message?: string | null;
};

export type SessionSummary = {
  session_id: string;
  agent_id: string;
  phase: string;
  started_at: number;
  last_activity: number;
  files_touched: string[];
  checkpoint_count: number;
  base_commit: string;
  worktree: string;
};

export type SettingsView = {
  ai_provider: string | null;
  gemini_key_last4: string | null;
  anthropic_key_last4: string | null;
  openai_key_last4: string | null;
  mercury_key_last4: string | null;
  strict_gatekeeper_mode: boolean;
  strict_mode_locked: boolean;
  telemetry_enabled: boolean;
  use_local_embeddings: boolean;
  dev_mode: boolean;
  sync_enabled: boolean;
  cloud_url: string | null;
  cloud_token_present: boolean;
  /** Absolute parent path used for managed worktrees. null = default
   *  (`~/.aura/worktrees`). Set via `settingsSetWorktreeBase`. */
  worktree_base_path: string | null;
};

export type TelemetryView = {
  enabled: boolean;
  counts: Record<string, number>;
  last_updated: number | null;
};

export type ClassifierPref = { keyword: string; score: number };

/** Mirrors `aura_agents::generic_cli::GenericProviderConfig`. The shell
 *  only edits TOML-declared providers — compiled-in ones (claude /
 *  gemini / codex / cursor / kimi) appear via `agentsList` but aren't
 *  managed by the Agents tab's CRUD. */
export type AgentsTomlEntry = {
  id: string;
  label: string;
  bin: string;
  args?: string[];
  args_oneshot?: string[] | null;
  args_stream?: string[] | null;
  args_pty?: string[] | null;
  classifier_prefs?: ClassifierPref[];
  cost_per_1k_in?: number | null;
  cost_per_1k_out?: number | null;
  supports_stream?: boolean;
  supports_pty?: boolean;
  supports_resume?: boolean;
  stdout_is_stream_json?: boolean;
  env?: Record<string, string>;
};

export type AgentConfigSyncStatus = {
  signedIn: boolean;
  localFiles: string[];
  remoteFiles: string[];
  remoteUpdatedAt: string | null;
  remoteSourceDevice: string | null;
  error: string | null;
};

export type AgentConfigApplyResult = {
  applied: string[];
  backups: string[];
  status: AgentConfigSyncStatus;
};

export type AgentDescriptor = {
  id: string;
  label: string;
  bin: string;
  available: boolean;
  version: string | null;
  capabilities: {
    stream: boolean;
    pty: boolean;
    resume: boolean;
  };
  cost_per_1k: { input_usd: number; output_usd: number } | null;
};

export type ProjectEntry = {
  id: string;
  label: string;
  root: string;
  last_opened_at: number;
};

export type ManagerStatus =
  | "awaiting_approval"
  | "running"
  | "paused"
  | "completed"
  | "cancelled";

export type ManagerTaskStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "manual_pending"
  | "skipped";

export type ManagerOverrideMode = "skip" | "rerun" | "reassign" | "take_over";

export type ProjectRef = {
  root: string;
  label: string;
};

export type ManagerTask = {
  id: number;
  description: string;
  agent_id: string | null;
  depends_on: number[];
  status: ManagerTaskStatus;
  project_root: string;
  zones: string[];
  blocked_reason: string | null;
  output: string;
  summary: string | null;
  started_at: number | null;
  completed_at: number | null;
  stream_channel: string | null;
  /** Per-task worktree path created on dispatch when zones are set.
   *  Null when the task ran in the main repo root. Visible to the user
   *  via the TaskCard footer + the workspace tile worktree menu. */
  worktree_path?: string | null;
  /** A2A v1.2 task id minted at plan-build time. Links this local DAG
   *  row to the remote a2a task in the cloud. Null when cloud sync is
   *  off or this task wasn't spawned via a propose-plan Build. */
  a2a_task_id?: string | null;
  /** Bucket L1 — durable file-level snapshot ids captured before this
   *  task's subagent started. One id per file in `zones` that existed
   *  at dispatch time. Surfaces as a `↺ N snapshots` Badge on the
   *  TaskCard. `aura rewind --task <id>` walks this list to revert
   *  every file the subagent touched in one shot. */
  pre_dispatch_snapshot_ids?: string[];
  /** Bucket O — bounded ring buffer of recent stdout/stderr lines (cap
   *  200) from the subagent. The TaskCard's expanded view renders these
   *  directly; the live stream comes from the
   *  `manager-task-stream:<sid>:<tid>` Tauri event. */
  recent_output?: string[];
  /** Bucket O — total lines streamed so far (monotonic; survives ring
   *  rotation). The TaskCard shows `≈N lines` and pulses on each new
   *  line so the user can see at a glance whether the subagent is
   *  alive without expanding the stream panel. */
  line_count?: number;
  /** Bucket F — mid-flight skill outcome. Filled incrementally as the
   *  5 signals (exit/duration, thumbs, pr-review pass, brain self-eval
   *  grade, token cost) arrive. Surfaced as the thumbs-up/down state on
   *  the TaskCard so a refresh shows the user's prior vote. */
  pending_skill?: PartialSkillOutcome | null;
};

export type PartialSkillOutcome = {
  provider_id: string;
  manager_session_id: string;
  manager_task_id: number;
  a2a_task_id?: string | null;
  exit_code?: number | null;
  duration_ms?: number | null;
  /** -1 thumbs-down, 0 unset, +1 thumbs-up. `null` = not yet rated. */
  user_rating?: number | null;
  pr_review_pass?: boolean | null;
  token_input?: number;
  token_output?: number;
  cost_usd?: number;
  brain_quality_grade?: number | null;
  brain_quality_reason?: string | null;
  taxonomy?: TaskTaxonomy;
  scout_run_id?: string | null;
  started_at?: number;
};

export type TaskTaxonomy = {
  coarse_category: string;
  fine_language?: string | null;
  fine_layer?: string | null;
  fine_intent?: string | null;
  free_tags?: string[];
  file_paths?: string[];
  file_extensions?: string[];
};

export type RibbonEvent =
  | { kind: "plan_ready" }
  | { kind: "task_dispatched"; task_id: number; agent_id: string; channel: string }
  | { kind: "task_completed"; task_id: number; exit_code: number }
  | { kind: "task_failed"; task_id: number; error: string }
  | { kind: "zone_collision"; task_id: number; claimer: string }
  | { kind: "manual_override"; task_id: number; mode: ManagerOverrideMode }
  | {
      kind: "rebase_conflict";
      task_id: number;
      onto_ref: string;
      files: string[];
    }
  | {
      kind: "semantic_alert";
      task_id: number;
      deletions: string[];
      reason: string;
    }
  | { kind: "manager_speech"; text: string }
  | { kind: "paused" }
  | { kind: "resumed" }
  | { kind: "cancelled" };

export type RibbonEntry = {
  at: number;
  event: RibbonEvent;
};

// `system` is a calm, non-conversational turn: a client-handled slash
// command's output (`/team`, `/loop`, …) persisted into `session.chat` so it
// survives a reload. The brain never authors one; it's appended via
// `manager_append_chat`. Renders as the quiet SystemCard, not an agent bubble.
export type ChatRole = "user" | "manager" | "system";

/** The `tool_result` half of a {@link PersistedToolCall} — the executed
 *  tool's output text plus whether it failed. Mirrors the Rust
 *  `PersistedToolResult` and the streaming `ToolResult`. */
export type PersistedToolResult = {
  is_error: boolean;
  content: string;
};

/** One persisted `tool_use`/`tool_result` pair on a {@link ChatTurn}.
 *  Mirrors the live stream's tool block so the settled timeline renders it
 *  through the very same `describeTool` → `ToolCard` path. `result` is
 *  absent for a call whose result never landed (cancelled mid-turn).
 *  Mirrors the Rust `PersistedToolCall`. */
export type PersistedToolCall = {
  tool_use_id: string;
  name: string;
  input: unknown;
  result?: PersistedToolResult | null;
};

export type ChatTurn = {
  role: ChatRole;
  text: string;
  at: number;
  /** Set when this user turn resolved a QuestionCard. Carries the
   *  originating question text so the timeline can render Q+A as one
   *  grouped element instead of an orphaned answer bubble. */
  answered_question?: string;
  /** Which brain produced this (Manager) turn — the persisted backend id
   *  (`"anthropic"` for the native Anthropic API, `"cli:<provider>"` for
   *  a CLI-wrapper agent, e.g. `"cli:gemini"`). Set by the legacy brain
   *  path; absent on native `brain_chat_turn` turns. Drives the WW-B3
   *  per-turn provenance chip so a conversation that swapped brains
   *  mid-stream stays attributable. Mirrors the Rust `ChatTurn.brain`. */
  brain?: string | null;
  /** Tool calls the brain made on this turn, in emission order, each
   *  paired with its result. Persisted so the settled timeline re-renders
   *  the tool cards on reload instead of dropping them when the live
   *  stream ends. Absent/empty on turns that called no tools and on
   *  history persisted before the field landed. Mirrors the Rust
   *  `ChatTurn.tool_calls`. */
  tool_calls?: PersistedToolCall[];
  /** Extended-thinking text the brain emitted before this turn's answer.
   *  The live native path treats reasoning as a cosmetic and never persists
   *  it; this field is populated only when a turn is HYDRATED from an agent
   *  CLI transcript (Claude/Gemini `--resume` import), where the thinking
   *  blocks are sitting on disk. Rendered as a collapsed reasoning
   *  disclosure ahead of the tool cards. Mirrors the Rust `ChatTurn.thinking`. */
  thinking?: string | null;
  /** Estimated tokens this turn SAVED by reaching for Aura's code-graph tools
   *  (the atlas map, `aura ask`) instead of grepping or reading whole files —
   *  summed across the turn's tool calls. An honest estimate (~3.5 chars/token,
   *  the engine's own constant), never a measured count, so the chip always
   *  reads "Saved ~N". Absent/0 on turns that used no token-saving tool, so the
   *  footer chip simply doesn't render. Mirrors the Rust `ChatTurn.saved_tokens`. */
  saved_tokens?: number | null;
  /** Per-turn token usage as reported by the brain — `input_tokens` = the
   *  prompt/context the turn processed, `output_tokens` = what the brain
   *  generated (the final round's figures). Populated on native-brain turns;
   *  absent on CLI-wrapper turns and history persisted before the fields, so
   *  the optional per-message readout simply doesn't render. Mirrors the Rust
   *  `ChatTurn.input_tokens` / `ChatTurn.output_tokens`. */
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Image attachments the user uploaded with this (user) turn. Persisted
   *  inline as base64 on the Rust `ChatTurn` so the bubble re-renders the
   *  thumbnails on reload — the same bytes the brain receives. Absent on
   *  assistant turns and on history persisted before the field. Mirrors the
   *  Rust `ChatTurn.attachments`. */
  attachments?: ChatImageAttachment[] | null;
};

/** One image a user attached to a chat turn, as persisted on the Rust
 *  `ChatTurn` (base64 inline). `data_base64` is the raw base64 with no
 *  `data:` URL prefix; `media_type` is the MIME label (`image/png`,
 *  `image/jpeg`, …); `name` is the original filename (cosmetic). */
export type ChatImageAttachment = {
  media_type: string;
  data_base64: string;
  name?: string | null;
};

/** Which backend powers a Manager session's brain. `id` examples:
 *  `"anthropic"`, `"cli:claude"`, `"cli:gemini"`. `label` is the
 *  human-friendly name to show in a chip ("Anthropic API", "Claude Code"). */
export type BrainBackendInfo = {
  id: string;
  label: string;
};

/** Brain stream delta — emitted as `manager-stream:<sid>` while the
 *  Anthropic-backed agentic loop runs. UI uses these to render a streaming
 *  bubble (TextDelta), inline tool cards (ToolUse + ToolResult), and
 *  finishes the turn on Done. */
export type QuestionShape = "choice" | "multi_choice" | "text";

/** One question inside a clubbed set. The brain may batch 1–4 of these in a
 *  single `ask_user` call (Claude `AskUserQuestion` shape) so a related
 *  cluster of decisions surfaces together as one card. `header` is an optional
 *  short label (chip) shown above the question. */
export type QuestionItem = {
  question: string;
  options: string[];
  kind: QuestionShape;
  header?: string;
};

export type PendingQuestion = {
  tool_use_id: string;
  question: string;
  options: string[];
  /** Backend serialises `QuestionKind` as `kind` on the persisted struct,
   *  so this matches `session.pending_question.kind` exactly. */
  kind: QuestionShape;
  at: number;
  /** The full clubbed set when the brain batched 1–4 questions. The
   *  top-level `question`/`options`/`kind` mirror `items[0]` for back-compat;
   *  when `items` is absent or has a single entry the card renders exactly as
   *  the single-question form always did. */
  items?: QuestionItem[];
};

/** A todo entry inside a `PendingPlan`. Mirrors `PlanTodo` in
 *  `aura-shell/src-tauri/src/cli_bridge.rs`. */
export type PendingPlanTodo = {
  description: string;
  /** Provider id ("claude" | "gemini" | "codex" | "cursor" | …). When
   *  null, the Manager will pick at dispatch time. */
  agent: string | null;
  /** Optional file refs scoped to this todo. Rendered as clickable
   *  chips in the PlanTab so the user sees exactly what the subagent
   *  will work on. */
  file_refs?: string[];
  /** Bucket N1 — teammate email/username this todo is assigned to.
   *  Threaded into the a2a task's `assignee_user_id` on Build, and
   *  rendered as an assignee badge on the PlanCard's todo row. */
  assignee?: string | null;
  /** Bucket G — auto-routing badge. When the Skill Ledger has ≥10
   *  samples for this todo's taxonomy cell, the historical best
   *  provider is surfaced on the PlanCard as a click-to-override
   *  badge. Null below threshold. */
  suggested_provider?: SkillSuggestion | null;
  /** What "done" looks like for this step, in plain language. Rendered
   *  as the goal line on the PlanCard, then minted as a provable goal
   *  linked to this step's task on Build. */
  goal?: string | null;
  /** The verify plan — the checks that confirm the goal is met.
   *  Rendered as a checklist under the goal, and stored on both the
   *  goal (`acceptance`) and the task on Build. */
  acceptance?: string[];
  /** Optional sub-steps. When present this todo is a grouping (an epic
   *  the Crew does not run directly) and each sub-step becomes its own
   *  runnable child task on Build, carrying its own goal + verify plan. */
  subtasks?: PendingPlanSubtask[];
};

/** One sub-step of a {@link PendingPlanTodo}. Rendered nested under its
 *  parent on the PlanCard, minted as a runnable child task on Build. */
export type PendingPlanSubtask = {
  description: string;
  agent?: string | null;
  /** What "done" looks like for this sub-step. */
  goal?: string | null;
  /** The verify plan for this sub-step's goal. */
  acceptance?: string[];
};

/** Auto-routing recommendation surfaced on a PendingPlanTodo. Mirrors
 *  `manager::skill::SkillSuggestion`. */
export type SkillSuggestion = {
  provider_id: string;
  score: number;
  sample_count: number;
};

/** One phase in the rich plan's implementation section. */
export type PlanPhase = {
  title: string;
  body: string;
  file_refs: string[];
};

/** Set when the CLI brain invokes `aura propose-plan` — UI renders a
 *  condensed inline PlanCard (title + summary + n todos + "Open" CTA)
 *  AND auto-opens the rich PlanTab in the WorkSurface. Rich fields are
 *  optional; brains can opt into Cursor-grade content (mermaid,
 *  baseline, phases, deliverables, tests) by including them in the
 *  `--json` envelope, otherwise the simple title/summary/todos shape
 *  still works.
 *
 *  Build/cancel reply hits `managerDecidePlan(sid, plan.id,
 *  "build" | "cancel")`. */
export type PendingPlan = {
  id: string;
  title: string;
  summary: string;
  objective?: string;
  baseline?: string;
  architecture_mermaid?: string;
  phases?: PlanPhase[];
  deliverables?: string[];
  tests?: string[];
  todos: PendingPlanTodo[];
  /** Bucket D — execution parallelism the user picked on the segmented
   *  control. Snapshotted onto the session at Build time. */
  parallelism?: PlanParallelism;
  /** Inventory blocker #3 (2026-05-20 audit) — explicit approval row.
   *  `approved_by` is the handle (`display_name` or `email`) of the user
   *  who clicked Approve; `approved_at` is unix-seconds. Both `null` for
   *  fresh plans and for any plan persisted before this field landed
   *  (backend uses `#[serde(default)]` for the migration). The shell
   *  also runs a heal-on-read normalizer in `persist::load` so a
   *  half-written pair (one Some + one None) never surfaces here. */
  approved_by?: string | null;
  approved_at?: number | null;
  at: number;
};

/** Returned by `managerApprovePlan` so the UI can render the
 *  "Approved by @handle" row immediately on click without waiting for
 *  the next `manager:<sid>` snapshot to round-trip. */
export type PlanApproval = {
  approved_by: string;
  approved_at: number;
};

export type PlanParallelism = "auto" | "parallel" | "serial";

// ── Orchestrator Mode (v0.2.31 LL.1, task #340) ───────────────────────

/** One specialist lane the parent orchestrator dispatches in parallel.
 *  Each lane runs through one `Brain::chat` in its own context window;
 *  the parent only sees the lane's summary, not the full transcript. */
export type LaneSpec = {
  objective: string;
  zones?: string[];
  /** Optional mode slug — `architect`/`code`/`debug` or a user-installed
   *  mode. The lane's system prompt is hydrated from the mode registry
   *  at dispatch time. */
  mode?: string | null;
  /** Optional provider override — `anthropic_native`,
   *  `cli_wrapper:claude_code`, etc. Null means "use the active brain". */
  brain_override?: string | null;
  /** Optional 4-lens taxonomy for this lane. When omitted (and no
   *  `brain_override` is set and auto-route is on), the dispatcher
   *  derives one from `objective` + `zones` and consults the Agent Skill
   *  Ledger to bind the historically best provider for the cell. */
  taxonomy?: TaskTaxonomy | null;
  label?: string | null;
};

// ── Automations ──────────────────────────────────────────────────────────
// Wire shapes mirror the Rust serde tags in `cmd_automations.rs`. Triggers and
// actions are internally-tagged on `kind`; BodySource on `source`.

export type Cadence = "hourly" | "daily" | "weekdays" | "weekly";

export type Trigger = {
  kind: "schedule";
  cadence: Cadence;
  /** "HH:MM" local wall time. */
  time_hm: string;
  /** 0=Mon … 6=Sun. Only used by the weekly cadence. */
  weekday?: number | null;
  /** Minutes east of UTC for the saved wall time (e.g. -300 for US-Eastern). */
  tz_offset_min: number;
};

export type WriteMode = "append" | "overwrite";

export type PageRef = {
  /** "team" | "channel" | "member". */
  scope: string;
  bucket: string;
  /** Existing note id, or null/omitted to mint a new Page. */
  id?: string | null;
  title?: string | null;
};

export type BodySource =
  | { source: "last_run_output" }
  | { source: "fixed"; text: string };

export type Action =
  | { kind: "run_agent"; agent: string; prompt: string; model?: string | null }
  | { kind: "run_pr_review"; base?: string | null }
  | {
      kind: "post_to_page";
      page: PageRef;
      mode: WriteMode;
      body_source: BodySource;
    }
  | {
      kind: "create_task";
      title: string;
      description?: string | null;
      agent_assignee?: string | null;
    };

export type AutomationRunRecord = {
  id: string;
  started_at: string;
  completed_at?: string | null;
  ok: boolean;
  summary: string;
  lane_id?: string | null;
  commit?: string | null;
};

export type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  action: Action;
  then_action?: Action | null;
  created_at: string;
  updated_at: string;
  last_run?: AutomationRunRecord | null;
  next_run_at?: string | null;
  last_fired_at?: string | null;
};

export type AutomationInput = {
  name: string;
  enabled: boolean;
  trigger: Trigger;
  action: Action;
  then_action?: Action | null;
};

/** One wave the orchestrator should fan out. */
export type WavePlan = {
  wave_id: string;
  lanes: LaneSpec[];
};

export type LaneStatus =
  | "queued"
  | "running"
  | "done"
  | "conflict"
  | "cancelled"
  | "failed";

export type ZoneConflict = {
  lane_id: string;
  blocker_lane_id: string;
  zone: string;
};

export type UnifiedChange = {
  lane_id: string;
  path: string;
  body: string;
};

export type LaneOutcome = {
  lane_id: string;
  wave_id: string;
  spec: LaneSpec;
  status: LaneStatus;
  provider_id?: string | null;
  transcript?: string;
  summary?: string | null;
  error?: string | null;
  started_at: number;
  completed_at?: number | null;
  /** Estimated tokens the lane's raw transcript produced (~3.5 chars/tok). */
  transcript_tokens?: number;
  /** Estimated tokens of the summary the parent manager actually reads. */
  summary_tokens?: number;
  /** transcript_tokens − summary_tokens: context summarisation kept out
   *  of the coordinator's window. */
  saved_tokens?: number;
};

/** Wave-level token ledger — the honest "what did the Orchestrator cost
 *  vs. save" meter. All figures are heuristic ~3.5-chars/token estimates,
 *  never provider-billed counts, so the UI renders them with a "~". */
export type TokenLedger = {
  lane_count: number;
  done_lanes: number;
  transcript_tokens: number;
  summary_tokens: number;
  saved_tokens: number;
  overhead_tokens: number;
};

export type WaveOutcome = {
  wave_id: string;
  lanes: LaneOutcome[];
  conflicts: ZoneConflict[];
  unified_changes: UnifiedChange[];
  tokens?: TokenLedger;
};

// ── Aura Scout (Bucket A-C) ────────────────────────────────────────────

/** Severity levels emitted by each specialist. `block` is rare and
 *  signals the brain should reconsider before Build. */
export type ScoutSeverity = "info" | "warn" | "block";

/** One structured finding from a specialist. Renders as one row in the
 *  ScoutCard's expanded panel; `file_refs` are clickable file paths. */
export type ScoutFinding = {
  specialist: string;
  severity: ScoutSeverity;
  title: string;
  body: string;
  file_refs?: string[];
};

/** Pre-consolidation question raised by a specialist. The brain (in
 *  the Q&A wave dispatcher, future bucket C) groups these into a
 *  `QaWave` for the user. */
export type SpecialistQuestion = {
  id: string;
  text: string;
  options?: string[];
};

export type SpecialistKind = "architecture" | "security" | "ux";
export type SpecialistStatus = "pending" | "running" | "done" | "failed";

/** One specialist's full result. Mirror of `manager::SpecialistRun`. */
export type SpecialistRun = {
  kind: SpecialistKind;
  status: SpecialistStatus;
  summary?: string;
  findings?: ScoutFinding[];
  questions?: SpecialistQuestion[];
  started_at?: number | null;
  completed_at?: number | null;
  exit_code?: number | null;
};

/** A consolidated Q&A wave surfaced to the user mid-Scout. Hard-capped
 *  at wave 2; if the brain still wants more after that we finalize
 *  anyway. */
export type QaWave = {
  wave: number;
  group_title: string;
  questions: SpecialistQuestion[];
  answers?: Record<string, string>;
};

export type ScoutStatus =
  | "spawning"
  | "running"
  | "awaiting_qa"
  | "finalizing"
  | "done"
  | "failed";

/** Live state of an in-flight Scout pass. Rendered as a `ScoutCard`
 *  above the chat thread until promoted into `pending_plan`. */
export type PendingScout = {
  id: string;
  request_id: string;
  status: ScoutStatus;
  specialists: SpecialistRun[];
  qa_wave?: QaWave | null;
  waves_run?: number;
  consolidated_notes?: string;
  created_at: number;
};

export type ManagerStreamDelta =
  | { kind: "text_delta"; block_idx: number; text: string }
  | {
      kind: "tool_use";
      block_idx: number;
      tool_use_id: string;
      name: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      tool_use_id: string;
      is_error: boolean;
      content: string;
    }
  | {
      /** Brain paused mid-loop on `ask_user`. Render an interactive
       *  QuestionCard. The reply hits `managerAnswerQuestion(sid, tool_use_id, answer)`. */
      kind: "question_asked";
      tool_use_id: string;
      question: string;
      options: string[];
      /** Backend uses `shape` on the wire to avoid serde tag collision
       *  with the enum's `kind` discriminator. */
      shape: QuestionShape;
    }
  | { kind: "done" }
  | { kind: "error"; message: string };

/** One node in the shared `aura-loop` dependency graph (`.aura/a2a/`). The
 *  SAME model the CLI's `aura loop run` reads — board cards (incl. Jira
 *  imports) are projected here by `loopSyncBoard`, carrying provenance. */
export type LoopTask = {
  id: string;
  title: string;
  input: string;
  acceptance_criteria?: string | null;
  task_kind: string;
  parent_task_id?: string | null;
  depends_on: string[];
  status: string;
  priority: string;
  agent_kind?: string | null;
  branch?: string | null;
  tags: string[];
  commit_sha?: string | null;
  result?: unknown;
  error_message?: string | null;
  assignee?: string | null;
  /** Provenance back to the board card this node was projected from. */
  board_task_id?: string | null;
  /** "jira" etc. when the originating board card was externally imported. */
  external_source?: string | null;
  external_id?: string | null;
  created_at: number;
  updated_at: number;
};

export type LoopBlockedNode = {
  task: LoopTask;
  /** Dependency ids not yet `completed` (or missing). */
  unmet: string[];
};

export type LoopReadyCounts = {
  ready: number;
  blocked: number;
  working: number;
  done: number;
  /** W-B: nodes parked out of the ready set by a pause. */
  paused: number;
  other: number;
};

/** One goal rolled up across the graph — lifecycle counts so a goal node can
 *  carry its own Run/Pause controls and a "2/5 done · 1 paused" badge. */
export type GoalSummary = {
  goal: string;
  total: number;
  ready: number;
  working: number;
  done: number;
  paused: number;
  blocked: number;
  failed: number;
  /** Task ids in this goal, creation order — the goal's member set. */
  task_ids: string[];
};

/** One crew rolled up across the graph — every node carries a `crew_id`
 *  (default "main"); this tallies a crew's lifecycle counts + the goals in it. */
export type CrewSummary = {
  crew: string;
  total: number;
  ready: number;
  working: number;
  done: number;
  paused: number;
  blocked: number;
  failed: number;
  goals: string[];
};

/** One serialized snapshot of the loop graph, partitioned by lifecycle —
 *  what `/loop` and the LoopPanel render. */
export type ReadyViewDto = {
  ready: LoopTask[];
  blocked: LoopBlockedNode[];
  working: LoopTask[];
  done: LoopTask[];
  /** W-B: paused nodes (held back from the ready set, resumable). */
  paused: LoopTask[];
  other: LoopTask[];
  counts: LoopReadyCounts;
  /** W-B: per-goal rollups so the surface can draw a goal control panel. */
  goals: GoalSummary[];
  /** W-C: per-crew rollups so the surface can draw a crew switcher. */
  crews: CrewSummary[];
};

/** W-C: one crew's durable identity (the registry's record). The default
 *  "main" crew is implicit — present even when never spawned. */
export type CrewMeta = {
  id: string;
  title: string;
  description?: string | null;
  created_at: number;
};

/** W-C: a crew as the switcher shows it — identity joined to live counts. */
export type CrewRow = {
  meta: CrewMeta;
  summary: CrewSummary;
};

/** W-B: one node's result within a run (`loop_runs`). */
export type RunNode = {
  id: string;
  title: string;
  /** "completed" | "merged" | "failed" | "rolled-back" | "skipped". */
  outcome: string;
  commit?: string | null;
  detail?: string | null;
};

/** W-B: one dispatched run of the loop — the unit "run history" lists. */
export type RunRecord = {
  id: string;
  runner: string;
  crew?: string | null;
  goal?: string | null;
  jobs: number;
  started_at: number;
  ended_at?: number | null;
  attempted: number;
  completed: number;
  failed: number;
  nodes: RunNode[];
};

export type LoopSyncResult = {
  created: number;
  updated: number;
  synced: number;
  edges: number;
};

/** Cloud roundtrip (P1): outcome of one `loopCloudSync` — how many cloud-worked
 *  nodes came home (`pulled`) and how many finished local nodes reported up
 *  (`pushed`), plus human-readable `notes` and the `repo` it was scoped to. */
export type CloudSyncResult = {
  repo: string | null;
  pulled: number;
  pushed: number;
  notes: string[];
};

/** Cloud roundtrip (P1): the cloud task minted by `loopCloudSend` — its board
 *  `id` and lifecycle `status` (typically "submitted" until a runner claims it). */
export type CloudSendResult = {
  id: string;
  status: string;
};

/** A one-time runner-registry credential minted by `runnerProvision`, ready to
 *  export on a new box as `AURA_RUNNER_TOKEN`. */
export type RunnerProvision = {
  token: string;
  name: string;
};

export type LoopDispatchedNode = {
  node_id: string;
  lane_id: string;
  title: string;
};

export type LoopRunResult = {
  wave_id: string;
  dispatched: LoopDispatchedNode[];
  ready_remaining: number;
};

/** Result of `loop_plan_goal`: the active brain decomposed a goal into a
 *  connected build — `created` task nodes wired by `edges` "waiting on" links,
 *  all written to the same `.aura/a2a/` graph the runner consumes. */
export type PlanGoalResult = {
  goal: string;
  created: number;
  edges: number;
  node_ids: string[];
};

/** Result of `loop_plan_order`: the active brain worked out the real
 *  dependencies between tasks that previously sat in no order, wired `edges`
 *  "waiting on" links onto those EXISTING nodes (nothing new is minted), and
 *  named the `goal` the `connected` of `considered` tasks add up to. The whole
 *  board is covered by planning it in `groups` chunks (epics / sprints /
 *  batches) concurrently — each chunk its own goal — then rolling those goals up
 *  under `objectives` larger outcomes. `deferred` groups overflowed the per-run
 *  cap and can be planned on another pass (surfaced, never silently dropped). */
export type PlanOrderResult = {
  goal: string;
  considered: number;
  edges: number;
  connected: number;
  groups: number;
  objectives: number;
  deferred: number;
};

/** Why a queued task probably shouldn't run as-is (from `loop_review`).
 *  `already_done` — a finished task shares its name (or a recent commit
 *  delivered it). `duplicate` — another still-pending task is the same work.
 *  `thin` — an empty placeholder with no body. */
export type LoopTaskFlagKind = "already_done" | "duplicate" | "thin";

/** One flagged queue item, with a reason safe to show a non-engineer. */
export type LoopTaskFlag = {
  id: string;
  title: string;
  kind: LoopTaskFlagKind;
  reason: string;
  /** What it collided with — a finished task's title, or the twin's. */
  evidence: string | null;
};

/** An existing goal new work can attach to (from `loop_attach_targets`), with
 *  its tail steps — members nothing else in the goal depends on yet — named so
 *  the picker can offer "run after …". */
export type LoopAttachTarget = {
  goal: string;
  size: number;
  /** Tail steps new work runs after. `board_id` is the card behind the node
   *  (when board-backed), named in the new task's `dependencies` to wire the
   *  edge through the same sync path the rest of the queue uses. */
  tails: { id: string; title: string; board_id: string | null }[];
};

export type ManagerSession = {
  id: string;
  objective: string;
  status: ManagerStatus;
  projects: ProjectRef[];
  tasks: ManagerTask[];
  ribbon: RibbonEntry[];
  /** Conversational thread between user and Manager router.
   *  Optional for legacy sessions that pre-date Track B. */
  chat?: ChatTurn[];
  /** When set, the brain has paused on an `ask_user` call. UI renders
   *  a QuestionCard until the user answers via `managerAnswerQuestion`. */
  pending_question?: PendingQuestion | null;
  /** When set, the CLI brain just invoked `aura propose-plan`. UI
   *  renders a PlanCard until the user clicks Build or Cancel via
   *  `managerDecidePlan`. */
  pending_plan?: PendingPlan | null;
  /** Bucket A — when set, the brain's plan crossed the Scout
   *  threshold and we're running specialist subprocesses. UI renders
   *  a `ScoutCard` until findings consolidate, then `pending_scout`
   *  clears and `pending_plan` populates with the (annotated) draft. */
  pending_scout?: PendingScout | null;
  created_at: number;
  updated_at: number;
};

/** Result of `chatExportToClaudeCode` — a Claude Code session ready to resume
 *  in a terminal. */
export type ClaudeExport = {
  /** Session id to resume: `claude --resume <session_id>`. */
  session_id: string;
  /** Absolute folder the terminal must open in — Claude keys `--resume` by
   *  launch cwd, so this is the worktree the chat is bound to (or where the
   *  real Claude session ran). */
  cwd: string;
  /** Absolute path to the JSONL transcript Claude will resume. */
  jsonl_path: string;
  /** True when we serialized the Aura conversation into a fresh transcript
   *  (mixed/switched-agent chat). False when an existing real Claude session
   *  was surfaced verbatim (the chat already ran on Claude). */
  synthesized: boolean;
  /** False when the `claude` CLI isn't installed — surface guidance instead
   *  of opening a terminal that immediately fails. */
  claude_installed: boolean;
};

/** Result of `chatExportForAgent` — a continuation target for an Aura chat in
 *  any registry agent. Generalizes `ClaudeExport` across every agent. */
export type AgentExport = {
  /** Registry id the export was built for (`claude`, `gemini`, `codex`, …). */
  agent_id: string;
  /** Human label for the agent (`Claude Code`, `Gemini CLI`, …). */
  label: string;
  /** `"resume"` — the terminal genuinely continues the conversation from the
   *  agent's own resumable session (we wrote/located it in the agent's native
   *  format). `"handoff"` — no resumable store, so the agent starts fresh
   *  seeded with `primer` as its opening context. */
  mode: "resume" | "handoff";
  /** True when we serialized the Aura conversation into a fresh native
   *  transcript; false only for a live Claude chat surfaced as-is. */
  synthesized: boolean;
  /** Absolute folder the terminal must open in (worktree-correct). */
  cwd: string;
  /** For `mode === "resume"`: the single value to pass as the PTY
   *  `resumeSessionId` — a session id (claude/codex uuid) or a session-file
   *  path (gemini). `null` for handoff. */
  resume_arg: string | null;
  /** For `mode === "handoff"`: the compact primer to feed the agent as its
   *  opening prompt so it continues with full context. `null` for resume. */
  primer: string | null;
  /** Absolute path to the native transcript we authored, when one was written.
   *  `null` for handoff / a surfaced-as-is live session. */
  transcript_path: string | null;
  /** False when the agent's CLI isn't installed — surface guidance instead of
   *  opening a terminal that immediately fails. */
  installed: boolean;
};

export type ManagerSummary = {
  id: string;
  objective: string;
  status: ManagerStatus;
  created_at: number;
  updated_at: number;
  task_count: number;
  done_count: number;
  /** First project root this session is bound to, if any. `null` for
   *  workspace-agnostic scratch chats. */
  repo_root: string | null;
};

export type ManagerSearchHit = {
  session_id: string;
  objective: string;
  repo_root: string | null;
  role: "title" | "you" | "assistant" | "system";
  snippet: string;
  turn_index: number | null;
  updated_at: number;
};

export type ManagerTaskSpec = {
  description: string;
  agent_id: string | null;
  depends_on?: number[];
  project_root: string;
  zones?: string[];
};

export type ManagerStartArgs = {
  objective: string;
  projects: ProjectRef[];
  tasks: ManagerTaskSpec[];
};

export type FsChanged = {
  /** Absolute path. */
  path: string;
  /** "create" | "modify" | "remove" | "other". */
  kind: string;
};

export type AuraBlock = {
  id: string;
  kind: string;
  timestamp: number;
  summary: string;
};

export type CliResult = {
  stdout: string;
  stderr: string;
  status: number;
};

// ── Semantic CI ──────────────────────────────────────────────────────────
// Mirrors aura-ci's serde model (snake_case on the wire). One PipelineRun per
// declared pipeline that fired for the trigger.
export type CiTrigger = "pre-commit" | "pre-push" | "pr" | "manual";

export type CiStatus = "pass" | "fail" | "skip" | "timeout";

export type CiStepResult = {
  name: string;
  kind: string; // "gate:<id>" | "run"
  status: CiStatus;
  blocking: boolean;
  summary: string;
  detail?: string | null;
  duration_ms: number;
};

export type CiPipelineRun = {
  pipeline: string;
  trigger: CiTrigger;
  steps: CiStepResult[];
  status: CiStatus;
  blocked: boolean;
  headline: string;
  duration_ms: number;
};

// Per-repo no-MCP capture state — backs Settings → Capture. `enabled` is
// true when Aura's git hooks are installed in this workspace; `hooks_dir`
// is where they live (the shared common dir for a linked worktree).
export type CaptureStatus = {
  enabled: boolean;
  is_git: boolean;
  hooks_dir: string | null;
};

export type DaemonStatus = {
  connected: boolean;
  socket_path: string;
  socket_exists: boolean;
  keyfile_exists: boolean;
  protocol_version: number;
  daemon_build: string;
  message: string;
};

export type SessionInfo = { id: string };

export type WaveFile = {
  name: string;
  path: string;
  waves: number;
  status: string;        // "active" | "locked" | "done" | "unknown"
  mtime: number;
};

export type ImpactAlert = {
  id: string;
  severity: string;      // "low" | "medium" | "high" | "critical"
  function: string;
  message: string;
  branch: string;
  file: string;
  timestamp: number;
  resolved: boolean;
};

export type SnapshotEntry = {
  id: string;
  file: string;
  mtime: number;
};

export type SnapshotPage = {
  entries: SnapshotEntry[];
  has_more: boolean;
  oldest_mtime: number;
};

export type OrchAgent = {
  id: string;
  role: string;
  current_task: string;
  status: string;
  progress: number;
};

export type ConflictItem = {
  kind: string;          // "sentinel" | "git" | "impact"
  severity: string;
  label: string;
  detail: string;
};

export type AgentInfo = {
  id: string;
  label: string;
  bin: string | null;
  version: string;
  monogram: string;
  available: boolean;
  continuable: boolean;
};

/** One real ability found in an agent's skill home — a SKILL.md bundle, a
 *  slash-command / prompt, or a Cursor rule. Mirrors the Rust `AgentSkill`. */
export type AgentSkill = {
  agent: string;
  agent_label: string;
  name: string;
  description: string;
  kind: "skill" | "command" | "rule";
  scope: "user" | "project";
  path: string;
};

export type AgentSessionHandle = {
  id: string;
  agent_id: string;
  repo_root: string;
  /** True when an existing live session was attached (vs. spawned). */
  resumed: boolean;
};

/** Mirrors `AppSettings` in `cmd_settings_prefs.rs`. Non-secret UI prefs
 *  persisted to `~/.aura/settings.toml`. Field names are snake_case to
 *  match the Rust/serde wire format (and the hand-editable TOML keys).
 *  The `settingsStore` is the single writer. */
export type AppSettings = {
  appearance: {
    /** dark | light | system */
    theme: string;
    /** default | modal | ember */
    variant: string;
    ade_v2: boolean;
    font_size: number;
  };
  editor: {
    vim: boolean;
    minimap: boolean;
    sticky_scroll: boolean;
    indent_guides: boolean;
  };
  terminal: {
    bell: boolean;
    cursor_blink: boolean;
    scrollback: number;
  };
  flags: {
    intent_inspector: boolean;
    provenance_replay: boolean;
    manager_worktrees: boolean;
    /** Experimental: show a per-response "Saved ~N tokens" chip in the Aura
     *  chat, estimating what Aura's code-graph tools saved over grep/whole-file
     *  reads. Default ON; toggled in Settings → Experimental. */
    show_token_savings: boolean;
    /** Experimental: show a per-message input/output token readout in the Aura
     *  chat (the provider's real counts for that turn). Default OFF; toggled in
     *  Settings → Experimental. */
    show_message_tokens: boolean;
  };
  /** Floating HUD (⌘⇧A) presentation prefs — fully frontend-owned. */
  hud: {
    /** Master on/off. When false the HUD never appears (⌘⇧A / tray / summons
     *  are no-ops). Default true. */
    enabled: boolean;
    /** capsule | sidebar | minimal | ambient */
    mode: string;
    /** Uniform window opacity, 0.2–1.0. */
    opacity: number;
    /** Sidebar panel content width in px (240–480). */
    sidebar_width: number;
    /** Sidebar panel content height in px (320–900). */
    sidebar_height: number;
    /** Whether the desk-pet perches on the HUD pill and mirrors agent status. */
    pet: boolean;
  };
};

/** Mirrors `LiveAgentSession` in `cmd_agent_pty.rs`. One running
 *  coding-agent PTY in a repo, surfaced to the "Start in agent → hand
 *  to a running session" picker. Most-recently-active first. */
export type LiveAgentSession = {
  session_id: string;
  agent_id: string;
  repo_root: string;
  /** ms-since-epoch of the last byte the agent wrote. */
  last_byte_ms: number;
  /** Latest OSC window title the agent set, when known. */
  title: string | null;
};

/** Mirrors `IdleStatus` in `cmd_agent_pty.rs`. Returned by
 *  `agent_pty_idle_status`; the stale-watchdog chip renders when
 *  `alive && idle_ms >= STALE_THRESHOLD_MS`. */
export type AgentPtyIdleStatus = {
  idle_ms: number;
  alive: boolean;
};

/** Mirrors `LivePtySession` in `cmd_agent_pty.rs`. Returned by
 *  `pty_list_alive`; one row per agent PTY the shell could resume
 *  on startup. `kind` is `"daemon"` for sessions the long-lived
 *  aura-pty-daemon owns (survives auto-update relaunch) and
 *  `"in_process"` for sessions tied to this shell process. */
export type LivePtySession = {
  session_id: string;
  agent_id: string;
  repo_root: string;
  kind: "daemon" | "in_process";
  /** Milliseconds since last observed byte. `null` for daemon-owned
   *  sessions this shell process hasn't reattached to yet — the
   *  fresh shell hasn't been subscribed long enough to have a
   *  meaningful counter. */
  idle_ms: number | null;
};

/** One live PLAIN-shell PTY (terminal panel) the shell could reconnect
 *  to. Daemon-hosted plain shells survive an app restart; on boot the
 *  panel matches each persisted tab's `daemonSessionId` against this
 *  list — present ⇒ live reconnect, absent ⇒ cold scrollback replay. */
export type LivePlainPtySession = {
  session_id: string;
  cwd: string | null;
  label: string | null;
  idle_ms: number | null;
};

/** A terminal profile (zsh / bash / custom). Seeded from `$SHELL` +
 *  `/etc/shells` when the user has none configured. */
export type TerminalProfile = {
  id: string;
  name: string;
  path: string;
  args: string[];
  env: [string, string][];
  icon?: string | null;
  use_shell_integration: boolean;
};

/** Resolved launch spec for a terminal profile — the shell binary plus
 *  the workspace-identity env (HOME/GIT_* folded in like agents get). */
export type TerminalLaunch = {
  shell: string;
  args: string[];
  env: [string, string][];
  use_shell_integration: boolean;
};

/** One entry in a terminal's recent-command ring (OSC-133 marks). */
export type RecentCommand = {
  text: string;
  exit_code: number | null;
  ts_ms: number;
};

export type AgentProfile = {
  name: string;
  label?: string | null;
  created_at?: number | null;
};

/** Saved endpoint config for the `openai-compat` agent kind. Backs the
 *  Settings → "Local & Custom Models" tab; one entry per Ollama / HF /
 *  Together / Groq / OpenRouter / vLLM profile the user wires up. The
 *  Rust side persists these as a single JSON file under
 *  `~/.aura/agents/openai-compat.json`. */
export type OpenAiCompatProfile = {
  name: string;
  base_url: string;
  model: string;
  /** Stored in plaintext for this iteration — UI shows a warning. The
   *  next pass moves this to the OS keychain. */
  api_key?: string | null;
  /** Extra headers (e.g. `HF-Inference-Endpoint`, `OpenRouter-Referer`). */
  headers?: Record<string, string>;
  temperature?: number | null;
  description?: string | null;
  created_at?: number | null;
};

export type OpenAiCompatChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenAiCompatTestResult = {
  ok: boolean;
  models_endpoint_ok: boolean;
  completion_ok: boolean;
  message: string;
  latency_ms: number;
};

/** Payload of the `openai-compat:chunk:<profile_name>` Tauri event. */
export type OpenAiCompatChunk = {
  profile: string;
  turn_id: string;
  kind: "delta" | "done" | "error";
  content?: string;
  message?: string;
};

export type GitProfile = {
  id: string;
  label: string;
  user_name: string;
  user_email: string;
  signing_key?: string | null;
};

export type WorkspaceBinding = {
  git_profile_id?: string | null;
  agent_profile_name?: string | null;
  /** "repo" if loaded from <repo>/.aura/profile.json, "global" if from
   *  ~/.aura/workspace-profiles.json. Set by the resolver, never
   *  persisted by callers. */
  source?: string | null;
};

export type BlockKind = "prompt" | "output" | "exit";

export type BlockEnvelope = {
  id: string;
  kind: BlockKind;
  session_id: string;
  agent_id: string;
  started_at: number;
  finished_at: number | null;
  /** Printable text only — ANSI sequences stripped. */
  text: string;
  exit_code: number | null;
};

export type BlockUpdate =
  | { op: "open"; block: BlockEnvelope }
  | { op: "append"; block_id: string; text: string }
  | { op: "close"; block: BlockEnvelope };

export type GitStatusEntry = {
  path: string;
  /** Index (staged) status letter — "" when nothing staged for this path. */
  index: string;
  /** Worktree (unstaged) status letter — "" when worktree is clean. */
  worktree: string;
};

/** One file claimed by an intent. Mirrors `IntentChangesetFile` in
 *  `cmd_aura.rs`. `additions`/`deletions` are optional — only writers
 *  that ran numstat populate them. */
export type IntentChangesetFile = {
  path: string;
  status?: string;
  additions?: number | null;
  deletions?: number | null;
  /** Changed symbols carried directly on the changeset, for moments with no
   *  per-change commit sha to resolve them from (e.g. the bundled sample,
   *  whose history is squashed to one commit). Lets the Time machine render
   *  "Bring this back" without a `change-note` sha. Mirrors `ChangesetSymbol`
   *  in `cmd_aura.rs`; absent on the normal git-backed path. */
  symbols?: ChangedSymbol[];
  /** Commit sha that contributed this file when the changeset was back-filled
   *  from git history. Present → the run is committed, so the diff view fetches
   *  `git show <commit> -- <path>` instead of the (empty) working-tree diff. */
  commit?: string | null;
  /** Baseline sha to diff this file against, for a native Aura chat session
   *  whose work never landed as its own commit. Present → the diff view fetches
   *  `git diff <base> -- <path>` (the file's whole change since the session
   *  began). Mutually exclusive with `commit`. */
  base?: string | null;
};

/** A bound changeset attached to an intent log row. `source` distinguishes
 *  the writer ("manual" | "agent_prompt" | "save_sync_gate" | "split" |
 *  "merge") so the History sidebar can render the right tag. */
export type IntentChangeset = {
  files: IntentChangesetFile[];
  block_id?: string | null;
  source?: string | null;
  captured_at?: number | null;
};

// ── Change notes (deterministic per-file "what / why / where it affects") ──
// Mirrors the engine's `ChangeNoteReport` (aura-cli `change_note.rs`), produced
// by `aura change-note <sha> --json` and bridged through `aura_change_note`.
// Every field is derived from the AST diff + reverse call graph — no AI tokens.

/** A caller of a changed symbol (one inbound call-graph edge). Mirrors
 *  `CallerInfo` in `impact.rs` (serialized camelCase). */
export type ChangeNoteCaller = {
  symbol: string;
  file: string | null;
  kind: string;
  /** "exact" | "import_resolved" | "name_only" — how sure the edge is. */
  confidence: string;
};

/** A user-facing feature that rides on a changed symbol. Mirrors
 *  `FeatureImpact` in `impact.rs` (serialized camelCase). */
export type ChangeNoteFeature = {
  name: string;
  /** Entry kind, e.g. "tauri_command" | "http_route" | "cli_command". */
  kind: string;
  entrySymbol: string;
  file: string;
  /** Min hop distance from the changed symbol to this entry point. */
  hops: number;
  /** Call chain entry→…→changed symbol — the "because". */
  path: string[];
};

/** One changed symbol within a file. */
export type ChangedSymbol = {
  identifier: string;
  kind: string;
  /** "added" | "modified" | "deleted". */
  change: string;
  signature?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  /** Recorded rationale for this symbol, when one was captured. */
  rationale?: string | null;
};

/** A single file's deterministic change note — the per-file "intent". */
export type FileChangeNote = {
  file: string;
  /** Plain-language one-liner Aura composes from the diff shape. */
  note: string;
  symbols: ChangedSymbol[];
  direct_callers: ChangeNoteCaller[];
  dependent_count: number;
  features: ChangeNoteFeature[];
  /** True when nothing in range depends on the changed symbols. */
  leaf: boolean;
  /** True if a graph-walk budget tripped, so counts are a floor. */
  truncated: boolean;
};

/** Blast-radius verdict for a single symbol — mirrors the engine's
 *  `DeleteImpact` (aura-cli `impact.rs`, serialized camelCase), produced by
 *  `aura impact <symbol> <file> --json` and bridged through `aura_symbol_impact`.
 *  The same reverse call-graph the delete-guard uses, framed as a pre-flight:
 *  what breaks if you revert / change this symbol. No AI tokens. */
export type SymbolImpact = {
  /** One plain-language sentence for the pre-flight card. */
  summary: string;
  /** "leaf_safe" | "callers_only" | "feature_loss" | "unknown". */
  severity: string;
  /** True when nothing calls it (and its definition was known). */
  leaf: boolean;
  /** Callers one hop away — the "re-check these first" list. */
  directCallers: ChangeNoteCaller[];
  /** Total distinct callers reached at any depth (a floor). */
  transitiveCallerCount: number;
  /** User-facing features reached, closest first. */
  features: ChangeNoteFeature[];
  /** "high" | "medium" | "low". */
  confidence: string;
  /** Always-present caveat about static-analysis blind spots. */
  hedge: string;
  /** "checkpoint" | "worktree" | "none" — provenance of the graph. */
  graphSource: string;
  /** Seconds since the source checkpoint (checkpoint source only). */
  graphStalenessSecs?: number;
  /** True if a graph-walk budget tripped, so counts are a floor. */
  truncated: boolean;
};

/** Plain-language "what changed" for one working-tree file (see
 *  `summarizeFileChange`). `source` records provenance: `model` (a real
 *  backend), `fallback` (deterministic — no model reachable), `cache` (reused
 *  for this exact diff), or `none` (no diff to describe). */
export type ChangeSummary = {
  summary: string;
  source: "model" | "fallback" | "cache" | "none";
  diff_hash: string;
};

/** Plain-language before/what/why for one file's change (see `explainChange`).
 *  `before` is what it used to do (empty for a pure addition), `what` is what
 *  the change does now, `why` is why it was made and how it now works.
 *  `source` is the rolled-up provenance across the three angles. */
export type ChangeExplanation = {
  before: string;
  what: string;
  why: string;
  source: "model" | "fallback" | "cache" | "mixed" | "none";
  diff_hash: string;
};

/** Per-piece plain-language meaning for one changed symbol (see
 *  `explainSymbols`), one plain sentence per side and always model-written —
 *  never a mined variable name. `now` = what this piece does now (the "New is
 *  this" side; empty for a pure removal). `before` = what it used to do (the
 *  "Previous was this" side; empty for a pure addition). Either is empty until
 *  the model has written it, and the caller keeps its plain placeholder until
 *  then. `source` is `cache` (at least one side already stored) or `none`. */
export type SymbolExplanation = {
  identifier: string;
  now: string;
  before: string;
  source: "cache" | "none";
};

/** The full change-note for a commit: header facts + a card per changed file. */
export type ChangeNoteReport = {
  commit_sha: string;
  commit_short: string;
  commit_message: string;
  commit_time: number;
  author: string;
  files: FileChangeNote[];
  /** Changed files with no tracked symbol delta (configs, docs, or code
   *  changed below symbol granularity — a const, an import). */
  other_files: string[];
  /** "checkpoint" | "worktree" | "none" — provenance of the blast-radius graph. */
  graph_source: string;
};

// ── /doctor — repo-health report ───────────────────────────────────────────
// Mirrors the engine's `DoctorReport` (aura-cli `doctor.rs`), produced by
// `aura doctor --json` and bridged through `aura_doctor_json`. Read-only: JSON
// mode reports the same checks as the interactive doctor but performs NO
// repairs. This is the REPO-HEALTH doctor, not the team-chat connectivity one.

/** A session left "active" with no recent interaction. */
export type StuckSession = {
  session_id: string;
  agent_id: string;
  /** Number of files this session touched. */
  files_touched: number;
  /** Why doctor flags it, e.g. "Active but no interaction for 30 minutes". */
  reason: string;
};

/** Snapshot-store health. `oversized` mirrors the >400 prune threshold. */
export type SnapshotHealth = {
  total: number;
  /** Snapshots whose backing file no longer exists. */
  orphaned: number;
  approx_kb: number;
  oversized: boolean;
};

/** Shadow checkpoint branch (refs/heads/aura/checkpoints) health. */
export type ShadowHealth = {
  exists: boolean;
  checkpoints: number;
};

/** A routing taxonomy cell still below the auto-routing sample threshold. */
export type ImmatureCell = {
  cell: string;
  samples: number;
};

/** Skill-ledger health, or `present: false` when no ledger exists yet. */
export type SkillLedgerHealth = {
  present: boolean;
  readable: boolean;
  recorded: number;
  /** Rows recorded locally but not yet flushed to the cloud. */
  dirty: number;
  total_cells: number;
  min_samples: number;
  immature_cells: ImmatureCell[];
};

/** A leaked replay-lab worktree from an interrupted `aura replay` run. */
export type ReplayOrphan = {
  branch: string;
  path: string;
};

/** The full read-only doctor report. `signing` and `cloud_rotation` are the
 *  engine's raw probe JSON (status + details) passed through verbatim. */
// --- the staged intent gate ------------------------------------------------
// Mirrors `aura verify-intent --staged --json`. The engine owns these shapes;
// the app renders them and adds no judgement of its own.

/** One symbol the gate objected to. Only `protected_export_removed` blocks a
 *  commit — everything else is named so a person can read it and move on. */
export type IntentViolation = {
  finding: string;
  severity: string;
  symbol: string;
  file: string;
  kind: string;
  exported: boolean;
  reason: string;
};

/** A caller of a removed symbol. `certain` is false when the edge was matched
 *  on name alone, which is worth saying out loud rather than rounding up. */
export type IntentDependent = {
  symbol: string;
  file: string;
  depth: number;
  certain: boolean;
};

export type IntentVerdict = {
  goal: string;
  agent: string;
  session: string;
  worktree: string;
  baseline: string;
  requested_changed: string[];
  unexpected_changed: string[];
  protected_removed: string[];
  violations: IntentViolation[];
  passed: boolean;
  dependents: Record<
    string,
    { defined_in: string; dependents: IntentDependent[] }
  >;
};

/** What the agent was authorised to change, recorded before it ran. */
export type IntentContract = {
  goal: string;
  allowed_symbols: string[];
  protected_symbols: string[];
  allowed_paths: string[];
  approved_removals: string[];
  baseline: string;
  agent: string;
  session: string;
  worktree: string;
  approved_at: string;
};

/** The restore, plus the verdict it produced — one answer, one document. */
export type RestoreResult = {
  restored: string;
  file: string;
  line: number;
  anchoredAfter: string | null;
  importsRestored: string[];
  verdict: IntentVerdict;
};

export type DoctorReport = {
  stuck_sessions: StuckSession[];
  snapshots: SnapshotHealth;
  hooks_installed: boolean;
  shadow: ShadowHealth;
  plugins_loaded: number;
  /** Raw signing-key probe: { status, key_id?, key_path?, error? }. */
  signing: Record<string, unknown>;
  /** Raw cloud rotation-chain drift: { status, local_count?, cloud_count?, … }. */
  cloud_rotation: Record<string, unknown>;
  skill_ledger: SkillLedgerHealth;
  replay_orphans: ReplayOrphan[];
  /** Count of real problems found (informational states excluded). */
  issues_found: number;
};

// ── /taste — learned project taste rules ───────────────────────────────────
// Mirrors the engine's `Rule` (aura-cli `taste/aggregate.rs`), produced by
// `aura taste list --json` and bridged through `aura_taste_rules`.

/** "candidate" | "provisional" | "active" | "deprecated" — promotion stage. */
export type TasteRuleStatus =
  | "candidate"
  | "provisional"
  | "active"
  | "deprecated";

/** One mined coding-pattern rule (e.g. "Indent rust files with 4 spaces"). */
export type TasteRule = {
  id: string;
  /** Rule family, e.g. "indentation.spaces" | "imports.named". */
  template: string;
  language: string;
  /** Architectural layer the rule was observed in, e.g. "backend". */
  layer: string;
  /** Plain-language summary — the human-readable rule text. */
  statement: string;
  /** Template-specific aggregate payload (winning value + counts). */
  summary: Record<string, unknown>;
  /** Up to 3 recent commit shas backing this rule. */
  examples: string[];
  /** Accept weight — how many observations support the rule. */
  positive_weight: number;
  /** Counter-evidence weight. */
  negative_weight: number;
  confidence: number;
  status: TasteRuleStatus;
  first_seen: number;
  last_seen: number;
  /** True only after a human approved via `aura taste approve <id>`. */
  user_approved: boolean;
};

// ── /review — semantic PR review ───────────────────────────────────────────
// Mirrors the engine's `ReviewReport` (aura-cli `pr.rs`) + the humanized
// finding/change types (`pr_humanize.rs`), produced by
// `aura pr-review --base <base> --json` and bridged through `aura_review_json`.
// When the tree has no changes the engine returns `{ status: "no_changes" }`
// instead of this shape, so callers should check for `status` first.

/** A plain-language review finding folded from the raw violation streams. */
export type ReviewFinding = {
  /** Short title of the issue. */
  title: string;
  /** "critical" | "warning" | "advisory" | other — drives the badge. */
  severity: string;
  /** Why it matters / what to do, in plain language. */
  detail: string;
  /** How many occurrences this card rolls up. */
  count: number;
  file?: string | null;
  line?: number | null;
};

/** Per-file "what changed and why" — the captured intent paired with a change. */
export type ReviewChangeIntent = {
  file: string;
  /** The captured rationale behind the change, when one was recorded. */
  intent?: string | null;
  /** Who/what authored the change (agent or human), when known. */
  who?: string | null;
  /** Changed symbols within the file (shape may evolve; engine-owned). */
  symbols?: unknown[];
};

/** The full semantic review report. The humanized `summary` / `findings` /
 *  `changes` are what the card leads with; the raw arrays back them up. */
export type ReviewReport = {
  /** Present (= "no_changes") only when there was nothing to review. */
  status?: string;
  base_branch: string;
  total_changes: number;
  /** kind → count of changed-but-unverified logic nodes. */
  unverified_nodes: Record<string, number>;
  invariant_violations: string[];
  blast_radius: string[];
  cross_branch_conflicts: string[];
  /** One-line coding-pattern (taste) advisories. */
  taste_findings: string[];
  risk_score: number;
  /** "LOW" | "MODERATE" | "CRITICAL". */
  risk_label: string;
  /** Plain-language one-paragraph overview, written for a non-author reader. */
  summary: string;
  findings: ReviewFinding[];
  changes: ReviewChangeIntent[];
  /** Omni-graph blast data injected by the engine (shape engine-owned). */
  omni_graph_impact?: unknown;
};

/** Knowledge graph (graphify port). Cached to `.aura/kg/graph.json`. */
export type KgNode = {
  id: string;
  /** "file" | "fn" | "class" | "type" | "doc" | "section" */
  kind: string;
  name: string;
  file: string;
  line: number;
  degree: number;
  community_id: number;
  god: boolean;
};

export type KgEdge = {
  from: string;
  to: string;
  /** "contains" | "calls" | "references" | "imports" | "mentions" */
  kind: string;
  surprise: boolean;
};

export type KgStats = {
  files: number;
  symbols: number;
  docs: number;
  edges: number;
  communities: number;
  gods: number;
  surprises: number;
};

export type KgGraph = {
  nodes: KgNode[];
  edges: KgEdge[];
  built_at: number;
  head_sha: string;
  stats: KgStats;
};

/** Stable identifier for a logical change. Survives commit-sha
 *  rotation (amend, sign, re-sign). 10-char base32 string. */
export type ChangeIdRow = {
  commit_sha: string;
  change_id: string;
};

/** Durable AST-level conflict object stored at `.aura/conflicts.jsonl`.
 *  Distinct from `ConflictItem` (aura_list_conflicts) which is a
 *  transient scan of sentinel + git markers. These survive ribbon
 *  dismissal and only clear when explicitly resolved. */
export type ConflictedNode = {
  id: string;
  file: string;
  identifier: string;
  base_hash: string;
  ours: string;
  theirs: string;
  ours_agent: string;
  theirs_agent: string;
  opened_at: number;
  resolved_at: number | null;
  resolved_in_commit: string | null;
  resolution_body: string | null;
};

export type RecordConflictArgs = {
  file: string;
  identifier: string;
  base_hash: string;
  ours: string;
  theirs: string;
  ours_agent: string;
  theirs_agent: string;
};

export type ResolveConflictArgs = {
  conflict_id: string;
  /** "ours" | "theirs" | "custom" */
  strategy: "ours" | "theirs" | "custom";
  custom_body?: string | null;
  resolved_in_commit?: string | null;
};

/** One row from `.aura/op_log.jsonl`. `undo_payload` is opaque JSON
 *  whose shape depends on `kind`; the backend decides how to invert
 *  it. `undone_at` is set the moment the inverse runs. */
export type OpEntry = {
  op_id: string;
  ts: number;
  kind: string;
  summary: string;
  agent_id: string;
  undo_payload: unknown;
  undone_at: number | null;
};

/** Marker `agent_id` (and `source`) for autonomous agent-event captures the
 *  safety control plane appends to the intent log — one row per agent tool
 *  call (doc 23). Telemetry, not real intents/sessions, so `auraIntentRecent`
 *  filters these out at the data boundary before any Trace surface sees them. */
export const AUTO_CAPTURE_AGENT_ID = "hook_auto";

/** Strip Aura's own bookkeeping (`.aura/…`, `.entire/…`) out of a row's
 *  changeset so no Trace surface counts it as project work. Returns the row
 *  unchanged when it has no changeset or nothing to drop, so it stays a cheap
 *  identity pass on the common case (no needless object churn / re-render
 *  identity changes). Used once at the `auraIntentRecent` data boundary. */
function stripToolMetadataFromRow(r: IntentRow): IntentRow {
  const files = r.changeset?.files;
  if (!files || files.length === 0) return r;
  const kept = files.filter((f) => !isToolMetadataPath(f.path));
  if (kept.length === files.length) return r; // nothing was bookkeeping
  return { ...r, changeset: { ...r.changeset!, files: kept } };
}

/** One row from `.aura/intent_log.jsonl` returned by `auraIntentRecent`. */
export type IntentRow = {
  timestamp: number;
  agent_id: string;
  intent: string;
  intent_type?: string | null;
  signed_block_id?: string | null;
  key_id?: string | null;
  changeset?: IntentChangeset | null;
  /** Claude Code session id (jsonl stem) stamped at log-intent time, when the
   *  writer could resolve the active session. The Session detail uses it for a
   *  durable transcript link (exact match), falling back to the time heuristic
   *  when absent (rows written before stamping shipped). */
  claude_session_id?: string | null;
  /** Present on autonomous agent-event captures (doc 23): the raw tool name
   *  (Bash/Read/Write/…) and capture source ("hook_auto"). Carried in the
   *  on-disk JSONL but currently dropped by the Rust `IntentRow` struct, so
   *  these are usually undefined frontend-side — `agent_id` is the reliable
   *  signal. Typed so the capture shape is documented and the source filter
   *  in `auraIntentRecent` stays well-typed. */
  source?: string | null;
  tool?: string | null;
  /** Set only on synthetic rows the Sessions list mints from a native Aura
   *  chat (manager) session — there is no intent-log entry for these, so the
   *  Sessions pane projects a `ManagerSummary` into an `IntentRow` and stamps
   *  this id. The session detail branches on it: instead of reading a Claude
   *  JSONL `file_path`, the Transcript tab replays the chat via
   *  `managerLoadTranscript`. Absent on every genuine intent-log row. */
  manager_session_id?: string | null;
  /** The human teammate this activity is attributed to, resolved backend-side
   *  by joining the row's signing `key_id` to the team key registry
   *  (`.aura/team/keys.jsonl`) and the roster (`team/team.json`). `agent_id`
   *  is *which AI* did the work; this is *which person* it was done for. Absent
   *  when the row carries no key or no registered key matches it. */
  developer?: string | null;
  /** The teammate's git/commit email, when resolvable. */
  developer_email?: string | null;
  /** The teammate's short handle (email local-part). */
  developer_handle?: string | null;
};

/** Save & Sync gate uses this to decide whether to fire or pop the dialog
 *  pre-filled with the orphan paths. */
export type IntentCoverage = {
  covered: string[];
  orphans: string[];
  latest_intent_ts?: number | null;
  last_commit_ts?: number | null;
};

export type DiffStats = {
  changed_files: number;
  added: number;
  removed: number;
};

export type FileDiffStat = {
  path: string;
  additions: number;
  deletions: number;
};

/** Upstream-tracking state for the current branch. `has_upstream=false`
 *  means the branch hasn't been published — the CommitInput swaps to a
 *  "Publish branch" action in that case. */
export type AheadBehind = {
  ahead: number;
  behind: number;
  has_upstream: boolean;
  branch: string | null;
};

/** A project created on disk by git_clone / git_init — the root to open. */
export type NewRepo = {
  root: string;
  name: string;
};

/** The seeded sample project — its root to open, plus the live sample chat to
 *  focus so the Build surface opens on a real conversation. */
export type SeededSample = {
  root: string;
  name: string;
  ambientSessionId: string;
};

export type DaemonBlock = {
  id: string;
  kind: string;
  state: string;
  summary: string;
};

export type IntentEntry = {
  id: string;
  timestamp: number;
  agent: string;
  intent: string;
  branch: string;
  commit: string;
  status: string;
  /** Bound changeset (option 1/2/4/5 wiring). Older intent log rows
   *  written before changeset binding shipped will have this field
   *  absent — every consumer must treat it as optional. */
  changeset?: IntentChangeset | null;
};

export type IntentLogPage = {
  entries: IntentEntry[];
  has_more: boolean;
  oldest_ts: number;
};

export type AuditEntry = {
  timestamp: number;
  kind: string;
  severity: string;
  summary: string;
  agent?: string;
  branch?: string;
  commit?: string;
  acknowledged?: boolean;
  [extra: string]: unknown;
};

export type AuditLogPage = {
  entries: AuditEntry[];
  has_more: boolean;
  oldest_ts: number;
};

export type UsageSummary = {
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  calls: number;
  model: string;
};

// Typed slice of `aura usage --json` (see aura-cli/src/usage.rs::report_to_json).
// Frontend consumers read `auraUsageReport()` which maps the raw shape into
// camelCase + drops fields the UI doesn't surface (sessions list, by_day, ...).
export type UsageModel = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessions: number;
};

// One per-developer usage bucket from `.aura/usage_by_dev.jsonl` — the
// git-shared aggregate the CLI refreshes on every `aura usage` run. A row is
// (month, developer, agent) so the UI can roll up either axis.
export type UsageDeveloper = {
  month: string;
  developer: string;
  handle: string;
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessions: number;
};

export type UsageReport = {
  period: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  sessionCount: number;
  byModel: UsageModel[];
  byDeveloper: UsageDeveloper[];
};

type RawUsageReport = {
  period: string;
  total: {
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    sessions: number;
  };
  by_model: Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    sessions: number;
  }>;
  by_developer?: Array<{
    month: string;
    developer: string;
    handle?: string;
    agent_id: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    sessions: number;
  }>;
};

export type CommitEntry = {
  sha: string;
  author: string;
  timestamp: number;
  subject: string;
  branch: string;
};

/** A ref decoration on a commit (branch tip, tag, or HEAD). `kind`
 *  drives badge colour in the commit-graph rail. */
export type GraphRef = {
  name: string;
  kind: "head" | "local" | "remote" | "tag";
};

/** One node in the Source Control commit graph. Carries the full topology
 *  (full sha + parent shas) the lane layout needs, plus display fields. */
export type GraphCommit = {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  author_email: string;
  timestamp: number;
  subject: string;
  refs: GraphRef[];
};

/** One file's change in a single commit, for the History detail's "Files
 *  changed" list (from `git_commit_file_stats`). `status` is the single-letter
 *  change (A/M/D/R); `added`/`deleted` are line counts (`-1` = binary). */
export type GitCommitFileStat = {
  path: string;
  status: string;
  added: number;
  deleted: number;
};

export type GitContributor = {
  name: string;
  email: string;
  commits: number;
  last_active: number;
  handle: string;
};

export type CloudStartResp = {
  user_code: string;
  device_code: string;
  verify_url: string;
  expires_in: number;
  poll_interval: number;
  cloud_url: string;
};

export type CloudPollStatus = "pending" | "approved" | "expired" | "invalid" | "used";

export type CloudPollResp = {
  status: CloudPollStatus;
  user?: string | null;
  org_slug?: string | null;
};

export type CloudAuthStatus = {
  connected: boolean;
  user?: string | null;
  org_slug?: string | null;
  cloud_url: string;
};

// Scan-to-pair payload for the Aura mobile companion. `qr_payload` is the
// compact JSON the phone decodes; `user_code` is shown under the QR as a
// human-readable fallback.
export type CloudPairResp = {
  qr_payload: string;
  user_code: string;
  cloud_url: string;
  expires_in: number;
};

// Provenance of a team member relative to this repo's remotes.
//   "direct"   — authored at least one commit reachable from origin.
//   "ancestor" — only seen via the `upstream` remote (this repo is a
//                fork and the person committed to the parent project,
//                not to this fork). Surface as a subtle "upstream" tag
//                in the roster — they're inherited, not invited.
//   "both"     — appears in both walks.
// Defaults to "direct" for back-compat with manifests written before
// this field existed.
export type TeamMemberSource = "direct" | "ancestor" | "both" | "collaborator";

export type TeamMember = {
  email: string;
  name: string;
  handle: string;
  commits: number;
  first_seen: number;
  last_seen: number;
  claimed: boolean;
  admin: boolean;
  activity_text?: string | null;
  status_emoji?: string | null;
  // Channel slug this member is currently in voice on. Drives the
  // per-channel 🎧 N chip + the inline voice roster. `null` / undefined
  // means "not in voice anywhere".
  voice_channel?: string | null;
  // Fork-inheritance marker — see TeamMemberSource above. `collaborator`
  // means this person has no commits and is surfaced purely because they
  // hold edit rights on the GitHub repo (populated by teamSyncCollaborators).
  source?: TeamMemberSource;
  /** Additional git emails that resolve to this member. Lets one person
   *  be enrolled as `mck@naridon.com` while their local git uses
   *  `mubasheer.ck@hotmail.com`. Populated via `teamAliasAdd` (admin or
   *  self-owner). Empty / undefined when no aliases are configured. */
  also_emails?: string[];
  /** GitHub login this member maps to, when known. Set by
   *  `teamSyncCollaborators` — either matched to a committer or taken from
   *  the collaborator entry for a zero-commit member. */
  github_login?: string | null;
  /** Repo permission on GitHub — "admin" | "maintain" | "push" — for
   *  members surfaced via the collaborators API. Drives the "has access"
   *  badge for people with edit rights who haven't committed yet. Absent
   *  for ordinary commit-derived members. */
  repo_role?: string | null;
};

export type TeamStatus = {
  activity_text?: string | null;
  status_emoji?: string | null;
};

/** One proposed "these rows look like the same person" group for the roster's
 *  review banner. Advisory — nothing merges until a human confirms. Returned by
 *  `teamIdentitySuggestDuplicates`. Arrays are parallel and survivor-first. */
export type DuplicateSuggestion = {
  /** Canonical emails of the rows in this group (2+), survivor first. */
  emails: string[];
  /** Display handles, parallel to `emails`. */
  handles: string[];
  /** Display names, parallel to `emails`. */
  names: string[];
  /** Recommended survivor email (same ranking as the auto-merge). */
  survivor_email: string;
  /** "high" (a name that equals a login / an email stem that prefixes one) or
   *  "medium" (softer shared-name overlap). */
  confidence: "high" | "medium" | string;
  /** Plain-language why-these-look-the-same. */
  reason: string;
};

/** Structured per-channel metadata, additive over the flat `channels`
 *  slug list. A slug present in `channels` with no `channel_meta` entry
 *  is an open channel everyone sees. */
export type ChannelMeta = {
  slug: string;
  /** "open" (default) or "private". */
  visibility: "open" | "private" | string;
  /** Member emails for a private channel; ignored when open. */
  members?: string[];
  /** Channel-level admin emails (can manage membership/topic). */
  admins?: string[];
  topic?: string | null;
  /** Team-shared custom URL tabs pinned to the channel header. Absent for
   *  channels that never pinned one. */
  tabs?: ChannelTabDef[];
  created_at?: number;
  created_by?: string | null;
};

/** One custom channel tab — a labelled URL rendered as an extra header tab. */
export type ChannelTabDef = {
  id: string;
  label: string;
  url: string;
  added_by?: string | null;
  created_at?: number;
};

export type TeamManifest = {
  team_id: string;
  repo_root: string;
  created_at: number;
  members: TeamMember[];
  channels: string[];
  /** Optional structured channel metadata; absent for teams that have
   *  never created a private channel or set a topic. */
  channel_meta?: ChannelMeta[];
};

export type TeamIdentity = {
  email: string;
  handle: string;
  name: string;
  in_team: boolean;
  claimed: boolean;
  admin: boolean;
  /** Resolved handle/name after applying per-repo override + roster
   *  alias canonicalisation. Equal to `handle`/`name` for the common
   *  case; diverges when the user is sending under an aliased identity. */
  effective_handle?: string;
  effective_name?: string;
  /** The machine's signed-in GitHub account (`gh api user`), when
   *  resolvable. When set, the chat self-identity anchors on THIS — not
   *  the shared git email — so two accounts that share a local
   *  `git config user.email` don't each claim the other's messages. */
  account_login?: string | null;
};

export type IdentityOverride = {
  handle: string;
  name: string;
  email: string;
  set_at: number;
};

export type ChatMessage = {
  id: string;
  channel: string;
  ts: number;
  from_handle: string;
  from_name: string;
  body: string;
  mentions: string[];
  thread_parent?: string;
  is_agent: boolean;
  delivery_status?: "pending" | "delivered" | "failed";
  seq?: number;
  /** The sending install's device id (per-machine UUID), carried from the
   *  cloud/WS row. Lets self-attribution tell a colleague who shares our git
   *  `user.email` local-part apart from us — identity on the wire is derived,
   *  not verified, so the device id is the tiebreaker. Absent on purely local
   *  echoes (self by construction) and on legacy rows. */
  from_device_id?: string | null;
};

export type OutboxEntry = {
  msg_id: string;
  channel: string;
  attempts: number;
  last_error?: string;
  next_attempt_ts: number;
  failed: boolean;
};

export type ChatAttachment = {
  url: string;
  sha256: string;
  size: number;
  mime: string;
  filename?: string;
};

export type SoundboardClip = {
  /** Stable id — "<unix-millis>-<safe-name>". Used as the filename
   *  stem on disk and as React key in the popover. */
  id: string;
  /** User-facing name (sanitized + space-converted). */
  name: string;
  /** File extension without leading dot: "mp3", "wav", "ogg", "m4a". */
  ext: string;
  /** Upload millis (unix) — duplicate of the id prefix for convenience. */
  uploaded_at_ms: number;
  /** Bytes on disk — clips >2 MB are rejected at upload. */
  size_bytes: number;
};

export type ChatSendArgs = {
  repoRoot: string;
  channel: string;
  body: string;
  fromHandle?: string;
  fromName?: string;
  threadParent?: string;
  isAgent?: boolean;
};

export type ChatDoctorReport = {
  room_id: string;
  room_id_source: string;
  origin_url_raw: string | null;
  origin_url_normalised: string | null;
  git_email: string;
  git_name: string;
  handle: string;
  device_id: string;
  cloud_origin: string;
  cloud_url_raw: string | null;
  cloud_token_present: boolean;
  ws_url: string;
  http_ws_host_match: boolean;
  cloud_reachable: boolean;
  cloud_status: number | null;
  cloud_error: string | null;
  channels: string[];
  local_message_count: number;
  cloud_message_count_general: number | null;
  outbox_pending: number;
  outbox_failed: number;
  outbox_last_error: string | null;
  roster_email_match?: boolean;
  canonical_handle?: string | null;
  canonical_email?: string | null;
  alias_emails?: string[];
  identity_override_active?: boolean;
};

export type BlameLine = {
  line: number;
  sha: string;
  author: string;
  ts: number;
  summary: string;
};

export type OutlineNode = {
  kind: string;          // "fn" | "class" | "type" | "const" | "section"
  name: string;
  line: number;
};

// A recorded shift in a symbol's plain-language meaning between two Code
// Atlas generations — the provenance of "AI changed what this does". Surfaced
// in the editor hover as "Meaning changed: was X, now Y".
export type AtlasMeaningChange = {
  /** The prior plain-language meaning. */
  was: string;
  /** The current plain-language meaning. */
  now: string;
  /** Unix seconds of the atlas generation that introduced the new meaning. */
  at: number;
};

// One symbol from the Code Atlas, shaped for the editor hover. The atlas
// (`aura atlas` → `.aura/atlas.json`) is a plain-English directory of every
// symbol: what it MEANS in the real world, for people who can't read code.
export type AtlasHoverEntry = {
  /** Stable rename-proof identity (the AST node id). */
  key: string;
  /** Raw source identifier, verbatim (`verify_token`). */
  name: string;
  /** Humanized title ("Verify Token"). */
  title: string;
  /** "feature" | "component" | "atom". */
  role: string;
  /** Human architectural layer ("UI (React)", "Core (Rust)", …). */
  layer: string;
  /** Plain-language one-liner — the real-world meaning. */
  summary: string;
  file?: string;
  line?: number;
  /** For features: humanized feature name ("Sign In"). */
  feature?: string;
  /** "structural" or "ai" — provenance of this meaning. */
  summarySource: string;
  /** Set only when this symbol's meaning changed since the last atlas regen. */
  meaningChange?: AtlasMeaningChange;
};

// The hover-ready atlas for one repo. `available` is false when no atlas has
// been generated yet (`.aura/atlas.json` missing) — the editor then stays a
// plain editor with no extra hover.
export type AtlasHover = {
  available: boolean;
  generatedAt?: number;
  repo?: string;
  entries: AtlasHoverEntry[];
  /** How many entries carry a `meaningChange` this regen. */
  changedCount: number;
};

// One sentinel inbox message. Mirrors the JSON the CLI's SentinelManager
// writes under .aura/sentinel/messages/. `id` may be backfilled from the
// filename for older messages whose body forgot to carry it.
// ── cross-worktree control plane ──────────────────────────────────────
//
// Mirrors `aura-cli/src/worktree/overview.rs`. One repository, many
// checkouts: the shared plane (claims, zones, messages, awareness) lives
// once at the repository root, while each checkout keeps its own sessions
// and transcripts. That is what makes "who else is on this symbol?"
// answerable at all.

/** One agent standing in a checkout, and what it is holding. */
export type PlaneAgent = {
  session_id: string;
  agent_id: string;
  pid: number;
  /** Its process is still running. A dead session with live claims is how
   *  a symbol ends up looking held by nobody. */
  alive: boolean;
  /** Unix seconds. */
  last_heartbeat: number;
  /** Checkout name; `null` in the main checkout. */
  worktree: string | null;
  branch: string | null;
  claims: { file_path: string; function_name: string; node_id: string; claimed_at: number }[];
  zones: { pattern: string; owner: string; mode: string }[];
};

/** A signed "someone is doing something here" event from the awareness feed. */
export type PlaneEvent = {
  id: string;
  actor: string;
  is_agent: boolean;
  kind: string;
  repo: string;
  branch: string | null;
  file: string | null;
  /** Unix MILLIseconds (the awareness feed's own unit). */
  ts: number;
  worktree?: string | null;
};

/** One checkout of the repository. */
export type WorktreeCard = {
  /** `null` for the main checkout. */
  name: string | null;
  path: string;
  head: string;
  branch: string | null;
  is_main: boolean;
  /** git still lists it, but the directory is gone from disk. */
  missing: boolean;
  locked: boolean;
  dirty_files: number;
  ahead: number;
  behind: number;
  /** Unix SECONDS of this checkout's HEAD commit; null when it has none. */
  last_commit_at: number | null;
  /** Stable address for messaging — `main`, or the checkout name. */
  token: string;
  agents: PlaneAgent[];
  events: PlaneEvent[];
  /** Unread messages addressed to this checkout. */
  inbox: number;
  /** The checkout the app itself is open on. */
  is_here: boolean;
};

/** One symbol two or more sessions are holding at once. */
export type PlaneContention = {
  file: string;
  function: string;
  holders: { worktree: string; agent: string; session: string; alive: boolean }[];
  /** The dangerous kind: the holders are in DIFFERENT checkouts, so neither
   *  one's git status can reveal the other. */
  cross_worktree: boolean;
};

export type WorktreePlane = {
  root: string;
  /** Branch every checkout's ahead/behind is measured against. */
  trunk: string;
  /** Token of the checkout the app is open on. */
  here: string;
  worktrees: WorktreeCard[];
  contention: PlaneContention[];
  /** Sessions holding claims whose checkout no longer exists. */
  stranded: PlaneAgent[];
  messages: SentinelMessage[];
  /** Present only when the folder isn't a git repository. */
  error?: string;
};

export type WorktreeSayResult = {
  sent: unknown;
  from_worktree: string;
  /** How many sessions can actually receive it — 0 means stored, unheard. */
  recipients: number;
  note: string;
};

// ── publishing a plain folder ─────────────────────────────────────────

export type RepoState = {
  is_repo: boolean;
  has_commits: boolean;
  has_origin: boolean;
  origin_url: string | null;
  branch: string;
  /** Folder basename, already legal as a repository name. */
  suggested_name: string;
};

export type HostOwner = {
  login: string;
  /** `user` | `org` (GitHub) | `group` (GitLab). */
  kind: string;
};

export type HostProvider = {
  /** `github` | `gitlab`. */
  id: string;
  label: string;
  installed: boolean;
  signed_in: boolean;
  account: string | null;
  owners: HostOwner[];
  /** Why it can't be used, written as the thing to do about it. */
  hint: string | null;
};

export type PublishResult = {
  initialized: boolean;
  committed: boolean;
  remote_url: string;
  pushed: boolean;
  branch: string;
};

export type SentinelMessage = {
  id: string;
  from_session: string;
  from_agent: string;
  to_session: string;
  content: string;
  /** Unix seconds. */
  timestamp: number;
  read_by: string[];
};

// One file-claim made by an agent. Carried inside SentinelAgent.
export type SentinelClaim = {
  file_path: string;
  function_name: string;
  node_id: string;
  /** Unix seconds. */
  claimed_at: number;
};

// One agent's presence record (.aura/sentinel/claims/<session>.json).
export type SentinelAgent = {
  session_id: string;
  agent_id: string;
  pid: number;
  /** Unix seconds — used to gray-out stale entries. */
  last_heartbeat: number;
  claims: SentinelClaim[];
};

// One prior turn from a resumed agent session. Rendered above the PTY
// when the user reopens a tab so the conversation history is visible
// (the CLIs load it into context but don't redraw on --resume).
export type PrerollTurn = {
  role: "user" | "assistant" | "system";
  text: string;
  /** Epoch millis. 0 if the source line didn't carry a timestamp. */
  ts: number;
};

// One row from the Claude Code session-list — backs the ResumeDialog.
/** Latest Claude subscription usage reading the CLI statusline recorded, read
 *  from `~/.aura/usage/statusline.jsonl`. `null` from the command means no
 *  usable line (Claude not running / never has). `five_h_pct` / `seven_d_pct`
 *  are null off-subscription (raw API key has no rolling window). */
export type ClaudeUsageSnapshot = {
  /** Percent of the rolling 5-hour limit used (0–100), or null. */
  five_h_pct: number | null;
  /** Percent of the weekly (7-day) limit used (0–100), or null. */
  seven_d_pct: number | null;
  /** Percent of the model context window used on the last turn (0–100). */
  ctx_pct: number | null;
  /** Running session cost in USD as Claude Code reports it. */
  cost_usd: number | null;
  /** Model label from the reading. */
  model: string | null;
  /** Unix epoch (secs) of the reading. */
  ts: number;
  /** Seconds since the reading was written. */
  age_secs: number;
  /** True while the reading is recent enough that the 5-hour figure is live. */
  fresh: boolean;
};

export type ClaudeSession = {
  session_id: string;
  /** Unix seconds. */
  mtime: number;
  /** First user-typed message in the session, ≤140 chars. May be empty. */
  first_prompt: string;
  /** Last user-typed message — usually the most identifying preview
   *  since openings are often "hi". ≤140 chars. */
  last_prompt: string;
  /** Approximate user-turn count. */
  turn_count: number;
  /** Agent steps — assistant messages in the transcript. A one-prompt
   *  session can still carry dozens (read → edit → run, turn after turn),
   *  so this is the honest depth signal the header shows. */
  step_count: number;
  /** Absolute path to the JSONL file. */
  file_path: string;
  /** Working directory the session was launched from, relative to the
   *  workspace root. Empty string when it was the root itself. */
  cwd_rel: string;
  /** Absolute working directory the session ran in. Resuming a session
   *  authored in a sibling worktree must spawn `claude --resume` from
   *  here (Claude resolves the id by cwd). Empty when none was recorded. */
  cwd?: string;
};

// One Tauri turn handle returned by agentStreamSend. The store
// subscribes to `topic` for StreamEvent values and to `done_topic`
// for an ExitInfo when the spawn ends.
export type TurnHandle = {
  turn_id: string;
  topic: string;
  done_topic: string;
};

/** Permission mode passed to `claude --permission-mode`. Maps 1:1 to
 *  the upstream CLI flag values; `default` is the no-flag baseline (we
 *  drop it in the spawn so claude uses its own default). */
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

/** User decision on a permission prompt. `allow_always` = remember the
 *  decision for the rest of this session. */
export type PermissionDecision = "allow" | "allow_always" | "deny";

/** Permission prompt event the MCP bridge emits when claude calls the
 *  permission_prompt tool. Held by `permissionStore` until the user
 *  picks a decision; the answer is forwarded back to the MCP shim,
 *  which returns it to claude. */
export type PermissionPrompt = {
  prompt_id: string;
  channel: string;
  tool_name: string;
  input: unknown;
  ts: number;
};

/** Image attachment for an outgoing user message. `data` is base64 with
 *  no `data:` prefix; `media_type` is the MIME label
 *  (`image/png`, `image/jpeg`, `image/gif`, `image/webp`). The backend
 *  packs these into the standard Anthropic content-block shape and feeds
 *  them on stdin via `claude --input-format stream-json`. */
export type ImageAttachment = {
  data: string;
  media_type: string;
};

// Typed union of events the stream backend emits. `kind` is the
// discriminant — matches the `serde(tag = "kind", rename_all = "snake_case")`
// in cmd_agent_stream.rs.
export type StreamEvent =
  | { kind: "user_prompt"; text: string; turn_id: string; ts: number }
  | {
      kind: "system_init";
      session_id: string;
      model: string | null;
      tools: string[];
      turn_id: string;
    }
  | { kind: "assistant_text"; text: string; turn_id: string }
  | {
      kind: "usage";
      context_tokens: number;
      output_tokens: number;
      message_id: string;
      turn_id: string;
    }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      input: unknown;
      turn_id: string;
    }
  | {
      kind: "tool_result";
      tool_use_id: string;
      content: string;
      is_error: boolean;
      turn_id: string;
    }
  | {
      kind: "result";
      success: boolean;
      duration_ms: number;
      cost_usd: number | null;
      total_tokens: number | null;
      message: string | null;
      turn_id: string;
    }
  | { kind: "raw_error"; message: string; turn_id: string }
  | {
      kind: "image";
      role: "user" | "assistant";
      data: string;
      media_type: string;
      turn_id: string;
    }
  // Local-only kinds — never emitted by the backend. Injected by the
  // frontend store to surface aura-protocol side effects (snapshot
  // taken, watchdog firing) inline in the same conversation timeline.
  | { kind: "aura_snapshot"; file_path: string; ts: number; turn_id: string }
  | {
      kind: "aura_warning";
      message: string;
      file_path: string | null;
      tool_use_id: string;
      turn_id: string;
    };

// Wave C — AuraWatch types. Mirror the Rust serde shapes in
// cmd_aurawatch.rs + aurawatch_inference.rs. Keep these in sync.
export type WatchMode = "off" | "nudge" | "autonomous";

export type InferenceBackendKind =
  | "ollama"
  | "agent_cli"
  | "anthropic"
  | "openai"
  | "gemini"
  | "mercury"
  | "generic";

// One installed, runnable coding-agent CLI Aura can use to fill in a
// change reason with no key and no ollama (it's already signed in).
export type AgentCliInfo = {
  kind: string;
  label: string;
  bin: string;
};

export type BackendDetection = {
  ollama: string | null;
  agent_clis: AgentCliInfo[];
  active_agent_kind: string | null;
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
  mercury: boolean;
  active: InferenceBackendKind;
};

export type WatchStatus = {
  mode: WatchMode;
  backend: InferenceBackendKind;
  detection: BackendDetection;
  pending: number;
  nudged_total: number;
  logged_total: number;
};

export type AuraLiveProcessStatus = {
  running: boolean;
  pid: number | null;
  started_at: number | null;
  /** Exit code of a daemon that died on its own (null while running or
   *  after an explicit stop). */
  exit_code: number | null;
  /** Stderr tail of the dead daemon — why the Go Live toggle flipped off. */
  last_error: string | null;
};

/** One teammate session from cloud presence (live daemon heartbeats). */
export type AuraCloudPeer = {
  username: string;
  avatar: string | null;
  branch: string;
  /** RFC3339 — parse with Date.parse for staleness. */
  last_seen: string;
  active_functions: string[];
  /** The signed-in user's own session (possibly this machine). */
  is_self: boolean;
};

export type AuraLivePeersResult = {
  /** false → presence can't be queried; `reason` explains (not signed in,
   *  no GitHub remote, cloud unreachable). */
  available: boolean;
  reason: string | null;
  peers: AuraCloudPeer[];
};

/** One awareness event in the Team Radar feed (mirrors the CLI's wire shape). */
export type RadarEvent = {
  id: string;
  actor: string;
  is_agent: boolean;
  kind: string; // started | editing | intent | impact | zone | paused | abandoned | committed
  repo: string;
  branch: string;
  file: string | null;
  symbol: string | null;
  intent: string | null;
  impact: string | null;
  ts: number;
  key_id: string | null;
  sig: string | null;
  /** Computed by the CLI on read: the event's embedded pubkey re-derives its
   *  key_id AND validates the signature. Undefined on older bundled CLIs (fall
   *  back to `!!sig` for a weaker "signed" signal). */
  verified?: boolean;
};

/** A reasoned collision between my in-flight work and another actor's. */
export type RadarCollision = {
  severity: "direct" | "likely" | "possible";
  peer: string;
  peer_is_agent: boolean;
  reason: string;
  mine: string;
  their_file: string | null;
  their_symbol: string | null;
  their_intent: string | null;
  their_branch: string;
  same_branch: boolean;
  age_ms: number;
  event_id: string;
};

/** The full radar view for a repo: ambient feed + scored collisions + focus. */
export type RadarView = {
  repo: string;
  branch: string;
  events: RadarEvent[];
  conflicts: RadarCollision[];
  focus: { files: string[]; symbols: string[] };
  /** The caller's own identity (git user.name) — lets presence surfaces
   *  exclude self-authored events. Absent on older bundled CLIs. */
  me?: string | null;
};

export type Nudge = {
  id: string;
  repo_root: string;
  channel: string;
  files: string[];
  text: string;
  created_at: number;
};

export type AppliedIntent = {
  repo_root: string;
  text: string;
  files: string[];
  at: number;
};

export type StreamExitInfo = {
  turn_id: string;
  exit_code: number;
};

// One zone-rule file (.aura/sentinel/zones/<id>.json). `mtime` is
// derived from the filesystem so the UI can render an age column.
export type ZoneRule = {
  zone_id: string;
  session_id: string;
  patterns: string[];
  /** "Warn" or "Block" (the CLI enum casing) — compare case-insensitively. */
  mode: string;
  /** Optional purpose label ("auth refactor"). Desktop-claimed zones carry it. */
  label?: string | null;
  /** Unix seconds. */
  mtime: number;
};

export type SavedPrompt = {
  id: string;
  name: string;
  description: string;
  body: string;
  agent: string | null;
  created_at: number;
  updated_at: number;
  usage_count: number;
};

// ── cli-agent OSC 777 events ─────────────────────────────────────────
//
// Shape mirrors `CliAgentEvent` in `cmd_agent_pty.rs`. Emitted on the
// `agent-event:<sessionId>` Tauri channel whenever the agent's plugin
// scripts (aura-claude / aura-gemini / …) flush a hook. Driven by the
// OSC 777 sentinel `aura://cli-agent`. Forked clean-room from Warp's
// MIT plugin scripts with sentinel + env var rebrand — see
// `aura-shell/plugins/aura-claude/`.

export type CliAgentEventName =
  | "session_start"
  | "prompt_submit"
  | "stop"
  | "permission_request"
  | "tool_complete"
  | "idle_prompt"
  | string;

export type CliAgentEvent = {
  v: number;
  agent: string;
  /** Loose union — string keeps forward-compat with new event names. */
  event: CliAgentEventName;
  session_id?: string;
  cwd?: string;
  project?: string;
  query?: string;
  response?: string;
  summary?: string;
  tool_name?: string;
  tool_input?: unknown;
  plugin_version?: string;
  transcript_path?: string;
  /** Catch-all for forward-compat fields. */
  [extra: string]: unknown;
};

export type CliAgentEventEnvelope = {
  /** Aura PTY session id (matches the `agent-pty:<id>` event channel). */
  session_id: string;
  event: CliAgentEvent;
};

// Managed worktree types — mirrors `aura-shell/src-tauri/src/worktree.rs`.
export type ResolvedRef =
  | { kind: "local"; name: string }
  | { kind: "remote_tracking"; remote: string; name: string }
  | { kind: "head" }
  | { kind: "tag"; name: string };

export type ManagedWorktree = {
  project_id: string;
  branch: string;
  path: string;
  start_point: string;
};

/** One isolated lane (AURA-81) — mirrors `Lane` in `cmd_lane.rs`.
 *  Serialised camelCase by the Rust side. */
export type Lane = {
  /** Stable id — the auto-named `lane/{agent}-{uuid8}` branch doubles as
   *  the id (unique by construction, survives a shell restart). */
  id: string;
  /** The auto-named branch this lane lives on. */
  branch: string;
  /** Absolute path to the lane's worktree (the agent PTY's cwd). */
  path: string;
  /** Agent CLI id the lane was spawned for (`claude`, `gemini`, …). */
  agent: string;
  /** Agent PTY session id when the lane has a live session, else null
   *  (e.g. a lane whose PTY child died but whose worktree survives). */
  termId: string | null;
  /** Optional human label the user gave the lane. */
  label: string | null;
};

/** Outcome of `laneDiscard` — mirrors `DiscardResult` in `cmd_lane.rs`.
 *  `dirty` means the lane had uncommitted work and nothing was removed
 *  (re-call with force=true); `discarded` means the worktree + branch
 *  were torn down. */
export type LaneDiscardResult =
  | { kind: "discarded" }
  | { kind: "dirty"; changedFiles: number };

/** One agent to spawn as part of a `workspaceLaunch` manifest. */
export type LaunchAgentSpec = {
  /** Agent CLI id — `claude`, `gemini`, `codex`, … */
  agentId: string;
  /** Optional isolated agent profile (~/.aura/agent-profiles/<name>/). */
  profileName?: string | null;
  /** Model id this agent's CLI launches on (`claude --model`, `gemini -m`,
   *  …). Omit → the agent's own configured default. */
  model?: string | null;
  /** Cross-agent reasoning effort for this agent. Omit → the agent's own
   *  default. */
  effort?: ReasoningEffort | null;
};

/** What `workspaceLaunch` produced. Every requested agent lands in
 *  exactly one of `sessions` (spawned) or `errors` (`"<agent>: <why>"`).
 *  The worktree is always present — its failure rejects the call. */
export type WorkspaceLaunchManifest = {
  worktree: ManagedWorktree;
  sessions: AgentSessionHandle[];
  errors: string[];
};

/** Coarse status the AgentChip / Manager DAG renders for a live PTY
 *  session. Driven entirely by `CliAgentEvent` deltas via
 *  `agentEventStore`. `idle` is the implicit pre-event state. */
export type CliAgentStatus =
  | { kind: "idle" }
  | { kind: "in_progress" }
  | { kind: "blocked"; summary: string }
  | { kind: "success"; query?: string; response?: string };

// v0.2.28 search types — mirror `aura-shell/src-tauri/src/cmd_search.rs`.
export type GrepOpts = {
  regex?: boolean;
  case_sensitive?: boolean;
  whole_word?: boolean;
  include?: string[];
  exclude?: string[];
};

export type GrepHit = {
  path: string;
  line: number;
  column: number;
  preview: string;
};

export type GrepResult = {
  hits: GrepHit[];
  truncated: boolean;
};

export type ReplaceReport = {
  files_changed: number;
  total_replacements: number;
  paths: string[];
};

export type SymbolHit = {
  path: string;
  line: number;
  kind: "function" | "class" | "type" | "const" | "unknown" | string;
  name: string;
  preview: string;
};

export type AppLocation = {
  bundle_path?: string;
  translocated: boolean;
  in_applications: boolean;
  writable: boolean;
};

// ── Modes + Marketplace (v0.2.32 MM.1) ────────────────────────────
//
// Mirrors `aura-shell/src-tauri/src/manager/modes/`. The YAML on disk
// matches the Rust serde shape one-to-one — keep these in sync if you
// add new fields.

export type ToolAcl = {
  allow: string[];
  deny: string[];
  advanced: string[];
};

export type ZoneHints = {
  prefers: string[];
  avoids: string[];
};

export type UiShroud = {
  accent?: string | null;
  badge?: string | null;
};

export type Mode = {
  schema_version: number;
  id: string;
  display_name: string;
  description: string;
  author: string;
  tags: string[];
  system_prompt: string;
  tool_acl: ToolAcl;
  default_brain?: string | null;
  brain_model?: string | null;
  zone_hints: ZoneHints;
  lane_default?: string | null;
  mcp_bundle: string[];
  ui: UiShroud;
};

/** Merged registry row — flattened `Mode` plus the install/runtime bits. */
export type ModeDescriptor = Mode & {
  bundled: boolean;
  installed: boolean;
  enabled: boolean;
  used: boolean;
  source: string;
  pin_blake3: string;
  installed_at: number;
};

export type MarketplaceIndexEntry = {
  id: string;
  display_name: string;
  description: string;
  author: string;
  tags: string[];
  url: string;
  pin_blake3?: string | null;
  installs: number;
  rating: number;
};

export type MarketplaceIndex = {
  entries: MarketplaceIndexEntry[];
  generated_at?: number | null;
};

export type ModePublishResult = {
  url: string;
  raw_url: string;
};

export type ModeUpdateRow = {
  slug: string;
  installed_pin: string;
  marketplace: MarketplaceIndexEntry;
};

export type ModeValidationIssue = {
  level: "error" | "warning";
  field: string;
  message: string;
};

export type ModeValidationReport = {
  ok: boolean;
  issues: ModeValidationIssue[];
  mode?: Mode;
};

// ─── Page comments (PR/ticket-style threads) ─────────────────────────────
//
// A Page's conversation lives in a durable sidecar JSON beside the page under
// `.aura/notes/<scope>/[bucket/]comments/<id>.json` (backed by
// `src-tauri/src/cmd_page_comments.rs`, atomic tmp-write + rename). The
// `pages2` surface consumes these through its own `pagesApi.ts`; these shared
// bindings expose the same commands for any other consumer.

export type PageComment = {
  id: string;
  author: string;
  body: string;
  created_at: string;
  /** Present (ISO ts) when the comment was resolved; absent while open. */
  resolved_at?: string | null;
};

/** Load a page's comment thread, oldest-first. */
export async function pageCommentsList(
  repoRoot: string,
  scope: string,
  bucket: string,
  id: string,
): Promise<PageComment[]> {
  return invoke("page_comments_list", { repoRoot, scope, bucket, id });
}

/** Append a comment and resolve with the persisted row. */
export async function pageCommentsAdd(
  repoRoot: string,
  scope: string,
  bucket: string,
  id: string,
  author: string,
  body: string,
): Promise<PageComment> {
  return invoke("page_comments_add", {
    repoRoot,
    scope,
    bucket,
    id,
    author,
    body,
  });
}

/** Toggle a comment's resolved state; returns the updated row. */
export async function pageCommentsResolve(
  repoRoot: string,
  scope: string,
  bucket: string,
  id: string,
  commentId: string,
  resolved: boolean,
): Promise<PageComment> {
  return invoke("page_comments_resolve", {
    repoRoot,
    scope,
    bucket,
    id,
    commentId,
    resolved,
  });
}

/** Delete a comment from a page's thread (idempotent). */
export async function pageCommentsDelete(
  repoRoot: string,
  scope: string,
  bucket: string,
  id: string,
  commentId: string,
): Promise<void> {
  return invoke("page_comments_delete", {
    repoRoot,
    scope,
    bucket,
    id,
    commentId,
  });
}

// ─── Mission Control — agent-orchestration overview ───────────────────────
// One typed envelope aggregating crew / automation / manual activity across
// every registered project. Keys match `cmd_mission.rs`
// (`#[serde(rename_all = "camelCase")]`) VERBATIM.

export type MissionRunSource = "crew" | "automation" | "manual";
export type MissionRunState = "working" | "queued" | "done" | "failed";

export type MissionRun = {
  id: string;
  project: string;
  projectName: string;
  title: string;
  agent: string | null;
  source: MissionRunSource;
  sourceDetail: string | null;
  state: MissionRunState;
  startedAtMs: number | null;
  endedAtMs: number | null;
  commit: string | null;
  prNumber: number | null;
  proof: { verdict: string; ok: number; total: number } | null;
  waitingOn: string[];
  steerable: boolean;
  error: string | null;
  nodeId: string | null;
};

export type MissionTrigger = {
  id: string;
  name: string;
  enabled: boolean;
  cadenceLabel: string;
  nextRunMs: number | null;
  project: string;
};

export type MissionHost = {
  configured: boolean;
  online: boolean;
  label: string;
};

export type MissionProject = {
  root: string;
  name: string;
};

export type MissionState = {
  live: MissionRun[];
  queued: MissionRun[];
  recent: MissionRun[];
  triggers: MissionTrigger[];
  host: MissionHost;
  projects: MissionProject[];
  capped: boolean;
};

export async function missionState(roots?: string[]): Promise<MissionState> {
  return invoke<MissionState>("mission_state", { roots });
}
