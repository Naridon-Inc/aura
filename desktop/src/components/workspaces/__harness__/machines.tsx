// The Machines page with its "Who can use" seats and its every-account view,
// rendered on its own.
//
// Dev-server only — reached at /machines-harness.html?scene=<name>, never
// bundled. The page is the real one; only the desktop's commands are stood in
// for, answering with a fixed team. No seat is granted and nothing is saved:
// a switch flipped here changes this page's memory and nothing else.
//
// Scenes: access-admin · access-member · access-full · access-personal · all
// Add `&theme=light` for the light palette.

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import type {
  AllPlaces,
  CloudAccess,
  CloudOrgMember,
  Machine,
  PlaceGroup,
  PlaceOrgHalf,
  PlaceRoster,
  PlaceRow,
} from "../../../lib/api";
import { MachinesSurface } from "../MachinesSurface";
import "../../../styles.css";
// The app loads the cloud surfaces' shared rows and segments globally.
import "../../ui/cloud-patterns.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "access-admin";
if (params.get("theme") === "light") document.documentElement.classList.add("light");

const now = Math.floor(Date.now() / 1000);
const ago = (minutes: number) => now - minutes * 60;

const MEMBERS: CloudOrgMember[] = [
  { user_id: "u-sam", github_login: "sam-k", display_name: "Sam Ortega", role: "owner" },
  { user_id: "u-lea", github_login: "lea-m", display_name: "Léa Martin", role: "admin" },
  { user_id: "u-priya", github_login: "priya-n", display_name: "Priya Nair", role: "member" },
  { user_id: "u-diego", github_login: "diego-r", display_name: "Diego Ruiz", role: "member" },
  { user_id: "u-ana", github_login: "ana-p", display_name: "Ana Pereira", role: "member" },
];

const me = scene === "access-member" ? "priya-n" : "sam-k";
const myRole = scene === "access-member" ? "member" : "owner";

const half = (slug: string | null, name: string | null, role: string | null = myRole): PlaceOrgHalf => ({
  status: "ok",
  detail: "",
  slug,
  name,
  my_role: role,
});

const book = (name: string, repo: string, org: string | null, used: number): Machine =>
  ({
    id: `m-${name}`,
    name,
    host: "10.0.0.4",
    user: "ubuntu",
    key_path: "managed:x",
    box_kind: "mine",
    repo_path: repo,
    org_slug: org,
    added_at: ago(9000),
    last_used_at: used,
  }) as unknown as Machine;

const place = (
  name: string,
  owner: { kind: string; label: string; org_slug: string | null },
  opts: { machine?: Machine | null; online?: boolean | null; by?: string; used?: number } = {},
): PlaceRow => ({
  id: opts.machine ? opts.machine.id : `runner:${name}`,
  name,
  source: opts.machine ? (owner.kind === "org" ? "both" : "mine") : "org",
  owner,
  added_by: { label: opts.by ?? "you", is_you: !opts.by },
  may: {
    open: !!opts.machine,
    edit: !!opts.machine,
    forget: !!opts.machine,
    connect: !opts.machine,
    summary: "",
  },
  machine: opts.machine ?? null,
  runner_id: opts.machine && owner.kind === "you" ? null : `r-${name}`,
  online: opts.online ?? (owner.kind === "org" ? true : null),
  agents: ["claude"],
  added_at: ago(9000),
  last_used_at: opts.used ?? 0,
});

const team = { kind: "org", label: "Northwind", org_slug: "northwind" };
const TEAM_PLACES: PlaceRow[] = [
  place("build-box", team, { machine: book("build-box", "/srv/storefront", "northwind", ago(12)), by: "@lea-m" }),
  place("gpu-trainer", team, { machine: book("gpu-trainer", "/srv/models", "northwind", ago(180)) }),
  place("staging", team, { by: "@lea-m" }),
];

const roster: PlaceRoster = { places: TEAM_PLACES, org: half("northwind", "Northwind") };

const group = (
  kind: PlaceGroup["kind"],
  org: PlaceOrgHalf,
  places: PlaceRow[],
  extra: Partial<PlaceGroup> = {},
): PlaceGroup => ({ kind, org, places, current: false, members: null, ...extra });

const ALL: AllPlaces = {
  status: "ok",
  detail: "",
  groups: [
    group("team", half("northwind", "Northwind"), TEAM_PLACES, { current: true, members: 5 }),
    group(
      "personal",
      half("sam-k", "sam-k", "owner"),
      [
        place("sam-dev", { kind: "org", label: "sam-k", org_slug: "sam-k" }, {
          machine: book("sam-dev", "/home/ubuntu/side-project", "sam-k", ago(45)),
        }),
      ],
      { members: 1 },
    ),
    group(
      "team",
      half("acme-client", "Acme (client)", "member"),
      [
        place("acme-ci", { kind: "org", label: "Acme (client)", org_slug: "acme-client" }, { by: "@jo-acme" }),
      ],
      { members: 12 },
    ),
    group("laptop", { status: "ok", detail: "", slug: null, name: null, my_role: null }, [
      place("raspberry", { kind: "you", label: "You", org_slug: null }, {
        machine: book("raspberry", "/home/pi/home-lab", null, ago(60 * 26)),
      }),
    ]),
  ],
};

// Seats, as the server would answer — and as a flipped switch changes them.
let seats: CloudAccess = {
  org_slug: "northwind",
  grants:
    scene === "access-full"
      ? [
          { user_id: "u-priya", github_login: "priya-n", source: "manual" },
          { user_id: "u-diego", github_login: "diego-r", source: "manual" },
        ]
      : [{ user_id: "u-priya", github_login: "priya-n", source: "manual" }],
  granted: scene === "access-full" ? 2 : 1,
  seat_count: scene === "access-full" ? 2 : 5,
  plan: "team",
};

const personal = scene === "access-personal";
const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
  places_list: () =>
    personal
      ? { places: ALL.groups[1].places, org: half("sam-k", "sam-k", "owner") }
      : roster,
  places_list_all: () => ALL,
  machines_list: () => [],
  cloud_org_members: () => (personal ? [MEMBERS[0]] : MEMBERS),
  cloud_auth_status: () => ({ connected: true, user: me, org_slug: "northwind", cloud_url: "" }),
  cloud_access_list: () => seats,
  cloud_access_grant: (args) => {
    const m = MEMBERS.find((x) => x.github_login === args.login)!;
    seats = { ...seats, grants: [...seats.grants, { user_id: m.user_id, github_login: m.github_login, source: "manual" }], granted: seats.granted + 1 };
  },
  cloud_access_revoke: (args) => {
    seats = { ...seats, grants: seats.grants.filter((g) => g.user_id !== args.userId), granted: seats.granted - 1 };
  },
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

ReactDOM.createRoot(document.getElementById("machines-harness")!).render(
  <StrictMode>
    <div style={{ height: "100vh", display: "flex" }}>
      <MachinesSurface onClose={() => undefined} />
    </div>
  </StrictMode>,
);

const byText = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("button,[role=menuitemcheckbox]")].find((b) =>
    b.textContent?.trim().startsWith(text),
  );
const until = async (pick: () => HTMLElement | undefined | null) => {
  for (let i = 0; i < 100; i++) {
    const el = pick();
    if (el) return el;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("never appeared");
};

async function stage() {
  if (scene.startsWith("access")) {
    (await until(() => byText("Who can use"))).click();
    await until(() => document.querySelector(".ui-machine-access-list [role=listitem]") as HTMLElement | null);
  } else if (scene === "all") {
    const trigger = await until(() => document.querySelector<HTMLElement>("[aria-label='Whose machines']"));
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    (await until(() => byText("All my machines") as HTMLElement | undefined)).click();
    await until(() => document.querySelector(".ui-machines-group") as HTMLElement | null);
  }
  await new Promise((r) => setTimeout(r, 300));
  if (unknown.length) console.info("harness: unanswered commands", unknown.join(", "));
  document.body.dataset.ready = "yes";
}
void stage().catch((e) => {
  console.error("harness:", e);
  document.body.dataset.ready = "yes";
});
