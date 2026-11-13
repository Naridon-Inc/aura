import { describe, expect, test } from "bun:test";

import type { MentionRow, PresenceEntry } from "../../lib/cloudTeamApi";
import type { CloudMember } from "../ui/cloud-workspace";
import {
  activeIdsOf,
  addressedTo,
  agentOf,
  authorOf,
  byPresence,
  canSeeWorkspace,
  freshMentions,
  grantsOf,
  hasOtherAuthors,
  newlyGranted,
  notOnProjectUser,
  mentionNotice,
  personCardOf,
  serverSentence,
  shareValueOf,
  toNames,
  typingNamesOf,
  withMention,
  viewersOf,
} from "./cloudPeople";

function member(id: string, name: string, role: CloudMember["role"] = "Member"): CloudMember {
  return { id, name, initials: name.slice(0, 1), color: "#000", role };
}

const maya = member("u-maya", "Maya");
const sam = member("u-sam", "Sam");
const lee = member("u-lee", "Lee", "Admin");
const me = member("u-me", "Ash");
const members = [maya, sam, lee, me];

function here(user_id: string, over: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    user_id,
    state: "active",
    typing: false,
    viewing_workspace_id: null,
    last_seen_at: "2026-11-10T10:00:00Z",
    last_active_at: "2026-11-10T10:00:00Z",
    ...over,
  };
}

describe("authorOf", () => {
  test("a turn with no author is put on no one", () => {
    expect(authorOf({}, members, me.id)).toBeNull();
    expect(authorOf({ author_id: "  " }, members, me.id)).toBeNull();
  });

  test("your own turn reads as You", () => {
    const a = authorOf({ author_id: me.id }, members, me.id)!;
    expect(a.own).toBe(true);
    expect(a.member.name).toBe("You");
  });

  test("a teammate's turn carries the teammate", () => {
    const a = authorOf({ author_id: maya.id, author_name: "ignored" }, members, me.id)!;
    expect(a.own).toBe(false);
    expect(a.member).toBe(maya);
  });

  test("someone who left keeps the name the server recorded, or says they left", () => {
    expect(authorOf({ author_id: "u-gone", author_name: "Rae" }, members, me.id)!.member.name).toBe("Rae");
    expect(authorOf({ author_id: "u-gone" }, members, me.id)!.member.name).toBe(
      "Someone no longer in this team",
    );
  });
});

test("a transcript is shared only once someone else has written in it", () => {
  const mine = [{ role: "user", author_id: me.id }, { role: "assistant", author_id: null }];
  expect(hasOtherAuthors(mine, me.id)).toBe(false);
  expect(hasOtherAuthors([...mine, { role: "user", author_id: sam.id }], me.id)).toBe(true);
  // An agent's reply never counts as another person.
  expect(hasOtherAuthors([{ role: "assistant", author_id: sam.id }], me.id)).toBe(false);
});

describe("presence", () => {
  const presence = [
    here(sam.id, { state: "idle" }),
    here(maya.id, { viewing_workspace_id: "ws1", typing: true }),
    here(lee.id, { viewing_workspace_id: "ws1" }),
    here(me.id, { viewing_workspace_id: "ws1", typing: true }),
  ];

  test("only people using the app now are active", () => {
    expect([...activeIdsOf(presence)].sort()).toEqual([lee.id, maya.id, me.id].sort());
  });

  test("Home lists active, then idle, then everyone else, keeping the server's order inside each", () => {
    const later = member("u-zed", "Zed");
    expect(byPresence([later, sam, maya, lee], presence).map((m) => m.name)).toEqual([
      "Maya",
      "Lee",
      "Sam",
      "Zed",
    ]);
  });

  test("the header shows who has it open, then its opener, then you", () => {
    const shown = viewersOf(presence, "ws1", members, me.id, sam.id);
    expect(shown.map((m) => m.name)).toEqual(["Maya", "Lee", "Sam", "Ash"]);
    // The opener isn't here, so isn't drawn as active.
    expect(shown[2]!.active).toBeUndefined();
    expect(shown[0]!.active).toBe(true);
  });

  test("the opener is not listed twice when they are here", () => {
    expect(viewersOf(presence, "ws1", members, me.id, maya.id).map((m) => m.name)).toEqual([
      "Maya",
      "Lee",
      "Ash",
    ]);
  });

  test("typing is per workspace and never includes you", () => {
    expect(typingNamesOf(presence, "ws1", members, me.id)).toEqual(["Maya"]);
    expect(typingNamesOf(presence, "ws2", members, me.id)).toEqual([]);
  });

});

describe("access", () => {
  test("round-trips between the server's words and the popover's", () => {
    const dto = {
      general: "restricted" as const,
      grants: [
        { user_id: maya.id, level: "read" as const },
        { user_id: sam.id, level: "write" as const },
      ],
    };
    const value = shareValueOf(dto);
    expect(value).toEqual({
      general: "restricted",
      grants: [
        { memberId: maya.id, level: "Read" },
        { memberId: sam.id, level: "Write" },
      ],
    });
    expect(grantsOf(value)).toEqual(dto.grants);
  });

  test("a mention reaches only someone who can open a private workspace", () => {
    const open = { general: "organization" as const, grants: [], owner_id: me.id };
    const closed = { general: "restricted" as const, grants: [{ user_id: maya.id, level: "read" as const }], owner_id: sam.id };
    expect(canSeeWorkspace(maya, null)).toBe(true);
    expect(canSeeWorkspace(maya, open)).toBe(true);
    expect(canSeeWorkspace(maya, closed)).toBe(true);
    expect(canSeeWorkspace(sam, closed)).toBe(true); // opened it
    expect(canSeeWorkspace(lee, closed)).toBe(true); // runs the org
    expect(canSeeWorkspace(me, closed)).toBe(false);
  });
});

test("a mention's notice names who and where", () => {
  const m: MentionRow = {
    id: "m1",
    workspace_id: "ws1",
    workspace_title: "Fix the login redirect\nsecond line",
    by_user_id: maya.id,
    excerpt: "@ash can you look?",
    created_at: "2026-11-10T10:00:00Z",
    read_at: null,
  };
  expect(mentionNotice(m, members)).toEqual({
    title: "Maya mentioned you in Fix the login redirect",
    body: "@ash can you look?",
  });
  expect(mentionNotice({ ...m, by_user_id: null, workspace_title: null }, members).title).toBe(
    "A teammate mentioned you",
  );
});

test("a comment's notice says whether it was a mention, a reply or a comment on yours", () => {
  const m: MentionRow = {
    id: "m2",
    workspace_id: "ws1",
    workspace_title: "HI",
    by_user_id: maya.id,
    excerpt: "Looks good to me",
    created_at: "2026-11-11T10:00:00Z",
    read_at: null,
    comment_id: "c1",
    anchor_message_id: "t1",
  };
  expect(mentionNotice({ ...m, kind: "mention" }, members).title).toBe("Maya mentioned you in HI");
  expect(mentionNotice({ ...m, kind: "reply" }, members).title).toBe("Maya replied in HI");
  expect(mentionNotice({ ...m, kind: "comment" }, members).title).toBe(
    "Maya commented on your message in HI",
  );
  // A kind this build doesn't know yet still reads as a mention.
  expect(mentionNotice({ ...m, kind: "nudge" }, members).title).toBe("Maya mentioned you in HI");
  expect(mentionNotice({ ...m, kind: "reply" }, members).body).toBe("Looks good to me");
});

test("the server's own sentence is read out of a failed call", () => {
  expect(
    serverSentence(
      'HTTP 422 Unprocessable Entity: {"error":"That teammate can\'t open this workspace\'s project yet.","user_id":"x"}',
    ),
  ).toBe("That teammate can't open this workspace's project yet.");
  expect(
    serverSentence('HTTP 403 Forbidden: {"error":"upgrade_required","message":"Upgrade to Team to share."}'),
  ).toBe("Upgrade to Team to share.");
  expect(serverSentence('HTTP 404 Not Found: {"error":"not_found"}')).toBeNull();
  expect(serverSentence("network down")).toBeNull();
});

test("a mention interrupts once, and never for the workspace you are reading", () => {
  const at = (id: string, ws: string): MentionRow => ({
    id,
    workspace_id: ws,
    workspace_title: null,
    by_user_id: maya.id,
    excerpt: "",
    created_at: "2026-11-10T10:00:00Z",
    read_at: null,
  });
  const rows = [at("m1", "ws1"), at("m2", "ws2"), at("m3", "ws2")];
  expect(freshMentions(rows, new Set(), null).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  expect(freshMentions(rows, new Set(["m2"]), null).map((m) => m.id)).toEqual(["m1", "m3"]);
  expect(freshMentions(rows, new Set(), "ws2").map((m) => m.id)).toEqual(["m1"]);
});

test("a share refused for someone off the project names them, and nothing else does", () => {
  const refused =
    'HTTP 422 Unprocessable Entity: {"error":"That teammate can\'t open this workspace\'s project yet. Add them to the project first, then share the workspace.","user_id":"u-2"}';
  expect(notOnProjectUser(refused)).toBe("u-2");
  expect(notOnProjectUser(new Error(refused))).toBe("u-2");
  // Another refusal, even one carrying a user id, offers nothing.
  expect(notOnProjectUser('HTTP 422: {"error":"That teammate is not in this organization.","user_id":"u-2"}')).toBeNull();
  expect(notOnProjectUser('HTTP 403 Forbidden: {"error":"owner/admin only"}')).toBeNull();
  expect(notOnProjectUser("POST https://x: connection refused")).toBeNull();
  expect(notOnProjectUser('HTTP 422: {"error":"That teammate can\'t open this workspace\'s project yet."}')).toBeNull();
});

test("only the people a save adds count as new", () => {
  const held = [{ user_id: "a", level: "read" as const }];
  const next = [
    { user_id: "a", level: "write" as const },
    { user_id: "b", level: "read" as const },
  ];
  expect(newlyGranted(held, next)).toEqual(["b"]);
  expect(newlyGranted(next, held)).toEqual([]);
});

describe("the card on a face in a workspace's header", () => {
  const now = Date.parse("2026-11-10T10:10:00Z");
  const open = { general: "organization" as const, grants: [], owner_id: maya.id, your_access: "write" as const };
  const card = (m: CloudMember, presence: PresenceEntry[], access = open, login?: string) =>
    personCardOf(m, presence, "ws-1", access, me.id, login, now);

  test("someone here says so, and typing wins over here", () => {
    expect(card(sam, [here(sam.id, { viewing_workspace_id: "ws-1" })]).status).toBe("Here now");
    expect(card(sam, [here(sam.id, { viewing_workspace_id: "ws-1", typing: true })]).status).toBe("Typing…");
    expect(card(sam, [here(sam.id, { viewing_workspace_id: "ws-1", state: "idle" })]).status).toBe("Here, but away");
    expect(card(sam, [here(sam.id, { viewing_workspace_id: "ws-1" })]).here).toBe(true);
  });

  test("someone elsewhere says when they were last seen", () => {
    const c = card(sam, [here(sam.id, { state: "idle", last_active_at: "2026-11-10T10:00:00Z" })]);
    expect(c.status).toBe("Last seen 10m ago");
    expect(c.here).toBe(false);
    expect(card(sam, [here(sam.id, { viewing_workspace_id: "ws-2" })]).status).toBe(
      "In Aura, not in this workspace",
    );
    expect(card(sam, []).status).toBe("Not in Aura lately");
  });

  test("access reads as owner, a grant, the project, or none", () => {
    expect(card(maya, []).access).toBe("Owner");
    expect(card(sam, []).access).toBe("Can write");
    const restricted = { ...open, general: "restricted" as const, grants: [{ user_id: sam.id, level: "read" as const }] };
    expect(card(sam, [], restricted).access).toBe("Can read");
    expect(card(lee, [], restricted).access).toBe("Can write");
    const outsider = member("u-out", "Rae");
    expect(card(outsider, [], restricted).access).toBe("Can’t open it");
    expect(personCardOf(sam, [], "ws-1", null, me.id, "sam", now).access).toBeNull();
  });

  test("a mention is offered only when it would reach them", () => {
    expect(card(sam, [], open, "sam").mention).toEqual({ login: "sam" });
    expect(card(sam, [], open).mention).toHaveProperty("reason");
    const restricted = { ...open, general: "restricted" as const, grants: [] };
    expect((card(sam, [], restricted, "sam").mention as { reason: string }).reason).toContain("can’t open");
  });

  test("your own face is you: here, your access, nobody to mention", () => {
    const c = personCardOf(me, [], "ws-1", { ...open, your_access: "read" }, me.id, "ash", now);
    expect(c).toEqual({ status: "Here now", here: true, access: "Can read", mention: null });
  });
});

describe("who a message is addressed to", () => {
  const logins = { [maya.id]: "maya-k", [sam.id]: "SamR", [me.id]: "ash" };

  test("a message that opens with teammates' logins is for them", () => {
    expect(addressedTo("@maya-k can you check the copy?", logins)).toEqual([maya.id]);
    expect(addressedTo("  @samr, @maya-k: lunch?", logins)).toEqual([sam.id, maya.id]);
    expect(addressedTo("@maya-k", logins)).toEqual([maya.id]);
  });

  test("anything else is for the agent", () => {
    expect(addressedTo("Fix @maya-k's failing test", logins)).toBeNull();
    expect(addressedTo("@maya-k's test is failing", logins)).toBeNull();
    expect(addressedTo("@nobody hello", logins)).toBeNull();
    expect(addressedTo("@src/app.ts is broken", logins)).toBeNull();
    expect(addressedTo("please look", logins)).toBeNull();
  });

  test("the agent's own name is never a person", () => {
    expect(addressedTo("@claude fix it", { ...logins, "u-c": "claude" })).toBeNull();
  });

  test("a mode directive in front does not hide who it is for", () => {
    const auto = "[AUTO MODE. Full autopilot. Keep going until the task is genuinely complete.]\n\n";
    expect(addressedTo(`${auto}@maya-k can you check the copy?`, logins)).toEqual([maya.id]);
    expect(addressedTo(`${auto}please look`, logins)).toBeNull();
  });

  test("the label names them, and you as you", () => {
    expect(toNames([maya.id], members, me.id)).toBe("to Maya");
    expect(toNames([maya.id, sam.id], members, me.id)).toBe("to Maya and Sam");
    expect(toNames([maya.id, sam.id, me.id], members, me.id)).toBe("to Maya, Sam and you");
  });
});

test("Mention puts the @login first, once", () => {
  expect(withMention("", "@maya ")).toBe("@maya ");
  expect(withMention("can you look?", "@maya ")).toBe("@maya can you look?");
  expect(withMention("@maya can you look?", "@maya ")).toBe("@maya can you look?");
  expect(withMention("@sam hi", "@maya ")).toBe("@maya @sam hi");
  // A longer login that only starts the same is someone else.
  expect(withMention("@mayabelle hi", "@maya ")).toBe("@maya @mayabelle hi");
});

test("an agent turn is labelled with the agent that runs the workspace", () => {
  expect(agentOf({ place: { engine: "codex" }, model: "claude-sonnet" })).toEqual({ name: "Codex", provider: "codex" });
  expect(agentOf({ place: null, agent: null, model: "claude-opus-4-6" }).name).toBe("Claude");
  expect(agentOf({ agent: "gpt-5-codex" }).name).toBe("Codex");
  expect(agentOf({}).name).toBe("Agent");
  expect(agentOf({ model: "mystery-1" })).toEqual({ name: "Agent", provider: "mystery-1" });
});
