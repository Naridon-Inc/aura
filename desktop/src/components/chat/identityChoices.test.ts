import { describe, expect, test } from "bun:test";

import {
  buildIdentityChoices,
  identityBannerKind,
  memberForAccount,
  switchableIdentityChoices,
} from "./identityChoices";
import type {
  ChatDoctorReport,
  CloudAuthStatus,
  TeamManifest,
  TeamMember,
} from "../../lib/api";

// A stranger installed Aura on a fresh machine, cloned a public project and
// was not signed in to anything. On their very first message the app asked
// "Send as which identity?" and offered exactly one answer: a real member of
// the repo owner's team — name, handle and email. They had never met that
// person.
//
// The roster that produced it (`.aura/team/team.json`) is rebuilt from
// `git log` and committed into the repo, so it ships to everyone who clones.
// The picker was enumerating every member marked `claimed` as a candidate
// "you". Roster membership is a fact about other people; the tests below pin
// that it can never again be read as a fact about the person at the keyboard.

function report(over: Partial<ChatDoctorReport> = {}): ChatDoctorReport {
  return {
    room_id: "room-1",
    room_id_source: "git-origin",
    origin_url_raw: "git@github.com:acme/widgets.git",
    origin_url_normalised: "github.com/acme/widgets",
    git_email: "",
    git_name: "",
    handle: "",
    device_id: "dev-1",
    cloud_origin: "https://auravcs.com",
    cloud_url_raw: null,
    cloud_token_present: false,
    ws_url: "wss://auravcs.com",
    http_ws_host_match: true,
    cloud_reachable: false,
    cloud_status: null,
    cloud_error: null,
    channels: ["general"],
    local_message_count: 0,
    cloud_message_count_general: null,
    outbox_pending: 0,
    outbox_failed: 0,
    outbox_last_error: null,
    roster_email_match: false,
    canonical_handle: null,
    canonical_email: null,
    alias_emails: [],
    identity_override_active: false,
    github_login: null,
    github_member_handle: null,
    github_member_email: null,
    github_member_name: null,
    ...over,
  };
}

function member(over: Partial<TeamMember> = {}): TeamMember {
  return {
    email: "someone@example.com",
    name: "Someone",
    handle: "someone",
    commits: 12,
    first_seen: 1,
    last_seen: 2,
    claimed: true,
    admin: false,
    ...over,
  };
}

function manifest(members: TeamMember[]): TeamManifest {
  return {
    team_id: "team-1",
    repo_root: "/repo",
    created_at: 0,
    members,
    channel_meta: [],
    channels: ["general"],
    collaborators_synced_at: 0,
    identity_splits: [],
    identity_merges: [],
  } as TeamManifest;
}

/** The roster the stranger inherited by cloning: real people, all claimed,
 *  none of them him. */
const inheritedRoster = manifest([
  member({
    email: "ashiqwayanad007@gmail.com",
    name: "Ashiq",
    handle: "ashiqwayanad007",
    claimed: true,
    github_login: "ashiqwayanad007",
  }),
  member({
    email: "mck@naridon.com",
    name: "Mubasheer",
    handle: "mck",
    claimed: true,
    admin: true,
    also_emails: ["mubasheer.ck@hotmail.com"],
  }),
  member({ email: "third@acme.dev", name: "Third", handle: "third" }),
]);

describe("a stranger who cloned the repo", () => {
  const ctx = {
    report: report({ git_email: "", git_name: "", handle: "" }),
    manifest: inheritedRoster,
    account: null,
  };

  test("is offered NOBODY, not even one claimed roster member", () => {
    expect(buildIdentityChoices(ctx)).toEqual([]);
  });

  test("specifically, no borrowed identity from the roster", () => {
    const handles = buildIdentityChoices(ctx).map((c) => c.handle);
    expect(handles).not.toContain("ashiqwayanad007");
    expect(handles).not.toContain("mck");
    expect(handles).not.toContain("third");
  });

  test("sees the 'set yourself up' notice, never an identity picker", () => {
    // Not `null`: they genuinely have no git identity, and that IS worth
    // telling them — but the fix is to give them one, not lend them one.
    expect(identityBannerKind(ctx)).toBe("setup");
    expect(switchableIdentityChoices(ctx)).toEqual([]);
  });

  test("a roster of 200 claimed members still yields zero choices", () => {
    const huge = manifest(
      Array.from({ length: 200 }, (_, i) =>
        member({
          email: `person${i}@acme.dev`,
          handle: `person${i}`,
          name: `Person ${i}`,
          claimed: true,
        }),
      ),
    );
    expect(buildIdentityChoices({ ...ctx, manifest: huge })).toEqual([]);
  });
});

describe("a stranger who has a git identity of their own", () => {
  // Same inherited roster, but this machine does have a git author — one
  // that matches nobody on the team.
  const ctx = {
    report: report({
      git_email: "nobody@nowhere.test",
      git_name: "No Body",
      handle: "nobody",
    }),
    manifest: inheritedRoster,
    account: null,
  };

  test("is offered only their own identity", () => {
    const choices = buildIdentityChoices(ctx);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.email).toBe("nobody@nowhere.test");
    expect(choices[0]?.isLocalGit).toBe(true);
  });

  test("gets no notice at all — nothing is wrong with them", () => {
    // The old gate raised the banner because SOME roster member was
    // claimed. There is nothing here for the user to act on.
    expect(identityBannerKind(ctx)).toBeNull();
  });
});

describe("a real teammate whose git email is an alias", () => {
  // Mubasheer commits locally as mubasheer.ck@hotmail.com, which the admin
  // linked to the `mck` seat. `canonical_member_for_email` resolved it
  // server-side, so the report arrives already carrying the proof.
  const ctx = {
    report: report({
      git_email: "mubasheer.ck@hotmail.com",
      git_name: "Mubasheer CK",
      handle: "mubasheer.ck",
      canonical_handle: "mck",
      canonical_email: "mck@naridon.com",
      alias_emails: ["mubasheer.ck@hotmail.com"],
    }),
    manifest: inheritedRoster,
    account: null,
  };

  test("is still offered the canonical team handle", () => {
    const choices = buildIdentityChoices(ctx);
    const canonical = choices.find((c) => c.handle === "mck");
    expect(canonical).toBeDefined();
    expect(canonical?.email).toBe("mck@naridon.com");
    expect(canonical?.evidence).toBe("git-email");
    expect(canonical?.isLocalGit).toBe(false);
  });

  test("with their own git identity offered alongside it, listed last", () => {
    const choices = buildIdentityChoices(ctx);
    expect(choices).toHaveLength(2);
    expect(choices[0]?.handle).toBe("mck");
    expect(choices[1]?.isLocalGit).toBe(true);
    expect(choices[1]?.email).toBe("mubasheer.ck@hotmail.com");
  });

  test("and is asked to choose", () => {
    expect(identityBannerKind(ctx)).toBe("choose");
  });

  test("but is NOT also offered the other people on the roster", () => {
    const handles = buildIdentityChoices(ctx).map((c) => c.handle);
    expect(handles).not.toContain("ashiqwayanad007");
    expect(handles).not.toContain("third");
  });
});

describe("proof by signed-in GitHub account", () => {
  // Fresh laptop, no git author configured, but `gh` is signed in as
  // someone the roster records. That IS the person, so offering their seat
  // is the whole point — this is the case the blanket removal must not
  // break.
  const ctx = {
    report: report({
      git_email: "",
      github_login: "ashiqwayanad007",
      github_member_handle: "ashiqwayanad007",
      github_member_email: "ashiqwayanad007@gmail.com",
      github_member_name: "Ashiq",
    }),
    manifest: inheritedRoster,
    account: null,
  };

  test("their own seat is offered", () => {
    const choices = buildIdentityChoices(ctx);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.handle).toBe("ashiqwayanad007");
    expect(choices[0]?.evidence).toBe("github-account");
  });

  test("and only theirs — the rest of the team is still not offered", () => {
    const handles = buildIdentityChoices(ctx).map((c) => c.handle);
    expect(handles).not.toContain("mck");
    expect(handles).not.toContain("third");
  });

  test("so they're asked to choose, not to set up", () => {
    expect(identityBannerKind(ctx)).toBe("choose");
  });
});

describe("proof by signed-in Aura account", () => {
  const signedIn: CloudAuthStatus = {
    connected: true,
    user: "ashiqwayanad007",
    cloud_url: "https://auravcs.com",
  };

  test("matches the seat carrying that GitHub login", () => {
    const m = memberForAccount(inheritedRoster.members, signedIn);
    expect(m?.handle).toBe("ashiqwayanad007");
  });

  test("matches a seat whose linked email is the account's no-reply", () => {
    const roster = manifest([
      member({
        email: "team@acme.dev",
        handle: "acme",
        name: "Acme",
        also_emails: ["dana@users.noreply.auravcs.com"],
        github_login: null,
      }),
    ]);
    const m = memberForAccount(roster.members, {
      connected: true,
      user: "dana",
      cloud_url: "https://auravcs.com",
    });
    expect(m?.handle).toBe("acme");
  });

  test("does NOT match on a bare handle — handles are derived from emails and two people can share one", () => {
    const roster = manifest([
      member({
        email: "dana@some-other-company.com",
        handle: "dana",
        name: "A Different Dana",
        github_login: null,
      }),
    ]);
    expect(
      memberForAccount(roster.members, {
        connected: true,
        user: "dana",
        cloud_url: "https://auravcs.com",
      }),
    ).toBeNull();
  });

  test("a signed-out account proves nothing", () => {
    expect(
      memberForAccount(inheritedRoster.members, {
        connected: false,
        user: "ashiqwayanad007",
        cloud_url: "https://auravcs.com",
      }),
    ).toBeNull();
    expect(memberForAccount(inheritedRoster.members, null)).toBeNull();
  });

  test("an unread sign-in state proves nothing either", () => {
    // `null` account (status not fetched yet) must behave as signed out, so
    // a slow status call can never widen what is offered.
    const ctx = {
      report: report({ git_email: "" }),
      manifest: inheritedRoster,
      account: null,
    };
    expect(buildIdentityChoices(ctx)).toEqual([]);
  });

  test("the matched seat is offered to that account holder", () => {
    const choices = buildIdentityChoices({
      report: report({ git_email: "" }),
      manifest: inheritedRoster,
      account: signedIn,
    });
    expect(choices).toHaveLength(1);
    expect(choices[0]?.handle).toBe("ashiqwayanad007");
    expect(choices[0]?.evidence).toBe("aura-account");
  });
});

describe("the banner stays quiet when there is nothing to do", () => {
  test("git email already IS a roster seat", () => {
    expect(
      identityBannerKind({
        report: report({
          git_email: "mck@naridon.com",
          handle: "mck",
          roster_email_match: true,
        }),
        manifest: inheritedRoster,
        account: null,
      }),
    ).toBeNull();
  });

  test("a per-repo choice is already pinned", () => {
    expect(
      identityBannerKind({
        report: report({
          git_email: "",
          identity_override_active: true,
        }),
        manifest: inheritedRoster,
        account: null,
      }),
    ).toBeNull();
  });

  test("no roster at all and no git identity still offers setup", () => {
    expect(
      identityBannerKind({
        report: report({ git_email: "" }),
        manifest: null,
        account: null,
      }),
    ).toBe("setup");
  });
});

describe("deduping", () => {
  test("one person reached by two proofs appears once", () => {
    const choices = buildIdentityChoices({
      report: report({
        git_email: "mubasheer.ck@hotmail.com",
        handle: "mubasheer.ck",
        canonical_handle: "mck",
        canonical_email: "mck@naridon.com",
        github_login: "mck",
        github_member_handle: "mck",
        github_member_email: "mck@naridon.com",
        github_member_name: "Mubasheer",
      }),
      manifest: inheritedRoster,
      account: null,
    });
    expect(choices.filter((c) => c.handle === "mck")).toHaveLength(1);
  });
});
