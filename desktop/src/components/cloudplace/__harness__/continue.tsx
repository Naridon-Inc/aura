// Move to cloud, rendered on its own at each answer it can give.
//
// Dev-server only — reached at /continue-cloud-harness.html?scene=<name>,
// never bundled. The dialog is the real one, and so is everything it calls;
// only the desktop's commands are stood in for. Nothing is pushed, no
// workspace is made and no machine is reached. Every command the dialog
// sends is written under it, in order, so a scene that presses the button
// shows exactly what would have run.

import { StrictMode, useState } from "react";
import ReactDOM from "react-dom/client";

import "../../../styles.css";
import "../../ui/cloud-patterns.css";

type Scene = {
  ahead?: number;
  behind?: number;
  upstream?: boolean;
  dirty?: number;
  chat?: boolean;
  /** The team has a cloud computer (a runner) that answers by itself. */
  computer?: boolean;
  /** A machine in this laptop's book has the repository checked out. */
  machine?: boolean;
  /** Why GitHub won't let the computer fetch the repository, when it won't. */
  unreachable?: string;
  /** What the machine says when the chat is opened, when it refuses. */
  openFails?: string;
  press?: boolean;
};

const SCENES: Record<string, Scene> = {
  ready: { ahead: 2, dirty: 3, chat: true },
  clean: { chat: false },
  unpublished: { upstream: false, chat: true },
  diverged: { ahead: 1, behind: 2 },
  "behind-dirty": { behind: 2, dirty: 1 },
  "no-computer": { computer: false, machine: false },
  pressed: { ahead: 2, dirty: 3, chat: true, press: true },
  "not-in-app": {
    chat: true,
    press: true,
    unreachable: "Add acme/web to the Aura GitHub App’s repository access on GitHub, then try again.",
  },
  "machine-only": { computer: false, ahead: 2, chat: true },
  "machine-refuses": {
    computer: false,
    ahead: 0,
    chat: true,
    press: true,
    openFails: "build-box already has its own commits on fix/login that GitHub doesn't, so it won't move the branch under them.",
  },
};

const params = new URLSearchParams(location.search);
const name = params.get("scene") ?? "ready";
try {
  localStorage.clear();
} catch {
  // A profile without storage still draws the dialog.
}
const scene = SCENES[name] ?? SCENES.ready;
if (params.get("theme") === "light") document.documentElement.classList.add("light");

const PATH = "/Users/sam/web-fix-login";
const sent: { cmd: string; args: unknown }[] = [];
const turns = [
  ["user", "The login form retries forever when the token is expired. Make it give up after three tries."],
  ["manager", "Added a retry cap in src/auth/session.ts and a test for the expired-token case. The test passes locally."],
  ["user", "Open a PR for it."],
  ["manager", "Pushed fix/login and opened pull request #42."],
  ["user", "Review says the backoff should be exponential."],
] as const;

const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
  git_ahead_behind: () => ({
    ahead: scene.ahead ?? 0,
    behind: scene.behind ?? 0,
    has_upstream: scene.upstream ?? true,
    branch: "fix/login",
  }),
  git_status: () => Object.fromEntries(Array.from({ length: scene.dirty ?? 0 }, (_, i) => [`src/f${i}.ts`, "M"])),
  git_remote_origin: () => "git@github.com:acme/web.git",
  places_list: () => ({
    org: {},
    places: [
      ...(scene.computer === false
        ? []
        : [{ id: "r-1", name: "team-box", runner_id: "4a1f0c2e-0000-4000-8000-000000000001", online: true, agents: ["claude"] }]),
      ...(scene.machine === false
        ? []
        : [
            {
              id: "m-0000000000000001",
              name: "build-box",
              machine: { id: "m-0000000000000001", name: "build-box", host: "box.example", user: "u", port: 22 },
              online: true,
              agents: ["claude"],
            },
          ]),
    ],
  }),
  box_projects: () => ({
    org: null,
    org_name: null,
    projects: [{ path: "/home/u/web", name: "web", remote: "git@github.com:acme/web.git", branch: "main", dirty: 0 }],
    withheld: [],
  }),
  manager_list: () => (scene.chat ? [{ id: "s-1", objective: "Login retry", status: "idle", repo_root: PATH }] : []),
  manager_status: () => ({ id: "s-1", chat: turns.map(([role, text], i) => ({ role, text, at: i })) }),
  cloud_agent_credentials_list: () => ({
    credentials: [{ name: "claude_code_oauth_token", workspace_id: null, updated_at: "2026-11-10T00:00:00Z", hint: "Ab3x" }],
    selections: [],
  }),
  cloud_auth_status: () => ({ user: "sam", org_name: "Acme" }),
  cloud_me: () => ({ user_id: "u-sam" }),
  cloud_org_members: () => [{ user_id: "u-sam", display_name: "Sam", github_login: "sam" }],
  cloud_repos: () => [{ full_name: "Acme/web" }],
  cloud_workspaces_list: () => [],
  cloud_routines_list: () => [],
  git_status_v2: () => Array.from({ length: scene.dirty ?? 0 }, (_, i) => ({ path: `src/f${i}.ts`, index: "", worktree: "M" })),
  git_stage: () => "",
  git_commit: () => "committed",
  git_push: () => "pushed",
  cloud_workspace_pull_request: () => ({
    branch: "fix/login",
    base: "main",
    repo: "acme/web",
    reason: scene.unreachable ? "project_not_in_github_app" : null,
    detail: scene.unreachable ?? null,
    compare_url: null,
    merge_method: null,
    pr: null,
  }),
  cloud_box_link: () => ({ id: "ws-7f3a" }),
  cloud_workspace_prompt: () => ({ id: "msg-1" }),
  manager_append_chat: () => undefined,
  cloud_workspace_create: () => ({ id: "ws-7f3a" }),
  cloud_box_chat_open: () => {
    if (scene.openFails) throw scene.openFails;
    return { sessionId: "box-ws-7f3a" };
  },
  cloud_workspace_set_state: () => ({ id: "ws-7f3a" }),
};

/** Reads the dialog makes on its way, not acts it takes: left out of the log. */
const READS = new Set([
  "git_ahead_behind", "git_status", "git_remote_origin", "places_list", "box_projects", "manager_list",
  "manager_status", "cloud_agent_credentials_list", "cloud_auth_status", "cloud_me", "cloud_org_members",
  "cloud_repos", "cloud_workspaces_list", "cloud_routines_list", "agent_models_list",
]);

function drawLog() {
  const pre = document.getElementById("continue-cloud-log");
  const held = localStorage.getItem("aura.cloudBoxChat.pending.ws-7f3a");
  const log = sent.map((s) => `${s.cmd} ${JSON.stringify(s.args)}`).join("\n\n");
  if (pre) pre.textContent = held ? `${held}\n\n── What ran, in order ──\n\n${log}` : log;
}

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    if (!READS.has(cmd)) {
      sent.push({ cmd, args });
      drawLog();
    }
    const answer = answers[cmd];
    if (!answer) throw new Error(`command ${cmd} not found`);
    return answer(args);
  },
  transformCallback: () => 0,
  unregisterCallback: () => undefined,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
};
(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => undefined,
};

const { ContinueInCloudDialog } = await import("../ContinueInCloudDialog");

function Page() {
  const [closed, setClosed] = useState(false);
  return (
    <>
      {closed ? (
        <p style={{ margin: 16, fontSize: 13, color: "var(--ui-fg)" }}>
          Dialog closed and the cloud workspace opened. The chat’s first message, held for it:
        </p>
      ) : (
        <ContinueInCloudDialog
          path={PATH}
          branch="fix/login"
          title="Login retry"
          pr={42}
          onClose={() => {
            document.body.dataset.closed = "yes";
            setClosed(true);
          }}
        />
      )}
      <pre
        id="continue-cloud-log"
        style={{ position: "fixed", left: 12, right: 12, ...(closed ? { top: 44 } : { bottom: 12 }), margin: 0, maxHeight: closed ? 760 : 240, overflow: "auto", fontSize: 10, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--ui-muted-fg)", zIndex: 99999 }}
      />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("continue-cloud-harness")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);

const ready = () => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Move to cloud");
  const settled = document.querySelector(".ui-continue-cloud")?.getAttribute("data-state");
  if (document.body.dataset.pressed === "yes") return;
  if (settled === "checking" || !settled) return void window.setTimeout(ready, 60);
  if (scene.press && button && !button.disabled && document.body.dataset.pressed !== "yes") {
    document.body.dataset.pressed = "yes";
    button.click();
    window.setTimeout(() => {
      drawLog();
      document.body.dataset.ready = "yes";
    }, 600);
    return;
  }
  if (!scene.press || settled !== "ready") document.body.dataset.ready = "yes";
  else window.setTimeout(ready, 60);
};
window.setTimeout(ready, 60);
