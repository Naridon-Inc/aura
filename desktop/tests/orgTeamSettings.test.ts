// Settings → Organization → Team, driven in a real window.
//
//   bun test
//
// Two things were wrong on one screen. The sidebar read:
//
//     TEAM & ADVANCED
//     👥 Team
//
// — a heading naming two things over one item, the second of which was not
// there. The same static group, filtered by the Personal tab, produced the
// mirror of it: "Team & advanced" over Experimental, Usage data and Help,
// with no team in sight. A group label is the name of what is under it, so
// it cannot be a group the scope tabs cut in half.
//
// And under it, the pane itself:
//
//     2 members · 1 admin
//     aura-user   Not signed in yet — seen on a device
//     Ashiq  [admin]   ashiqwayanad007@example.com
//
// Neither row badged `you` — this machine's git has no user.email, so Aura
// could not match the reader to any row. The Channels tab then said, in the
// same breath, that visibility, topics and deletion "needs team-admin (or
// channel-admin) rights" — telling a reader who might well be the admin that
// they lack a permission, when the truth was that we never found their row.
// `TeamIdentity.in_team` is precisely that distinction, and both panes were
// collapsing it into `admin ?? false`.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";
import {
  FOLDED_PAGES,
  PAGE_GROUPS,
  advancedOpens,
  foldOfLink,
  navigationGroups,
  resolvePageLink,
  visiblePages,
} from "../src/components/settings/nav";

const NOTE = "components/settings/team/WhoAmINote.tsx";
const MEMBERS = "components/settings/team/MembersPane.tsx";

describe("settings sidebar — a group label names what is under it", () => {
  const groupOf = (id: string) =>
    PAGE_GROUPS.find((group) => group.items.some((item) => item.id === id))?.label;
  const foldedInto = (id: string) => FOLDED_PAGES.find((fold) => fold.id === id)?.into;

  test("one list, in the library's groups, with the repositories after the organization pages", () => {
    const labels = navigationGroups(["/work/aura"], "").map((group) => group.label);
    expect(labels).not.toContain("Team & advanced");
    expect(labels).toEqual(["Personal", "Agents & environment", "Organization", "Services", "Repositories", "More"]);
  });

  test("Members sits with the organization's pages, and nothing general rides along", () => {
    expect(groupOf("team")).toBe("Organization");
    expect(groupOf("organization")).toBe("Organization");
    expect(groupOf("billing")).toBe("Organization");
    expect(groupOf("api")).toBe("Services");
    expect(groupOf("experimental")).not.toBe("Organization");
    expect(foldedInto("telemetry")).toBe("account");
    expect(foldedInto("help")).toBe("advanced");
  });

  test("MCP and the cloud computer sit with the agents", () => {
    expect(groupOf("mcp")).toBe("Agents & environment");
    expect(groupOf("computer")).toBe("Agents & environment");
    expect(foldedInto("cloud")).toBe("computer");
    expect(foldedInto("mobile")).toBe("account");
  });

  test("and the rest of them land under More", () => {
    expect(groupOf("experimental")).toBe("More");
    expect(groupOf("advanced")).toBe("More");
    expect(groupOf("terminal")).toBe("More");
  });

  test("a repository opens to Scripts, Actions and Misc", () => {
    const repos = navigationGroups(["/work/aura"], "").find((group) => group.label === "Repositories");
    expect(repos?.items[0]?.children?.map((child) => child.label)).toEqual(["Scripts", "Actions", "Misc"]);
    expect(visiblePages(navigationGroups(["/work/aura"], ""))).toContain("repo-misc:/work/aura");
  });

  test("no heading only repeats its single row", () => {
    // Search thins a group down to one item; its heading must still say
    // something the row doesn't. Repositories sit under their own heading.
    for (const query of ["", "team", "help", "terminal", "agents"]) {
      for (const group of navigationGroups(["/work/aura"], query)) {
        const only = group.items.length === 1 ? group.items[0]!.label : null;
        expect(only).not.toBe(group.label);
      }
    }
  });
});

describe("settings links — every old page name still lands", () => {
  const LINKS: Record<string, string> = {
    agents: "agents",
    capture: "repo-misc:/work/aura",
    policy: "repo-misc:/work/aura",
    aurawatch: "repo-misc:/work/aura",
    copies: "repo:/work/aura",
    identity: "account",
    profiles: "account",
    mcp: "mcp",
    terminal: "terminal",
    cloud: "computer",
    computer: "computer",
    team: "team",
    mobile: "account",
    models: "models",
    "local-models": "models",
    hud: "general",
    themes: "appearance",
    help: "advanced",
    behavior: "general",
    vault: "environment",
  };
  test("each link resolves to the page that holds it now", () => {
    for (const [link, page] of Object.entries(LINKS)) {
      expect(resolvePageLink(link, "/work/aura")).toBe(page);
    }
  });

  test("a link to a folded part opens that page's Advanced", () => {
    for (const link of ["capture", "identity", "mobile", "cloud", "hud", "themes", "local-models", "plugins"]) {
      const fold = foldOfLink(link);
      expect(fold).not.toBeNull();
      expect(advancedOpens(resolvePageLink(link, "/work/aura")!, fold, "")).toBe(true);
    }
    expect(advancedOpens("general", null, "")).toBe(false);
    expect(advancedOpens("general", null, "vim")).toBe(true);
  });
});

describe("team panes — 'we don't know who you are' is its own sentence", () => {
  test("the note gates on in_team, not on admin", async () => {
    const src = await readSrc(NOTE);
    const note = src.slice(src.indexOf("function WhoAmINote("));
    expect(note.slice(0, 400)).toContain("if (identity?.in_team) return null");
  });

  test("it distinguishes no-git-identity from not-on-this-roster", async () => {
    const src = await readSrc(NOTE);
    const note = src.slice(src.indexOf("function WhoAmINote("));
    // Nothing resolved at all.
    expect(note).toContain("Aura couldn’t work out who you are");
    // Resolved to an address nobody on the roster commits under.
    expect(note).toContain("Nobody here signs work as");
    // No address to resolve.
    expect(note).toContain("hasn’t set the name and email it signs work with");
  });

  test("and it hands the reader the pane that fixes it", async () => {
    const src = await readSrc(NOTE);
    const note = src.slice(src.indexOf("function WhoAmINote("));
    expect(note).toContain('new CustomEvent("aura:open-settings"');
    expect(note).toContain('detail: { pane: "identity" }');
  });

  test("the roster pane says it", async () => {
    const src = await readSrc(MEMBERS);
    expect(src).toContain('from "./WhoAmINote"');
    // One mount, on the roster. The second used to sit above the channel
    // member list, which left with the messaging surface.
    expect(src.split("<WhoAmINote identity={identity} />").length - 1).toBe(1);
  });
});
