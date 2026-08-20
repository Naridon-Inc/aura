// Picking which org you are acting as.
//
//   bun test
//
// An Aura account is not one team. Every signup already owns an org, joining a
// company's adds a second, and personal is simply an org of one — so "which org
// am I" is a question every account has, not an enterprise feature. The desktop
// answered it once, at pairing, and then never again: `cloud_org_slug` sat in
// `credentials.json`, got printed under your name in the account menu, and was
// sent to nothing. Changing it meant signing out, which re-resolves from the
// server and lands you wherever it lands.
//
// What these tests pin is the part that is easy to half-build:
//
// 1. THE CHOICE HAS TO REACH THE WIRE. A switcher that only repaints a subtitle
//    is a lie. The slug goes on every aura-cloud request as `X-Aura-Org`, from
//    one place, so no call site can forget.
//
// 2. THE LISTS HAVE TO FOLLOW. Jobs, machines and runners are what "projects
//    and places" means on screen. Each re-reads on the switch — and each is
//    filtered in the backend, so the renderer never holds another org's rows.
//
// 3. "WE COULDN'T ASK" IS NOT "YOU HAVE NO ORGS". The second is impossible.
//    Rendering a failed read as an empty list tells the user something false
//    about their own account, so the two states are distinct all the way down.

import { describe, expect, test } from "bun:test";

import { readSrc, stripComments } from "./support/code";

const SWITCHER = "components/account/OrgSwitcher.tsx";
const MENU = "components/account/AccountMenu.tsx";
const LIB = "lib/cloudOrgs.ts";

const { messageOf, orgLabel, orgSubtitle, ORG_CHANGED_EVENT } = await import(
  "../src/lib/cloudOrgs"
);
type CloudOrg = import("../src/lib/api").CloudOrg;

function org(over: Partial<CloudOrg> = {}): CloudOrg {
  return {
    id: "o1",
    slug: "naridon",
    name: "Naridon",
    repo_count: 3,
    current: false,
    ...over,
  };
}

describe("an org is named by something a person can read", () => {
  test("its name, when the server has one", () => {
    expect(orgLabel(org())).toBe("Naridon");
  });

  test("and its slug when it doesn't, rather than an empty row", () => {
    // A blank label is a row nobody can pick — and every account has at least
    // one org, so a row that can't be picked is a person locked out of their
    // own work.
    expect(orgLabel(org({ name: "" }))).toBe("naridon");
    expect(orgLabel(org({ name: "   " }))).toBe("naridon");
  });
});

describe("what switching to it would get you, in words", () => {
  test("counted, and pluralised", () => {
    expect(orgSubtitle(org({ repo_count: 3 }))).toBe("3 projects");
    expect(orgSubtitle(org({ repo_count: 1 }))).toBe("1 project");
  });

  test("and zero reads as an invitation, not as a fault", () => {
    // An org you were added to and hold nothing in yet is the common case for
    // a new hire. "0 projects" reads like something broke.
    expect(orgSubtitle(org({ repo_count: 0 }))).toBe("No projects yet");
  });
});

describe("an error always says something", () => {
  test("the backend's own sentence, when there is one", () => {
    expect(messageOf("not signed in to Aura cloud")).toBe(
      "not signed in to Aura cloud",
    );
    expect(messageOf(new Error("HTTP 502"))).toBe("HTTP 502");
  });

  test("and never a blank or an [object Object]", () => {
    // A blank error state is indistinguishable from a working one that found
    // nothing, which is the exact confusion this whole feature must avoid.
    for (const bad of [undefined, null, "", "   ", {}, new Error("")]) {
      expect(messageOf(bad)).toBe("Could not reach Aura Cloud.");
    }
  });
});

describe("the switch is announced once, and everything hears it", () => {
  test("there is one event name, exported rather than typed out", () => {
    expect(ORG_CHANGED_EVENT).toBe("aura:cloud-org-changed");
  });

  test("switching broadcasts it, and the auth event every surface already has", async () => {
    const src = stripComments(await readSrc(LIB));
    expect(src).toContain("api.cloudOrgSwitch(slug)");
    expect(src).toContain("new CustomEvent(ORG_CHANGED_EVENT");
    expect(src).toContain('new CustomEvent("aura:cloud-auth-changed")');
  });

  test("and the machine-name cache is dropped before the announcement", async () => {
    // Order matters: a surface that redraws on the event must resolve names
    // against the new org's book, not the one we just left.
    const src = stripComments(await readSrc(LIB));
    const forget = src.indexOf("forgetMachineNames()");
    const announce = src.indexOf("dispatchEvent");
    expect(forget).toBeGreaterThan(-1);
    expect(forget).toBeLessThan(announce);
  });
});

describe("the lists that are supposed to follow, follow", () => {
  const followers: [string, string][] = [
    ["the fleet page's machines", "components/workspaces/WorkspacesMachinesSection.tsx"],
    ["the sidebar rail's machines", "components/WorkspaceRoster.tsx"],
    ["the cloud jobs board", "lib/useCloudJobs.ts"],
  ];

  for (const [what, file] of followers) {
    test(`${what} re-reads on the switch`, async () => {
      const src = stripComments(await readSrc(file));
      expect(src).toContain("onOrgChanged(");
    });

    test(`${what} unsubscribes when it goes away`, async () => {
      // A listener left behind fires against a dead setState on every switch
      // for the rest of the session.
      const src = stripComments(await readSrc(file));
      expect(src).toMatch(/off\w*\(\)|return onOrgChanged\(/);
    });
  }
});

describe("the switcher costs one row, and asks for nothing until opened", () => {
  test("it is a submenu, not an inlined list", async () => {
    // The account menu is four rows; the org list is unbounded. Inlining it
    // would make a menu about signing out as long as your client list.
    const src = stripComments(await readSrc(SWITCHER));
    expect(src).toContain("DropdownMenuSub");
    expect(src).toContain("DropdownMenuSubTrigger");
  });

  test("nothing is fetched before the submenu opens", async () => {
    const src = stripComments(await readSrc(SWITCHER));
    expect(src).toContain("useCloudOrgs(open)");
  });

  test("it sits in the account menu, under the line that names the org", async () => {
    const src = stripComments(await readSrc(MENU));
    expect(src).toContain("<OrgSwitcher />");
    // Signed out there is no org to be in, so there is nothing to offer.
    expect(src).toContain("connected && (");
  });

  test("the org line prefers the name the server knows over the slug", async () => {
    const src = stripComments(await readSrc(MENU));
    expect(src).toContain("status?.org_name?.trim() || status?.org_slug?.trim()");
  });
});

describe("loading, empty and error are three different things", () => {
  test("the first read shows the app's one spinner", async () => {
    const src = stripComments(await readSrc(SWITCHER));
    expect(src).toContain("AsciiSpinner");
    // And only the FIRST read — a reload behind a list we already have stays
    // silent rather than flashing the rows away.
    expect(src).toContain("loading && !loaded");
  });

  test("an error offers the retry, in place", async () => {
    // A menu you have to close and reopen to try again looks broken twice.
    const src = stripComments(await readSrc(SWITCHER));
    expect(src).toContain("Try again");
    expect(src).toContain("onRetry");
  });

  test("an empty list is treated as a fault, because it cannot happen", async () => {
    const src = stripComments(await readSrc(SWITCHER));
    expect(src).toContain("loaded && orgs.length === 0");
    expect(src).toContain("No orgs came back.");
  });

  test("none of the three states is a card", async () => {
    // House rule: no bulky cards. All three are one quiet line in the panel
    // that is already open — no border, no shadow, no box that shoves the
    // menu around as it appears.
    const src = stripComments(await readSrc(SWITCHER));
    expect(src).not.toContain("rounded-lg border");
    expect(src).not.toContain("shadow-");
    expect(src).not.toContain("bg-bg-1 p-3");
  });

  test("the row you clicked is the row that shows it is working", async () => {
    const src = stripComments(await readSrc(SWITCHER));
    expect(src).toContain("pending === org.slug");
    // And the menu is held open across the write, so the tick lands where you
    // can see it rather than under a panel that already closed.
    expect(src).toContain("e.preventDefault()");
  });
});

describe("the choice reaches the wire from one place", () => {
  test("the header has one name and one definition", async () => {
    const src = stripComments(await readSrc("../src-tauri/src/cloud_org.rs"));
    expect(src).toContain('pub const ORG_HEADER: &str = "X-Aura-Org"');
    expect(src).toContain("impl OrgScoped for reqwest::RequestBuilder");
  });

  test("every aura-cloud call carries it", async () => {
    // Spot-checked at the surfaces this task's acceptance criterion names —
    // the ones that answer "which projects" and "which places".
    for (const file of [
      "../src-tauri/src/cmd_cloud_jobs.rs",
      "../src-tauri/src/cmd_cloud_runners.rs",
      "../src-tauri/src/cloud_session_sync.rs",
    ]) {
      expect(stripComments(await readSrc(file))).toContain(".org_scoped()");
    }
  });

  test("except on the one read that has to cross orgs", async () => {
    // `/api/v2/repos` is how the app learns which orgs exist. Send the header
    // there and, the day the server honours it, the switcher answers "your
    // orgs are: the one you cannot leave". Both readers narrow locally instead.
    for (const file of [
      "../src-tauri/src/cmd_cloud_orgs.rs",
      "../src-tauri/src/cmd_cloud_jobs.rs",
    ]) {
      const src = stripComments(await readSrc(file));
      const scoped = src.slice(
        src.indexOf("api/v2/repos"),
        src.indexOf("api/v2/repos") + 300,
      );
      expect(scoped).not.toContain(".org_scoped()");
    }
  });

  test("and never twice on the same request", async () => {
    // reqwest appends rather than replaces, so a doubled call sends the header
    // twice and a strict server rejects the request outright.
    for (const file of [
      "../src-tauri/src/cmd_cloud_jobs.rs",
      "../src-tauri/src/cmd_cloud_runners.rs",
      "../src-tauri/src/cloud_session_sync.rs",
      "../src-tauri/src/cmd_team.rs",
      "../src-tauri/src/cmd_session_live/http.rs",
    ]) {
      const src = stripComments(await readSrc(file));
      expect(src).not.toMatch(/\.org_scoped\(\)\s*\n\s*\.org_scoped\(\)/);
    }
  });

  test("the machine book remembers which org a box was connected under", async () => {
    const src = stripComments(await readSrc("../src-tauri/src/cmd_machines.rs"));
    expect(src).toContain("pub org_slug: Option<String>");
    // And a box that never said stays visible under every org, so upgrading
    // does not make someone's machines disappear.
    expect(src).toContain("fn visible_in(");
  });
});
