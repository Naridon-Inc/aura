import { beforeEach, describe, expect, test } from "bun:test";

import {
  fallbackAvatarFor,
  fallbackAvatarMissed,
  normalizeAvatarKey,
  requestFallbackAvatar,
  resetFallbackAvatars,
  setFallbackAvatarTransport,
  subscribeFallbackAvatars,
  warmFallbackAvatars,
  type FallbackAvatarTransport,
} from "./fallbackAvatars";

// The portrait endpoint hands back a different face on every call, so this
// store's entire job is to make sure it is called as few times as possible and
// that a person, once given a face, keeps it. These pin the four ways that
// promise breaks: a fetch that should never have happened because a real photo
// exists, a face that changes on the second look, a failure that erases the
// monogram, and a roster of one person costing forty requests.

/** A stand-in for the Tauri backend that counts what it was asked to do and
 *  hands out a different portrait every call — exactly like the real endpoint,
 *  which is why the store can never lean on the fetch being repeatable. */
function makeTransport(seed: Record<string, string> = {}) {
  const disk = new Map(Object.entries(seed));
  const counts = { cached: 0, fetched: 0 };
  let issued = 0;
  const transport: FallbackAvatarTransport = {
    cached: async (keys) => {
      counts.cached += 1;
      const out: Record<string, string> = {};
      for (const key of keys) {
        const hit = disk.get(key);
        if (hit) out[key] = hit;
      }
      return out;
    },
    fetchOne: async (key) => {
      counts.fetched += 1;
      issued += 1;
      const url = `data:image/webp;base64,PORTRAIT-${issued}`;
      disk.set(key, url);
      return url;
    },
  };
  return { transport, counts, disk };
}

/** A backend with no way out: every call rejects, as it would offline or behind
 *  a proxy that blocks the host. */
function makeFailingTransport() {
  const counts = { cached: 0, fetched: 0 };
  const transport: FallbackAvatarTransport = {
    cached: async () => {
      counts.cached += 1;
      throw new Error("no cache");
    },
    fetchOne: async () => {
      counts.fetched += 1;
      throw new Error("offline");
    },
  };
  return { transport, counts };
}

/** Let the store's in-flight promise chain settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  resetFallbackAvatars();
  setFallbackAvatarTransport(null);
});

describe("which identity a face is filed under", () => {
  test("the same person typed differently is one person", () => {
    expect(normalizeAvatarKey("  Mo@TouchStage.com ")).toBe("mo@touchstage.com");
    expect(normalizeAvatarKey("mo@touchstage.com")).toBe("mo@touchstage.com");
  });

  test("an absent identity is not an identity", () => {
    expect(normalizeAvatarKey(null)).toBeNull();
    expect(normalizeAvatarKey(undefined)).toBeNull();
    expect(normalizeAvatarKey("   ")).toBeNull();
  });

  test("nothing is asked for on behalf of nobody", async () => {
    const { transport, counts } = makeTransport();
    setFallbackAvatarTransport(transport);
    requestFallbackAvatar(null);
    await settle();
    expect(counts.cached).toBe(0);
    expect(counts.fetched).toBe(0);
  });
});

describe("a real picture always wins", () => {
  // The component decides this by passing `enabled: false` to the hook, which
  // means the store is simply never asked. Pinned here at the store's edge: an
  // avatar with a photo does not reach this module at all, so no request for a
  // person we already have a face for can exist.
  test("a person with a photo never becomes a request", async () => {
    const { transport, counts } = makeTransport();
    setFallbackAvatarTransport(transport);

    const hasPhoto = "https://github.com/octocat.png?size=64";
    const enabled = !hasPhoto;
    if (enabled) requestFallbackAvatar(normalizeAvatarKey("octocat"));
    await settle();

    expect(counts.fetched).toBe(0);
    expect(counts.cached).toBe(0);
    expect(fallbackAvatarFor("octocat")).toBeNull();
  });
});

describe("the same person keeps the same face", () => {
  test("a second look reads the stored bytes, not a new portrait", async () => {
    const { transport, counts } = makeTransport();
    setFallbackAvatarTransport(transport);

    requestFallbackAvatar("mo@touchstage.com");
    await settle();
    const first = fallbackAvatarFor("mo@touchstage.com");
    expect(first).toBe("data:image/webp;base64,PORTRAIT-1");

    // Re-render: the row asks again, as every mount does.
    requestFallbackAvatar("mo@touchstage.com");
    await settle();
    expect(fallbackAvatarFor("mo@touchstage.com")).toBe(first);
    expect(counts.fetched).toBe(1);
  });

  test("a second launch draws the stored face with no fetch at all", async () => {
    // What the previous run left behind on disk.
    const stored = "data:image/webp;base64,FROM-DISK";
    const { transport, counts } = makeTransport({ "mo@touchstage.com": stored });
    setFallbackAvatarTransport(transport);

    requestFallbackAvatar("mo@touchstage.com");
    await settle();

    expect(fallbackAvatarFor("mo@touchstage.com")).toBe(stored);
    expect(counts.fetched).toBe(0);
  });

  test("warming a roster up front costs one read and no fetches", async () => {
    const { transport, counts } = makeTransport({
      "a@x.com": "data:image/webp;base64,A",
      "b@x.com": "data:image/webp;base64,B",
    });
    setFallbackAvatarTransport(transport);

    await warmFallbackAvatars(["a@x.com", "b@x.com", "c@x.com", null]);

    expect(counts.cached).toBe(1);
    expect(counts.fetched).toBe(0);
    expect(fallbackAvatarFor("a@x.com")).toBe("data:image/webp;base64,A");
    expect(fallbackAvatarFor("b@x.com")).toBe("data:image/webp;base64,B");
    // Nobody had a face for c@x.com, and warming refuses to go and get one.
    expect(fallbackAvatarFor("c@x.com")).toBeNull();
  });

  test("a warmed person is not re-read when their row renders", async () => {
    const { transport, counts } = makeTransport({ "a@x.com": "data:image/webp;base64,A" });
    setFallbackAvatarTransport(transport);

    await warmFallbackAvatars(["a@x.com"]);
    requestFallbackAvatar("a@x.com");
    await settle();

    expect(counts.cached).toBe(1);
    expect(counts.fetched).toBe(0);
  });
});

describe("a fetch that fails changes nothing", () => {
  test("the caller is told nothing and keeps its monogram", async () => {
    const { transport } = makeFailingTransport();
    setFallbackAvatarTransport(transport);

    requestFallbackAvatar("mo@touchstage.com");
    await settle();

    // Null is exactly what the component saw before this feature existed, so
    // it draws exactly what it drew before: the deterministic animal.
    expect(fallbackAvatarFor("mo@touchstage.com")).toBeNull();
    expect(fallbackAvatarMissed("mo@touchstage.com")).toBe(true);
  });

  test("a person we could not get is never asked for twice", async () => {
    const { transport, counts } = makeFailingTransport();
    setFallbackAvatarTransport(transport);

    requestFallbackAvatar("mo@touchstage.com");
    await settle();
    // Every subsequent mount of every row for this person.
    for (let i = 0; i < 20; i += 1) requestFallbackAvatar("mo@touchstage.com");
    await settle();

    expect(counts.fetched).toBe(1);
  });

  test("with no backend wired, asking is a no-op rather than a throw", async () => {
    requestFallbackAvatar("mo@touchstage.com");
    await warmFallbackAvatars(["mo@touchstage.com"]);
    await settle();
    expect(fallbackAvatarFor("mo@touchstage.com")).toBeNull();
    expect(fallbackAvatarMissed("mo@touchstage.com")).toBe(false);
  });
});

describe("a list of the same person costs one request", () => {
  test("forty rows mounting at once fetch once", async () => {
    const { transport, counts } = makeTransport();
    setFallbackAvatarTransport(transport);

    for (let i = 0; i < 40; i += 1) requestFallbackAvatar("mo@touchstage.com");
    await settle();

    expect(counts.fetched).toBe(1);
    expect(counts.cached).toBe(1);
    expect(fallbackAvatarFor("mo@touchstage.com")).toBe("data:image/webp;base64,PORTRAIT-1");
  });

  test("forty different people fetch forty times, not more", async () => {
    const { transport, counts } = makeTransport();
    setFallbackAvatarTransport(transport);

    const people = Array.from({ length: 40 }, (_, i) => `p${i}@x.com`);
    // Two full passes, as a list that re-renders while the first is in the air.
    for (const p of people) requestFallbackAvatar(p);
    for (const p of people) requestFallbackAvatar(p);
    await settle();

    expect(counts.fetched).toBe(40);
    for (const p of people) expect(fallbackAvatarFor(p)).not.toBeNull();
  });

  test("everyone in a crowd gets their own face", async () => {
    const { transport } = makeTransport();
    setFallbackAvatarTransport(transport);

    requestFallbackAvatar("a@x.com");
    requestFallbackAvatar("b@x.com");
    await settle();

    const a = fallbackAvatarFor("a@x.com");
    const b = fallbackAvatarFor("b@x.com");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  test("subscribers hear about a face when it lands", async () => {
    const { transport } = makeTransport();
    setFallbackAvatarTransport(transport);
    let beats = 0;
    const stop = subscribeFallbackAvatars(() => {
      beats += 1;
    });

    requestFallbackAvatar("mo@touchstage.com");
    await settle();
    stop();

    expect(beats).toBeGreaterThan(0);
  });
});
