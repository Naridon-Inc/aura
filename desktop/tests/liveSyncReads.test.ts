// A Conflicts section that isn't there, from a read that failed.
//
//   bun test
//
// The Source Control panel's live groups auto-hide when they're empty —
// `PlaceRailGroup` returns null on `count === 0` — which is right: during a
// live session you don't want an empty "Incoming" heading sitting there all
// day. It's also what makes an empty list a *statement*. No Conflicts group
// on screen says nobody has changed the same code as you.
//
// The 4s poll behind it resolved every failure to an empty list:
//
//   api.sentinelAgents(root).catch(() => []),
//   api.auraReadImpacts(root).catch(() => []),
//   api.auraConflictsList(root).catch(() => []),
//   ...
//   setConflicts(confs.filter((c) => c.resolved_at == null));
//
// so a conflict you were looking at could vanish mid-glance, and stay gone,
// because one tick's read threw. The comment above it even reasoned its way
// there — "each source degrades to empty independently" — which is the right
// goal (one failure shouldn't blank the others) reached by the wrong means.
// Independently has to mean each one keeps what it had.
//
// Held below: the three data reads resolve to `null`, their setters are
// guarded, an unread list is `null` rather than `[]`, and both sections turn
// that `null` into a sentence instead of disappearing.

import { describe, expect, test } from "bun:test";
import { readSrc, stripComments } from "./support/code";

const HOOK = "components/rightrail/sync/useLiveSync.ts";

/** The part of `refresh` that runs once a session is up — from the batched
 *  reads to the point every result has been published. The `!status.running`
 *  branch above it clears everything to `[]` on purpose: nothing is running,
 *  so "none of any of it" is the true answer there, not a stand-in. */
async function readsBlock(): Promise<string> {
  const src = stripComments(await readSrc(HOOK));
  const i = src.indexOf("const [agents, presence, impacts, confs]");
  expect(i).toBeGreaterThan(-1);
  const j = src.indexOf("setError(null);", i);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("the live reads", () => {
  test("a failure is not an empty list", async () => {
    const flat = (await readsBlock()).replace(/\s+/g, "");
    expect(flat).not.toContain("catch(()=>[])");
    // Each of the three that feeds a group has to say "no answer". Two of
    // them now read through `ambientCache` — this hook and App.tsx poll the
    // same commands on the same 4s cadence — but a shared read rejects for
    // exactly this reason, so the rule here is untouched by that move.
    for (const call of [
      "api.sentinelAgents(repoRoot).catch(()=>null)",
      "fetchImpacts(repoRoot).catch(()=>null)",
      "fetchAstConflicts(repoRoot).catch(()=>null)",
    ]) {
      expect(flat).toContain(call);
    }
  });

  test("nothing is published from a read that didn't come back", async () => {
    const block = await readsBlock();
    for (const [guard, setter] of [
      ["if (agents)", "setLocalRead("],
      ["if (impacts)", "setIncoming("],
      ["if (confs)", "setConflicts("],
    ] as const) {
      expect(block).toContain(guard);
      const at = block.indexOf(setter);
      expect(at).toBeGreaterThan(-1);
      expect(block.slice(Math.max(0, at - 80), at)).toContain(guard);
    }
  });

  test("presence keeps its own honest fallback", async () => {
    // The one read that may answer `[]` on failure, because it also answers
    // *why*, and the panel renders that reason instead of "waiting for
    // peers…". Losing that would be a regression in the other direction.
    const block = await readsBlock();
    expect(block).toContain("reason: String(e)");
    const src = stripComments(await readSrc(HOOK));
    expect(src).toContain("setPresenceHint(presence.available ? null : presence.reason)");
  });

  test("the two lists start unread", async () => {
    const src = stripComments(await readSrc(HOOK));
    expect(src).toContain("useState<ImpactAlert[] | null>(null)");
    expect(src).toContain("useState<ConflictedNode[] | null>(null)");
    expect(src).toContain("incoming: ImpactAlert[] | null;");
    expect(src).toContain("conflicts: ConflictedNode[] | null;");
  });
});

describe("the peer list", () => {
  test("the two sources are held apart", async () => {
    // One `peers` array rewritten wholesale each tick meant a failed
    // sentinel read emptied the local agents out of it.
    const src = stripComments(await readSrc(HOOK));
    expect(src).toContain("useState<PeerRead[]>([])");
    expect(src).not.toContain("setPeers(");
    expect(src).toContain("[...cloudRead, ...localRead]");
  });

  test("stale is measured against the clock, not frozen at read time", async () => {
    const src = stripComments(await readSrc(HOOK));
    const flat = src.replace(/\s+/g, "");
    // Computed where the two lists are merged…
    expect(flat).toContain("stale:readAt-p.lastHeartbeat>PEER_STALE_SECS");
    // …and `readAt` advances on every attempt, so a peer we can no longer
    // ask about doesn't sit there looking fresh forever.
    expect(src).toContain("setReadAt(Date.now() / 1000)");
    // The stored shape deliberately has no `stale` of its own.
    expect(src).toContain('type PeerRead = Omit<LivePeer, "stale">');
  });
});

describe("an unread group says so instead of vanishing", () => {
  test("the group only hides itself on a real zero", async () => {
    // This is the behaviour both sections lean on. If it ever stops being
    // true the sentences below become dead code and nobody notices.
    const src = stripComments(await readSrc("components/places/PlaceRail.tsx"));
    expect(src).toContain("if (count === 0 && !empty) return null;");
    expect(src).toContain("{count === 0 && empty && (");
  });

  test("the Changes panel's group forwards the empty node", async () => {
    const src = stripComments(await readSrc("components/rightrail/CategorySection.tsx"));
    expect(src).toContain("empty?: ReactNode;");
    expect(src).toContain("empty={empty}");
  });

  for (const [name, rel, subject] of [
    ["Incoming", "components/rightrail/sync/IncomingSection.tsx", "impacts"],
    ["Conflicts", "components/rightrail/sync/ConflictsSection.tsx", "conflicts"],
  ] as const) {
    test(`${name} takes an unread list and explains it`, async () => {
      const src = stripComments(await readSrc(rel));
      const flat = src.replace(/\s+/g, "");
      expect(flat).toContain(`count={${subject}?.length??0}`);
      // The sentence is reached only from `null` — an empty list still
      // hides the group, which is the honest thing for a real zero.
      expect(flat).toContain(`empty={${subject}===null?"`);
      expect(flat).toContain(":undefined}");
      // …and it's plain language: no reader of this panel knows what an
      // impact feed or a conflict store is.
      expect(src).toContain("Couldn’t check");
      expect(src).not.toMatch(/jsonl|ConflictedNode\[\]\.|aura_read_impacts\(/);
    });
  }
});
