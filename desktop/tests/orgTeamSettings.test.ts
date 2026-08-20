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
//     Ashiq  [admin]   ashiqwayanad007@gmail.com
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

const DIALOG = "components/dialogs/SettingsDialog.tsx";
const TEAM = "components/settings/TeamTab.tsx";

describe("settings sidebar — a group label names what is under it", () => {
  test("Team and the about-Aura panes are no longer one group", async () => {
    const src = await readSrc(DIALOG);
    expect(src).not.toContain('label: "Team & advanced"');
    expect(src).toContain('label: "Team"');
    expect(src).toContain('label: "About Aura"');
  });

  test("the Team group holds the one org-scoped pane and nothing else", async () => {
    const src = await readSrc(DIALOG);
    const start = src.indexOf('label: "Team",');
    const group = src.slice(start, src.indexOf('label: "About Aura"'));
    expect(group).toContain('id: "team"');
    // The three that used to ride along under a heading that named neither.
    expect(group).not.toContain('id: "experimental"');
    expect(group).not.toContain('id: "telemetry"');
    expect(group).not.toContain('id: "help"');
  });

  test("and they land under About Aura instead", async () => {
    const src = await readSrc(DIALOG);
    const group = src.slice(src.indexOf('label: "About Aura"'));
    const body = group.slice(0, 1400);
    expect(body).toContain('id: "experimental"');
    expect(body).toContain('id: "telemetry"');
    expect(body).toContain('id: "help"');
  });

  test("a heading that only repeats its single row isn't drawn", async () => {
    const src = await readSrc(DIALOG);
    // Decided per render, not per group: scope and search both thin a group
    // down to one item, and Organization thins this one to "Team" over Team.
    expect(src).toContain(
      "!(group.items.length === 1 && group.items[0]!.label === group.label)",
    );
  });
});

describe("team panes — 'we don't know who you are' is its own sentence", () => {
  test("the note gates on in_team, not on admin", async () => {
    const src = await readSrc(TEAM);
    const note = src.slice(src.indexOf("function WhoAmINote("));
    expect(note.slice(0, 400)).toContain("if (identity?.in_team) return null");
  });

  test("it distinguishes no-git-identity from not-on-this-roster", async () => {
    const src = await readSrc(TEAM);
    const note = src.slice(
      src.indexOf("function WhoAmINote("),
      src.indexOf("// Team roles admin panel"),
    );
    // Nothing resolved at all.
    expect(note).toContain("Aura couldn’t work out who you are");
    // Resolved to an address nobody on the roster commits under.
    expect(note).toContain("Nobody here signs work as");
    // No address to resolve.
    expect(note).toContain("hasn’t set the name and email it signs work with");
  });

  test("and it hands the reader the pane that fixes it", async () => {
    const src = await readSrc(TEAM);
    const note = src.slice(
      src.indexOf("function WhoAmINote("),
      src.indexOf("// Team roles admin panel"),
    );
    expect(note).toContain('new CustomEvent("aura:open-settings"');
    expect(note).toContain('detail: { pane: "identity" }');
  });

  test("both roster panes say it", async () => {
    const src = await readSrc(TEAM);
    expect(src.split("<WhoAmINote identity={identity} />").length - 1).toBe(2);
  });
});

describe("channels — a permissions note only for a reader we found", () => {
  test("the team-admin sentence waits until identity resolves", async () => {
    const src = await readSrc(TEAM);
    // Unmatched, this reads as "you are not an admin" — a different claim
    // from "we could not tell", and the one that sends people looking for
    // an admin who may be themselves.
    expect(src).toContain("{!iAmAdmin && identity?.in_team && (");
  });
});
