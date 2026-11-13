// Settings › Cloud computer, rendered on its own inside the real settings
// frame.
//
// Dev-server only — reached at /cloud-computer-harness.html?scene=<name>, never
// bundled. The page is the real one; only the desktop's commands are stood in
// for, answering with one shared box that holds more repositories than this
// laptop connected it for. Nothing is cloned, built or granted: a switch
// flipped here changes this page's memory and nothing else.
//
// Scenes:
//   admin       — an owner: every repository the box holds, seat switches
//   member      — a member: the seat list read-only, with the reason
//   unreachable — the box doesn't answer: the book's rows, and a note saying so
//   advanced    — admin, with Advanced open on Connected machines
// Add `&theme=light` for the light palette.

import { StrictMode, useState } from "react";
import ReactDOM from "react-dom/client";

import type {
  BoxProject,
  CloudAccess,
  CloudOrgMember,
  CloudRunner,
  Machine,
  PlaceProjects,
} from "../../../lib/api";
import type { TeamBase } from "../../../lib/place/teamBase";
import { SettingsLayout } from "../../ui/settings-layout";
import { navigationGroups, pageLabel } from "../nav";
import { SettingsPageView } from "../SettingsPageView";
import "../../../styles.css";
// The app loads the cloud surfaces' shared rows and segments globally.
import "../../ui/cloud-patterns.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "admin";
if (params.get("theme") === "light") document.documentElement.classList.add("light");

const member = scene === "member";
const me = member ? "priya-n" : "sam-k";

const MEMBERS: CloudOrgMember[] = [
  { user_id: "u-sam", github_login: "sam-k", display_name: "Sam Ortega", role: "owner" },
  { user_id: "u-lea", github_login: "lea-m", display_name: "Léa Martin", role: "admin" },
  { user_id: "u-priya", github_login: "priya-n", display_name: "Priya Nair", role: "member" },
  { user_id: "u-diego", github_login: "diego-r", display_name: "Diego Ruiz", role: "member" },
  { user_id: "u-ana", github_login: "ana-p", display_name: "Ana Pereira", role: "member" },
];

// The one row this laptop's machine book has: it connected the box for one
// repository, which is all the page used to list.
const BOOK: Machine[] = [
  {
    id: "m-runner",
    name: "aura-runner",
    host: "10.0.0.4",
    user: "ubuntu",
    key_path: "managed:x",
    box_kind: "shared",
    repo_path: "/home/ubuntu/aura",
    project_root: "/Users/me/aura",
    repo_branch: "main",
    org_slug: "northwind",
  } as unknown as Machine,
];

// What the box itself says it holds: the booked one, one a teammate cloned,
// and two the runner cloned for cloud work under its own folder.
const HELD: BoxProject[] = [
  { path: "/home/ubuntu/aura", name: "aura", remote: "git@github.com:northwind/aura.git", branch: "main", dirty: 0 },
  { path: "/home/ubuntu/storefront", name: "storefront", remote: "git@github.com:northwind/storefront.git", branch: "release", dirty: 3 },
  { path: "/home/ubuntu/aura-workspaces/northwind__api", name: "api", remote: "git@github.com:northwind/api.git", branch: "main", dirty: 0 },
  { path: "/home/ubuntu/aura-workspaces/northwind__docs", name: "docs", remote: "git@github.com:northwind/docs.git", branch: "main", dirty: 0 },
];

const PROJECTS: PlaceProjects = {
  org: "northwind",
  org_name: "Northwind",
  projects: HELD,
  withheld: [],
  narrowed: false,
  notice: null,
} as unknown as PlaceProjects;

const BASE: TeamBase = {
  place: "aura-runner",
  login: "aura-base",
  home: "/home/aura-base",
  created: false,
  shared: true,
  readable: true,
  scoped: true,
  holds: [
    { under: ".cargo", tool: "cargo", holds: "Rust 1.86" },
    { under: ".bun", tool: "bun", holds: "Bun 1.2" },
  ],
  carries: [],
  built_version: 3,
  built_digest: "9f2c4e1ab07d55e3",
};

const RUNNERS: CloudRunner[] = [
  {
    id: "r-1",
    name: "aura-runner",
    agent_kinds: ["claude", "codex"],
    version: "0.20.1",
    status: "idle",
    last_heartbeat_at: new Date().toISOString(),
    current_task: null,
    online: true,
  },
];

let seats: CloudAccess = {
  org_slug: "northwind",
  grants: [{ user_id: "u-priya", github_login: "priya-n", source: "manual" }],
  granted: 1,
  seat_count: 5,
  plan: "team",
} as CloudAccess;

const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
  machines_list: () => BOOK,
  box_projects: () => {
    if (scene === "unreachable") throw new Error("ssh: connect to host 10.0.0.4 port 22: Operation timed out");
    return PROJECTS;
  },
  place_team_base: () => BASE,
  read_file: (args) => ({
    path: args.path,
    text: '[env]\nversion = 3\n\n[env.tools]\nrust = "1.86"\nbun = "1.2"\n',
    size: 60,
    language: "toml",
    status: "ok",
  }),
  cloud_auth_status: () => ({ connected: true, user: me, org_slug: "northwind", org_name: "Northwind", cloud_url: "" }),
  cloud_runners: () => RUNNERS,
  cloud_org_members: () => MEMBERS,
  cloud_access_list: () => seats,
  cloud_access_grant: (args) => {
    const m = MEMBERS.find((x) => x.github_login === args.login)!;
    seats = {
      ...seats,
      grants: [...seats.grants, { user_id: m.user_id, github_login: m.github_login, source: "manual" }],
      granted: seats.granted + 1,
    };
  },
  cloud_access_revoke: (args) => {
    seats = { ...seats, grants: seats.grants.filter((g) => g.user_id !== args.userId), granted: seats.granted - 1 };
  },
  cloud_env_vars_list: () => [],
  cloud_orgs: () => [{ slug: "northwind", name: "Northwind", role: member ? "member" : "owner" }],
};

const unknown: string[] = [];
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

function Harness() {
  const [query, setQuery] = useState("");
  return (
    <SettingsLayout
      title={pageLabel("computer")}
      groups={navigationGroups([], query)}
      selected="computer"
      onSelect={() => undefined}
      onBack={() => undefined}
      query={query}
      onQueryChange={setQuery}
    >
      <SettingsPageView
        page="computer"
        view={null}
        repoRoot="/Users/me/aura"
        currentRepo="/Users/me/aura"
        roots={["/Users/me/aura"]}
        query={query}
        foldAsked={scene === "advanced" ? "cloud" : null}
        reload={async () => undefined}
        onClose={() => undefined}
        go={() => undefined}
      />
    </SettingsLayout>
  );
}

ReactDOM.createRoot(document.getElementById("cloud-computer-harness")!).render(
  <StrictMode>
    <div style={{ height: "100vh", display: "flex" }}>
      <Harness />
    </div>
  </StrictMode>,
);

const until = async (pick: () => Element | undefined | null) => {
  for (let i = 0; i < 100; i++) {
    const el = pick();
    if (el) return el;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("never appeared");
};

async function stage() {
  await until(() => document.querySelector(".ui-cloud-repo-list"));
  await until(() => document.querySelector(".ui-machine-access-list [role=listitem]"));
  if (scene === "advanced") {
    const fold = await until(() => document.querySelector("[data-fold=cloud]"));
    fold.scrollIntoView({ block: "start" });
  }
  await new Promise((r) => setTimeout(r, 400));
  if (unknown.length) console.info("harness: unanswered commands", unknown.join(", "));
  document.body.dataset.ready = "yes";
}
void stage().catch((e) => {
  console.error("harness:", e);
  document.body.dataset.ready = "yes";
});
