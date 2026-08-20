// The team manifest, read once instead of fifteen times.
//
// `team_load` walks git history for the roster, announces your presence to the
// cloud, fetches everyone else's, and writes the merged manifest back to disk.
// Two network round-trips and a disk write. Fifteen surfaces call it — the
// tasks board once per project root, the activity feed and chat on timers, most
// of the rest on every mount — so opening two tabs that both show who is on the
// team paid for the whole thing twice.
//
// Two rules are held here. Overlapping reads collapse into one; and a surface
// that just *changed* the team reads past the window, because a button whose
// effect doesn't show is indistinguishable from a button that didn't work.
//
// The same two rules cover "who am I in this team", which is the second
// question every one of those surfaces asks — six of them in the very same
// `Promise.all` as the manifest, so one load of the team tab ran the git sync
// twice, concurrently. The backend's own 10s walk cache cannot collapse that:
// neither call has landed yet, so both miss it.

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";

import { readSrc, stripComments } from "./support/code";

let calls = 0;
let fail: string | null = null;
let members = 1;
let idCalls = 0;
let idFail: string | null = null;
let admin = false;

mock.module("../src/lib/api", () => ({
  api: {
    teamLoad: async (_repoRoot: string) => {
      calls += 1;
      if (fail !== null) throw new Error(fail);
      return { members: Array.from({ length: members }, (_, i) => ({ id: i })) };
    },
    teamIdentity: async (_repoRoot: string) => {
      idCalls += 1;
      if (idFail !== null) throw new Error(idFail);
      return { email: "me@example.com", is_admin: admin };
    },
  },
}));

const {
  fetchTeam,
  refreshTeam,
  peekTeam,
  invalidateTeam,
  fetchIdentity,
  refreshIdentity,
  peekIdentity,
  invalidateIdentity,
} = await import("../src/lib/teamCache");

const REPO = "/tmp/test-repo";
const realNow = Date.now;

beforeEach(() => {
  calls = 0;
  fail = null;
  members = 1;
  invalidateTeam();
  idCalls = 0;
  idFail = null;
  admin = false;
  invalidateIdentity();
});

afterEach(() => {
  Date.now = realNow;
});

function advance(ms: number) {
  const from = Date.now();
  Date.now = () => from + ms;
}

describe("one read for every surface that wants the roster", () => {
  it("several panes mounting together cost one read", async () => {
    await fetchTeam(REPO);
    advance(500);
    await fetchTeam(REPO);
    advance(500);
    await fetchTeam(REPO);
    expect(calls).toBe(1);
  });

  it("the tasks board's per-project fan-out still reads each project once", async () => {
    await Promise.all([fetchTeam("/a"), fetchTeam("/b"), fetchTeam("/a")]);
    expect(calls).toBe(2);
    invalidateTeam();
  });

  it("reads again once the window has passed", async () => {
    await fetchTeam(REPO);
    advance(11_000);
    await fetchTeam(REPO);
    expect(calls).toBe(2);
  });
});

describe("a surface that changed the team sees the change", () => {
  it("a forced read ignores the window", async () => {
    await fetchTeam(REPO);
    members = 2;
    const after = await refreshTeam(REPO);
    expect(after.members.length).toBe(2);
    expect(calls).toBe(2);
  });

  it("what it read is published to everyone else", async () => {
    await fetchTeam(REPO);
    members = 2;
    await refreshTeam(REPO);
    // The other surfaces converge on the new manifest rather than holding the
    // roster from before the change until their own window lapses.
    const elsewhere = await fetchTeam(REPO);
    expect(elsewhere.members.length).toBe(2);
    expect(calls).toBe(2);
  });
});

describe("a failed read is not an empty team", () => {
  it("rejects instead of answering with nobody", async () => {
    fail = "cloud unreachable";
    await expect(fetchTeam(REPO)).rejects.toThrow("cloud unreachable");
  });

  it("caches nothing and leaves the last good roster peekable", async () => {
    await fetchTeam(REPO);
    advance(11_000);
    fail = "cloud unreachable";
    await fetchTeam(REPO).catch(() => {});
    expect(peekTeam(REPO)?.members.length).toBe(1);
    fail = null;
    await fetchTeam(REPO);
    expect(calls).toBe(3);
  });
});

describe("who you are, asked once", () => {
  it("the six surfaces that ask alongside the manifest cost one sync", async () => {
    await Promise.all([
      fetchIdentity(REPO),
      fetchIdentity(REPO),
      fetchIdentity(REPO),
    ]);
    // In flight together is exactly the case the backend's own TTL cannot
    // help with: none of them has landed, so all of them would miss it.
    expect(idCalls).toBe(1);
  });

  it("is a second question, not the same read as the roster", async () => {
    await Promise.all([fetchTeam(REPO), fetchIdentity(REPO)]);
    expect(calls).toBe(1);
    expect(idCalls).toBe(1);
    expect(peekIdentity(REPO)?.email).toBe("me@example.com");
    expect(peekTeam(REPO)?.members.length).toBe(1);
  });

  it("holds the answer for the same window as the roster it describes", async () => {
    await fetchIdentity(REPO);
    advance(5_000);
    await fetchIdentity(REPO);
    // Two windows would let one surface show you as an admin while the pane
    // beside it says you are not — of the same team, at the same instant.
    expect(idCalls).toBe(1);
    advance(6_000);
    await fetchIdentity(REPO);
    expect(idCalls).toBe(2);
  });

  it("a claim or an admin transfer reads past the window", async () => {
    await fetchIdentity(REPO);
    admin = true;
    const after = await refreshIdentity(REPO);
    expect(after.is_admin).toBe(true);
    expect(idCalls).toBe(2);
  });

  it("and what it read regates the other surfaces too", async () => {
    await fetchIdentity(REPO);
    admin = true;
    await refreshIdentity(REPO);
    // Otherwise the tab that stepped you down keeps showing the controls to
    // everything else on screen until their own window lapses.
    expect((await fetchIdentity(REPO)).is_admin).toBe(true);
    expect(idCalls).toBe(2);
  });

  it("does not answer a failed read with 'not in this team'", async () => {
    idFail = "git unavailable";
    await expect(fetchIdentity(REPO)).rejects.toThrow("git unavailable");
    // A null identity is what the callers render as "you are not a member",
    // and that hides controls you are entitled to. "We could not tell" has to
    // stay tellable apart from it.
    expect(peekIdentity(REPO)).toBeUndefined();
  });
});

describe("wiring", () => {
  it("matches the backend's own staleness window for this data", async () => {
    const ts = stripComments(await readSrc("lib/teamCache.ts"));
    const m = ts.match(/const FRESH_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ""));
    // cmd_team.rs caches the history walk underneath for AUTHOR_WALK_TTL_SECS
    // = 10, on the reasoning that a handful of seconds of roster staleness is
    // invisible. Reading further ahead than the layer below is not a saving,
    // it is a second, longer-lived copy of the same staleness.
    const rs = await Bun.file(
      `${import.meta.dir}/../src-tauri/src/cmd_team.rs`,
    ).text();
    const ttl = rs.match(/const AUTHOR_WALK_TTL_SECS: u64 = (\d+);/);
    expect(ttl).not.toBeNull();
    expect(ms).toBe(Number(ttl![1]) * 1000);
  });

  it("nothing reads the manifest straight from the api", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    // `import.meta.dir`, not a URL pathname — this repo lives under a path
    // with a space in it, which a URL would percent-encode into nothing.
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/teamCache.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      if (body.includes("api.teamLoad(")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("nothing asks the backend who you are, either", async () => {
    // One straggler re-opens the git sync for everyone, and it looks entirely
    // correct on screen — which is why this is scanned rather than listed.
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/teamCache.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      if (body.includes("api.teamIdentity(")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the identity shares the manifest's window rather than declaring its own", async () => {
    const ts = stripComments(await readSrc("lib/teamCache.ts"));
    expect(ts.match(/const FRESH_MS =/g)?.length).toBe(1);
    // Both readers take it from the same constant, so the two answers about
    // one roster cannot go stale at different moments.
    expect(ts.match(/api\.teamIdentity\(repoRoot\),\s*\n\s*FRESH_MS,/)).not
      .toBeNull();
  });

  it("every surface that changes who you are regates on a fresh answer", async () => {
    // Admin transfer can step *you* down, and claiming a seat makes you a
    // member you were not a moment ago. Re-reading through the window shows
    // the permissions you had before your own action.
    const regaters = [
      "components/settings/TeamTab.tsx",
      "components/team/application/useTeamChat.ts",
    ];
    for (const rel of regaters) {
      const body = stripComments(await readSrc(rel));
      expect([rel, body.includes("refreshIdentity(")]).toEqual([rel, true]);
    }
  });

  it("every surface that changes the team reads past the window", async () => {
    // The rule that keeps a mutation honest. A file that calls one of these
    // and then re-reads through the shared window would show the roster from
    // before its own change — for up to ten seconds, which reads as "the
    // button did nothing".
    const mutators = [
      "api.teamChannel",
      "api.teamSetAdmin",
      "api.teamTransferAdmin",
      "api.teamAlias",
      "api.teamIdentityConfirmDuplicate",
      "api.teamIdentityRejectDuplicate",
      "api.teamClaim",
      "api.teamVoiceSet",
      "api.teamSyncCollaborators",
    ];
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/teamCache.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      if (!mutators.some((m) => body.includes(m))) continue;
      if (body.includes("fetchTeam(")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
