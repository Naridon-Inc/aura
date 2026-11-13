// The cloud place as the app shows it — its sidebar beside Home or one
// workspace — rendered on its own.
//
// Dev-server only — reached at /cloud-place-harness.html?scene=<name>, never
// bundled. The screens are the real ones; only the desktop's commands are
// stood in for, answering with one fixed organization. Nothing reaches a
// cloud or a machine, and nothing is saved anywhere.
//
//   home  Home with everyone's work; your own workspaces in the sidebar.
//   team  A teammate's row under Team clicked: Home shows only their work.
//   shared  Priya's workspace, where you asked a follow-up: your turns on
//         the right, hers on the left.
//   box   A workspace on one of the organization's machines: its chat, and
//         the right panel on that machine's files.
//   laptops  Home when the listing also carries the agent sessions laptops
//         report — the rows a server answers with before `origin=cloud`.
//   laptops-team  The same, then Priya's row under Team clicked once Home
//         has drawn: only her work is left.
//   unanswered  Your workspace no computer runs, with two messages nobody
//         answered: the banner that says so.
//   create  The new-workspace dialog, open.
//   box-drive  A workspace build-box answers by itself: an answer, a prompt
//         it couldn't run, and the newest one it is working on.
//   feedback  Priya's workspace with comments under its turns: a thread
//         with a reply, a resolved thread and a comment on the workspace.
//   feedback-read  The same, opened by a member who can only read it:
//         the box to prompt is locked, comments still work.
//
// Every scene keeps comments in memory, so adding one shows it; `box` has
// them on the machine chat's turns too, found by their keys.
//
// Add `&theme=light` for the light palette, `&agent=claude` for a Claude
// sign-in of your own, `&computer=none` for an organization without a cloud
// computer, and `&click=<label>` to press the button with that label once the
// page has drawn (`&click=Priya Nair` opens her card in a workspace header).

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import type { ChatTurn, DirEntry, FileDiffStat, GitStatusEntry, ManagerSession } from "../../../lib/api";
import type { CommentDto } from "../../../lib/cloudFeedbackApi";
import type { CloudRoutineRow, CloudWorkspaceRow } from "../../../lib/cloudWorkspacesApi";
import "../../../styles.css";
import { BOX_DRIVE_ID, boxDriveLog, boxDrivePlace, linkedRow } from "./boxDrive";
// The app loads the cloud surfaces' shared rows and segments globally.
import "../../ui/cloud-patterns.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "home";
if (params.get("theme") === "light") document.documentElement.classList.add("light");

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const ME = "u-sam";
const PRIYA = "u-priya";
const DIEGO = "u-diego";

const members = [
  { user_id: ME, github_login: "sam-k", display_name: "Sam Ortega", role: "owner" },
  { user_id: PRIYA, github_login: "priya-n", display_name: "Priya Nair", role: "member" },
  { user_id: DIEGO, github_login: "diego-r", display_name: "Diego Ruiz", role: "member" },
];

const repos = [
  { id: "r-store", full_name: "northwind/storefront", org_id: "o-nw", org_slug: "northwind", org_name: "Northwind" },
  { id: "r-api", full_name: "northwind/orders-api", org_id: "o-nw", org_slug: "northwind", org_name: "Northwind" },
  { id: "r-web", full_name: "northwind/web", org_id: "o-nw", org_slug: "northwind", org_name: "Northwind" },
  { id: "r-docs", full_name: "northwind/docs", org_id: "o-nw", org_slug: "northwind", org_name: "Northwind" },
];

const BOX_ROOT = "/home/ubuntu/aura/storefront-7c41a9e2";

const workspace = (
  id: string,
  objective: string,
  owner: string,
  repo: string,
  status: string,
  minutes: number,
  extra: Partial<CloudWorkspaceRow> = {},
): CloudWorkspaceRow => ({
  id,
  objective,
  status,
  intent: objective,
  intent_by: owner,
  created_by: owner,
  agent: "claude",
  branch: `aura/${objective.toLowerCase().split(" ").slice(0, 3).join("-")}`,
  model: "claude-sonnet-4-6",
  repo_id: repo,
  source: "public-api",
  section_id: null,
  section: null,
  created_at: minutesAgo(minutes + 90),
  last_activity_at: minutesAgo(minutes),
  ended_at: null,
  place: null,
  place_linked_by: null,
  ...extra,
});

const BOX_ID = "7c41a9e2-5b0d-4f3e-9a61-2d8e4b17c0aa";

const workspaces: CloudWorkspaceRow[] = [
  workspace(BOX_ID, "Add size and colour filters to search", ME, "r-store", "running", 2, {
    place: {
      kind: "box",
      machine: "build-box",
      remote_root: BOX_ROOT,
      branch: "aura/search-filters",
      engine: "claude",
      agent_session_id: null,
      place_id: "pl-build",
    },
    place_linked_by: ME,
  }),
  workspace("b28e60d4-91c7-4a35-8f02-6e1d9c3ab744", "Retry failed card payments once before giving up", ME, "r-api", "sleeping", 75),
  workspace("e5f1c3a7-2d84-4b96-a0e3-9c7b51f8d062", "Welcome email series for new stores", PRIYA, "r-store", "running", 6),
  workspace("3a9d72b1-c6e0-4f18-b5d4-08e2a6f9c135", "Fix the flaky cart total test", PRIYA, "r-store", "sleeping", 180),
  workspace("d06b4e8f-7a13-42c9-9e5b-b4f0c8d21a7e", "CSV export for the orders page", DIEGO, "r-api", "running", 14),
];

/** An agent session a laptop reported, shaped as the production listing
 *  returns one: no owner, usually no objective, the laptop as the source. A
 *  desktop reports one session into every project it has open, so the same
 *  id comes back once per repository. */
const laptop = (
  id: string,
  objective: string | null,
  repo: string,
  source: "aura-shell" | "aura-cli",
  minutes: number,
): CloudWorkspaceRow => ({
  id,
  objective,
  status: "running",
  intent: null,
  intent_by: null,
  created_by: null,
  agent: source === "aura-cli" ? "claude" : null,
  branch: "main",
  model: null,
  repo_id: repo,
  source,
  section_id: null,
  section: null,
  created_at: minutesAgo(minutes + 30),
  last_activity_at: minutesAgo(minutes),
  ended_at: null,
  place: null,
  place_linked_by: null,
});

const DESKTOP_SESSION = "9f3e1c2a-0b7d-4e55-8a61-3c2b9d4e7f10";
const laptopRows: CloudWorkspaceRow[] = [
  ...["r-store", "r-api", "r-web", "r-docs"].map((repo) => laptop(DESKTOP_SESSION, null, repo, "aura-shell", 720)),
  laptop("4c8a2e1f-6d3b-4a97-b0e2-5f1d7c9a3b86", "Claude Code", "r-store", "aura-shell", 30),
  laptop("a71d5b3e-2c9f-4e08-9b46-1e7a3d5c8f20", "storefront", "r-store", "aura-cli", 240),
  laptop("c2e9f4a6-8b1d-4c73-a5e0-7d3b9f1e6a42", "local", "r-web", "aura-cli", 400),
];
if (scene.startsWith("laptops")) workspaces.push(...laptopRows);

const UNANSWERED_ID = "f4a2c8e1-3b7d-4d90-8e15-6a9c2f0b7d34";
workspaces.push(workspace(UNANSWERED_ID, "Speed up the product page", ME, "r-store", "running", 20));

if (scene === "box-drive") {
  workspaces.push(
    workspace(BOX_DRIVE_ID, "Back in stock emails", PRIYA, "r-store", "running", 1, {
      place: boxDrivePlace("build-box", "pl-build"),
      place_linked_by: PRIYA,
    }),
  );
}
const boxDriveLogRows = boxDriveLog(ME, PRIYA);

const routines: CloudRoutineRow[] = [];

const at = (name: string, dir = false, status: string | null = null): DirEntry => ({
  name,
  path: `${BOX_ROOT}/${name}`,
  is_dir: dir,
  git_status: status,
});

const boxTree: Record<string, DirEntry[]> = {
  [BOX_ROOT]: [
    at(".github", true),
    at("public", true),
    at("src", true, "M"),
    at("tests", true, "M"),
    at("package.json"),
    at("README.md"),
    at("tsconfig.json"),
    at("vite.config.ts"),
  ],
  [`${BOX_ROOT}/src`]: [
    { name: "search", path: `${BOX_ROOT}/src/search`, is_dir: true, git_status: "M" },
    { name: "cart", path: `${BOX_ROOT}/src/cart`, is_dir: true, git_status: null },
    { name: "main.tsx", path: `${BOX_ROOT}/src/main.tsx`, is_dir: false, git_status: null },
  ],
  [`${BOX_ROOT}/src/search`]: [
    { name: "Filters.tsx", path: `${BOX_ROOT}/src/search/Filters.tsx`, is_dir: false, git_status: "?" },
    { name: "query.ts", path: `${BOX_ROOT}/src/search/query.ts`, is_dir: false, git_status: "M" },
    { name: "SearchPage.tsx", path: `${BOX_ROOT}/src/search/SearchPage.tsx`, is_dir: false, git_status: "M" },
  ],
};

const boxStatus: GitStatusEntry[] = [
  { path: "src/search/Filters.tsx", index: "?", worktree: "?" },
  { path: "src/search/query.ts", index: "", worktree: "M" },
  { path: "src/search/SearchPage.tsx", index: "", worktree: "M" },
  { path: "tests/search.test.ts", index: "", worktree: "M" },
];

const boxStats: FileDiffStat[] = [
  { path: "src/search/Filters.tsx", additions: 84, deletions: 0 },
  { path: "src/search/query.ts", additions: 22, deletions: 6 },
  { path: "src/search/SearchPage.tsx", additions: 9, deletions: 3 },
  { path: "tests/search.test.ts", additions: 31, deletions: 0 },
];

const SHARED_ID = "e5f1c3a7-2d84-4b96-a0e3-9c7b51f8d062";
const message = (id: string, role: string, body: string, minutes: number, author: string | null, name: string | null) => ({
  id,
  role,
  body,
  source: "public-api",
  author_id: author,
  author_name: name,
  created_at: minutesAgo(minutes),
});
const sharedLog = [
  message("m1", "user", "Draft a three-email welcome series for stores that just signed up.", 40, PRIYA, "Priya Nair"),
  message(
    "m2",
    "assistant",
    "Added `emails/welcome/` with three templates — day 0 (set up your store), day 2 (add products), day 7 (first sale tips) — and a scheduler entry for each.",
    36,
    null,
    null,
  ),
  message("m3", "user", "Can the day 2 email link straight to the product import page?", 12, ME, "Sam Ortega"),
  message(
    "m4",
    "assistant",
    "Done: the day 2 button now opens `/products/import`, and the plain-text version carries the same link.",
    6,
    null,
    null,
  ),
  message("m5", "user", "@priya-n the subject lines read well to me. Happy for these to go out?", 3, ME, "Sam Ortega"),
  message("m6", "user", "@sam-k yes, ship them. Thanks!", 1, PRIYA, "Priya Nair"),
];
const unansweredLog = [
  message("u1", "user", "The product page takes four seconds to show its first image. Find out why.", 22, ME, "Sam Ortega"),
  message("u2", "user", "And keep the image sizes the designers picked.", 20, ME, "Sam Ortega"),
];

// Comments, by workspace, as the cloud would hold them.
const NAMES: Record<string, string> = { [ME]: "Sam Ortega", [PRIYA]: "Priya Nair", [DIEGO]: "Diego Ruiz" };
const note = (
  id: string,
  message_id: string | null,
  parent_id: string | null,
  author: string,
  body: string,
  minutes: number,
  extra: Partial<CommentDto> = {},
): CommentDto => ({
  id,
  message_id,
  message_key: null,
  parent_id,
  author_id: author,
  author_name: NAMES[author] ?? null,
  body,
  created_at: minutesAgo(minutes),
  updated_at: minutesAgo(minutes),
  edited_at: null,
  deleted: false,
  resolved_at: null,
  resolved_by: null,
  ...extra,
});
const BOX_TURNS = { user: "kept-box-1", answer: "kept-box-2" };
const feedbackOf: Record<string, { comments: CommentDto[] }> = {
  [SHARED_ID]: {
    comments: [
      note("c1", "m2", null, PRIYA, "Can the day 7 email wait until a store has added its first product? @sam-k", 33),
      note("c2", "m2", "c1", ME, "Good call. I’ll ask Claude to hold it back until then.", 31),
      note("c3", "m2", "c1", DIEGO, "", 30, { deleted: true }),
      note("c4", "m4", null, DIEGO, "Does the import page work on a phone?", 5, {
        resolved_at: minutesAgo(4),
        resolved_by: PRIYA,
      }),
      note("c5", "m4", "c4", PRIYA, "Yes, checked it on mine.", 4),
      note("c6", null, null, DIEGO, "Let’s get these out before Friday’s newsletter.", 8),
    ],
  },
  [BOX_ID]: {
    comments: [note("bc1", "bx2", null, PRIYA, "Could the colour chips show the swatch, not only the name?", 2)],
  },
};
const fb = (id: unknown) => (feedbackOf[String(id)] ??= { comments: [] });
let made = 0;
const changed = (id: unknown, commentId: unknown, change: (c: CommentDto) => Partial<CommentDto>) => {
  const list = fb(id).comments;
  const at = list.findIndex((c) => c.id === commentId);
  if (at < 0) throw new Error('HTTP 404 Not Found: {"error":"comment not found"}');
  list[at] = { ...list[at]!, ...change(list[at]!), updated_at: new Date().toISOString() };
  return list[at];
};

// The box chat, as this laptop's copy of it holds it once it has connected.
const SESSION = "box-chat-harness";
const BRAIN = `place:ws-${BOX_ID}`;
const secondsAgo = (m: number) => Math.floor(Date.now() / 1000) - m * 60;
const chat: ChatTurn[] = [
  {
    role: "user",
    text: "Add size and colour filters to the search page. Keep the query in the URL so a filtered search can be shared.",
    at: secondsAgo(9),
    cloud_key: BOX_TURNS.user,
  },
  {
    role: "manager",
    brain: BRAIN,
    model: "claude-sonnet-4-6",
    at: secondsAgo(4),
    tool_calls: [
      {
        tool_use_id: "t1",
        name: "Read",
        input: { file_path: `${BOX_ROOT}/src/search/query.ts` },
        result: { is_error: false, content: "export function parseQuery(params: URLSearchParams) {…}" },
      },
      {
        tool_use_id: "t2",
        name: "Write",
        input: { file_path: `${BOX_ROOT}/src/search/Filters.tsx` },
        result: { is_error: false, content: "File created" },
      },
      {
        tool_use_id: "t3",
        name: "Bash",
        input: { command: "npm test -- search" },
        result: { is_error: false, content: "Tests: 12 passed, 12 total" },
      },
    ],
    text:
      "Done. Search now has **Size** and **Colour** filters:\n\n" +
      "- `Filters.tsx` draws both as chips above the results.\n" +
      "- `query.ts` reads and writes `size` and `colour` in the URL, so a filtered search can be shared as a link.\n" +
      "- `search.test.ts` covers parsing both, and an empty filter.\n\n" +
      "All 12 search tests pass.",
    cloud_key: BOX_TURNS.answer,
  },
];

const session: ManagerSession = {
  id: SESSION,
  objective: "Add size and colour filters to search",
  status: "running",
  projects: [],
  tasks: [],
  ribbon: [],
  chat,
  pending_question: null,
  pending_plan: null,
  pending_scout: null,
  machine_id: "ubuntu@build-box:/home/ubuntu/aura/storefront",
  created_at: secondsAgo(10),
  updated_at: secondsAgo(4),
};

// The laptop already holds this chat, so opening the workspace resumes it.
try {
  localStorage.setItem(`aura.cloudBoxChat.thread.${BOX_ID}`, SESSION);
} catch {
  // A browser without storage starts the chat instead.
}

/** Commands no answer was given for, in the order they were first asked. */
const unknown: string[] = [];
(window as unknown as { __unknown: string[] }).__unknown = unknown;

const buildBox = {
  id: "ubuntu@build-box:/home/ubuntu/aura/storefront",
  name: "build-box",
  host: "build-box",
  user: "ubuntu",
  key_path: "",
  box_kind: "mine",
  repo_path: "/home/ubuntu/aura/storefront",
  project_root: "/Users/sam/storefront",
};

const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
  cloud_auth_status: () => ({
    connected: true,
    user: "sam-k",
    org_slug: "northwind",
    org_name: "Northwind",
    cloud_url: "https://cloud.example.com",
  }),
  cloud_me: () => ({ user_id: ME, github_login: "sam-k", email: null }),
  cloud_org_members: () => members,
  cloud_repos: () => repos,
  cloud_workspaces_list: () => workspaces,
  cloud_routines_list: () => routines,
  cloud_billing_status: () => ({
    plan: "Teams",
    effective_plan: "Teams",
    org_slug: "northwind",
    seat_count: 3,
    has_billing: true,
    trial_active: false,
    trial_days_remaining: null,
    payment: null,
    error: null,
  }),
  machines_list: () => [buildBox],
  cloud_jobs_all: () => [],
  cloud_agent_credentials_list: () => ({
    credentials:
      params.get("agent") === "claude"
        ? [{ name: "claude_code_oauth_token", workspace_id: null, updated_at: minutesAgo(600), hint: "Ab3x" }]
        : [],
    selections: [],
  }),
  // The organization's cloud computer, reachable from this laptop.
  places_list: () => ({
    places:
      params.get("computer") === "none"
        ? []
        : [
            {
              id: "ubuntu@build-box:/home/ubuntu/aura/storefront",
              name: "build-box",
              source: "both",
              owner: { kind: "org" },
              added_by: { kind: "unknown" },
              may: {},
              machine: buildBox,
              runner_id: "pl-build",
              online: true,
              agents: ["claude"],
              added_at: 0,
              last_used_at: 0,
            },
          ],
    org: { status: "ok", detail: "", slug: "northwind", name: "Northwind", my_role: "owner" },
  }),
  box_projects: () => ({
    org: "northwind",
    org_name: "Northwind",
    projects: [
      {
        path: "/home/ubuntu/aura/storefront",
        name: "storefront",
        remote: "https://github.com/northwind/storefront.git",
        branch: "main",
        dirty: 0,
      },
    ],
    withheld: [],
    narrowed: true,
  }),
  os_notify_available: () => false,
  cloud_presence_beacon: () => null,
  // Priya is in the app, reading her own workspace.
  cloud_presence_list: () => [
    {
      user_id: PRIYA,
      state: "active",
      typing: false,
      viewing_workspace_id: null,
      last_seen_at: minutesAgo(0),
      last_active_at: minutesAgo(0),
    },
  ],
  cloud_following: () => [],
  cloud_mentions: () => [],
  cloud_pokes: () => [],
  cloud_poke_settings: () => ({ enabled: true }),
  "plugin:notification|registerListener": () => 0,
  "plugin:notification|register_listener": () => 0,
  cloud_workspace_access: () => ({
    workspace_id: BOX_ID,
    general: "organization",
    grants: [],
    followers: [],
    owner_id: ME,
    can_manage: true,
    following: true,
    your_access: scene === "feedback-read" ? "read" : "write",
  }),
  cloud_feedback_read: (a) => ({ ...fb(a.id), as_of: new Date().toISOString(), more: false }),
  cloud_comment_create: (a) => {
    const f = fb(a.id);
    const parent = a.parentId ? f.comments.find((c) => c.id === a.parentId) : undefined;
    made += 1;
    const c = note(`new-${made}`, parent ? parent.message_id : ((a.messageId as string | null) ?? null), parent?.id ?? null, ME, String(a.body), 0);
    f.comments.push(c);
    return c;
  },
  cloud_comment_edit: (a) => changed(a.id, a.commentId, () => ({ body: String(a.body), edited_at: new Date().toISOString() })),
  cloud_comment_delete: (a) => changed(a.id, a.commentId, () => ({ body: "", deleted: true })),
  cloud_comment_resolve: (a) =>
    changed(a.id, a.commentId, () => ({ resolved_at: new Date().toISOString(), resolved_by: ME })),
  cloud_comment_reopen: (a) => changed(a.id, a.commentId, () => ({ resolved_at: null, resolved_by: null })),
  // The ids the relay got back for the box chat's turns, by their keys.
  cloud_box_turn_ids: (a) => (a.id === BOX_ID ? { [BOX_TURNS.user]: "bx1", [BOX_TURNS.answer]: "bx2" } : {}),
  cloud_box_chat_attach: () => ({
    provider: BRAIN,
    machineId: "ubuntu@build-box:/home/ubuntu/aura/storefront",
    repoRoot: "/Users/sam/storefront",
  }),
  cloud_box_chat_people: () => null,
  cloud_box_chat_answers: () => ({ answers: [], busy: false }),
  cloud_workspace_messages: (a) =>
    a.id === SHARED_ID
      ? sharedLog
      : a.id === UNANSWERED_ID
        ? unansweredLog
        : a.id === BOX_DRIVE_ID
          ? boxDriveLogRows
          : [],
  // Handing a workspace to a computer, as the cloud stores it.
  cloud_box_link: (a) => {
    const at = workspaces.findIndex((w) => w.id === a.id);
    const link = a.link as { machine: string; placeId: string };
    if (at < 0) throw new Error('HTTP 404 Not Found: {"error":"workspace not found"}');
    workspaces[at] = linkedRow(workspaces[at]!, link, ME);
    return workspaces[at];
  },
  cloud_workspace_changes: () => ({ source: "github", reason: null, files: [], commits_read: 1, truncated: false }),
  "plugin:event|listen": () => 0,
  "plugin:event|unlisten": () => null,
  agents_list: () => [],
  // What the agent on the machine offered when its conversation opened.
  cloud_box_chat_models: () => [
    { id: "default", label: "Default (recommended)" },
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
  ],
  claude_usage_snapshot: () => null,
  brain_api_spend: () => [],
  manager_status: () => session,
  manager_chat_start: () => SESSION,
  manager_set_brain_override: () => null,
  place_fs_list: (a) => boxTree[String(a.path)] ?? [],
  place_git_status_v2: () => boxStatus,
  place_git_diff_stats_per_file: () => boxStats,
  place_git_ahead_behind: () => ({ ahead: 3, behind: 0, has_upstream: true, branch: "aura/search-filters" }),
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const answer = answers[cmd];
    if (!answer) {
      if (!unknown.includes(cmd)) unknown.push(cmd);
      throw new Error(`command ${cmd} not found`);
    }
    return answer(args);
  },
  transformCallback: () => 0,
  unregisterCallback: () => undefined,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
};

(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => undefined,
};

// Loaded once the stand-in is in place: some modules read the desktop as
// they load.
const { Layout } = await import("../../Layout");
const { CloudSidebar } = await import("../CloudSidebar");
const { CloudPlacePage } = await import("../CloudPlacePage");
const { CloudTeamHost } = await import("../CloudTeamHost");
const { openCloud, openCloudWorkspace, setCloudCreating } = await import("../../../lib/cloudPlace");
const { PUBLIC_ROW_PREFIX } = await import("../cloudRows");

if (scene === "team") openCloud("home", [PRIYA]);
else if (scene === "laptops-team") {
  openCloud("home");
  // After Home has drawn everyone's rows, the way a click under Team lands.
  setTimeout(() => {
    openCloud("home", [PRIYA]);
    document.body.dataset.ready = "yes";
  }, 1500);
}
else if (scene === "shared" || scene.startsWith("feedback")) openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${SHARED_ID}`);
else if (scene === "box") openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${BOX_ID}`);
else if (scene === "unanswered") openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${UNANSWERED_ID}`);
else if (scene === "box-drive") openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${BOX_DRIVE_ID}`);
else if (scene === "create") {
  openCloud("home");
  setCloudCreating(true);
} else openCloud("home");

// Press a button by its label once the page has drawn.
const press = params.get("click");
if (press) {
  setTimeout(() => {
    const label = `[aria-label="${CSS.escape(press)}"], [aria-label^="${CSS.escape(press)},"]`;
    const header = document.querySelector('[aria-label="People in this workspace"]');
    const byLabel = header?.querySelector<HTMLElement>(label) ?? document.querySelector<HTMLElement>(label);
    const byText = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim() === press);
    (byLabel ?? byText)?.click();
    document.body.dataset.pressed = byLabel || byText ? "yes" : "missing";
  }, 1800);
}

ReactDOM.createRoot(document.getElementById("cloud-place-harness")!).render(
  <StrictMode>
    <Layout
      sidebar={<CloudSidebar fullscreen={false} onHide={() => undefined} />}
      body={<CloudPlacePage repoRoot="/Users/sam/storefront" />}
      composer={null}
      sidebarOpen
      reviewOpen={false}
      pageOwnsWindow
    />
    <CloudTeamHost />
  </StrictMode>,
);
