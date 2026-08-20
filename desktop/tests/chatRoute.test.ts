// Tapping a chat notification lands you on the message.
//
// The notification says who and where — "Ashiq · #design". Tapping it used to
// call `focusWindow()` and stop: the app came forward on whatever you were
// looking at before, and finding the message was your problem. Both halves of
// the fix already existed separately (`goToPlace("team")`,
// `aura:focus-chat-channel`); what was missing was somewhere for the
// destination to wait, because asking for Team is a render away from Team
// existing to hear about it.
//
// So the rules held here are: the destination survives the gap, it is acted
// on exactly once, it belongs to one project, and it expires rather than
// ambushing a later visit to Team.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";

import { readSrc, stripComments } from "./support/code";

const dispatched: Array<{ type: string; detail: unknown }> = [];

// `routeToChatChannel` calls `goToPlace`, which dispatches on window. Neither
// module touches Tauri, and neither reads window at import time, so a stub
// installed around each test is the whole environment they need.
//
// It is installed and REMOVED per test rather than assigned once at module
// scope. There is no DOM in this suite, and bun shares one process across
// test files: a `window` left standing here is a `window` every other file's
// imports can see, and a module that branches on `typeof window` would take
// its browser path into a stub that has none of the rest of the DOM. That
// fails at import, which takes the whole file's tests with it.
class FakeCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

const g = globalThis as unknown as { window?: unknown; CustomEvent?: unknown };
const hadWindow = "window" in g;
const realWindow = g.window;
const hadCustomEvent = "CustomEvent" in g;
const realCustomEvent = g.CustomEvent;

function installWindow() {
  g.window = {
    dispatchEvent: (e: { type: string; detail?: unknown }) => {
      dispatched.push({ type: e.type, detail: e.detail });
      return true;
    },
  };
  g.CustomEvent = FakeCustomEvent;
}

function restoreWindow() {
  if (hadWindow) g.window = realWindow;
  else delete g.window;
  if (hadCustomEvent) g.CustomEvent = realCustomEvent;
  else delete g.CustomEvent;
}

const {
  routeToChatChannel,
  takePendingChatRoute,
  clearPendingChatRoute,
  focusChatChannel,
  CHAT_FOCUS_EVENT,
  ROUTE_TTL_MS,
} = await import("../src/lib/chatRoute");

const REPO = "/tmp/test-repo";
const OTHER = "/tmp/other-repo";
const realNow = Date.now;

beforeEach(() => {
  installWindow();
  dispatched.length = 0;
  clearPendingChatRoute();
});

afterEach(() => {
  Date.now = realNow;
  clearPendingChatRoute();
  restoreWindow();
});

function advance(ms: number) {
  const from = Date.now();
  Date.now = () => from + ms;
}

describe("a tap asks for the place and the conversation", () => {
  it("asks for Team and names the channel", () => {
    routeToChatChannel(REPO, "design");
    expect(dispatched.map((d) => d.type)).toEqual([
      "aura:place:go",
      CHAT_FOCUS_EVENT,
    ]);
    expect(dispatched[0].detail).toBe("team");
    expect(dispatched[1].detail).toEqual({ channel: "design" });
  });

  it("asks for the place first. Team has to exist before it can listen", () => {
    routeToChatChannel(REPO, "design");
    expect(dispatched[0].type).toBe("aura:place:go");
  });

  it("ignores a tap carrying no conversation", () => {
    routeToChatChannel(REPO, "");
    routeToChatChannel("", "design");
    expect(dispatched).toEqual([]);
    expect(takePendingChatRoute(REPO)).toBeNull();
  });
});

describe("the destination survives the gap before Team mounts", () => {
  it("is still there for the mount that was a render away", () => {
    routeToChatChannel(REPO, "design");
    expect(takePendingChatRoute(REPO)).toBe("design");
  });

  it("is acted on once. A later mount is not re-routed", () => {
    routeToChatChannel(REPO, "design");
    expect(takePendingChatRoute(REPO)).toBe("design");
    expect(takePendingChatRoute(REPO)).toBeNull();
  });

  it("the live listener consumes it, so the next mount is not hijacked", () => {
    // Team was already open: the dispatched event was heard, and the handler
    // clears what it just acted on. Without this, navigating away and back
    // inside the window would drop you into that channel a second time.
    routeToChatChannel(REPO, "design");
    clearPendingChatRoute();
    expect(takePendingChatRoute(REPO)).toBeNull();
  });

  it("a second tap replaces the first. The newest is the one meant", () => {
    routeToChatChannel(REPO, "design");
    routeToChatChannel(REPO, "general");
    expect(takePendingChatRoute(REPO)).toBe("general");
  });

  it("carries a dm slug through untouched", () => {
    // `dm-…` is resolved to the other side by the surface's own handler; this
    // layer must not try to interpret it.
    routeToChatChannel(REPO, "dm-ashiq");
    expect(takePendingChatRoute(REPO)).toBe("dm-ashiq");
  });
});

describe("a destination belongs to one project", () => {
  it("another project's Team does not collect it", () => {
    routeToChatChannel(REPO, "design");
    // The Team place renders the open project. Honouring this here would
    // select "#design" against the wrong team's conversation list — showing
    // either nothing or, worse, a same-named channel of someone else's.
    expect(takePendingChatRoute(OTHER)).toBeNull();
  });

  it("and is still waiting for the project it was meant for", () => {
    routeToChatChannel(REPO, "design");
    takePendingChatRoute(OTHER);
    expect(takePendingChatRoute(REPO)).toBe("design");
  });
});

describe("a destination nobody collected expires", () => {
  it("is gone once it is older than the window", () => {
    routeToChatChannel(REPO, "design");
    advance(ROUTE_TTL_MS + 1);
    // Team stayed closed and the user went elsewhere. Opening Team an hour
    // later is a new intent, not the tail of an old one.
    expect(takePendingChatRoute(REPO)).toBeNull();
  });

  it("survives a gap far longer than a mount but inside the window", () => {
    routeToChatChannel(REPO, "design");
    advance(2_000);
    expect(takePendingChatRoute(REPO)).toBe("design");
  });

  it("an expired destination is dropped, not left for the mount after", () => {
    routeToChatChannel(REPO, "design");
    advance(ROUTE_TTL_MS + 1);
    takePendingChatRoute(REPO);
    Date.now = realNow;
    expect(takePendingChatRoute(REPO)).toBeNull();
  });

  it("the window is long enough to be a mount and short enough not to be an intent", () => {
    expect(ROUTE_TTL_MS).toBeGreaterThanOrEqual(5_000);
    expect(ROUTE_TTL_MS).toBeLessThanOrEqual(120_000);
  });
});

describe("focusChatChannel", () => {
  it("names the conversation and nothing else", () => {
    focusChatChannel("design");
    expect(dispatched).toEqual([
      { type: CHAT_FOCUS_EVENT, detail: { channel: "design" } },
    ]);
  });
});

describe("wiring", () => {
  it("the bare tap reaches the app instead of stopping at focus", async () => {
    const src = stripComments(await readSrc("lib/notifications.ts"));
    // The old shape returned before `cb`, so "take me to this message" never
    // left the notification layer — which is the one layer that cannot know
    // where the message is.
    expect(src).not.toMatch(/if\s*\(!text\)\s*\{[^}]*return;/);
    expect(src).toContain("if (!text) void focusWindow();");
  });

  it("the notifier routes a bare tap rather than dropping it", async () => {
    const src = stripComments(await readSrc("lib/useChatNotifier.ts"));
    expect(src).toContain("routeToChatChannel(root, channel)");
  });

  it("the notifier compares against the project as it is now", async () => {
    const src = stripComments(await readSrc("lib/useChatNotifier.ts"));
    // `onChatReply` installs its listener once for the life of the window, so
    // the `repoRoot` in that closure is whichever project was open at install
    // time. Comparing against it would route correctly on the first project
    // and silently stop routing after a switch.
    expect(src).toContain("root === repoRootRef.current");
  });

  it("Team collects a parked destination on mount", async () => {
    const src = stripComments(
      await readSrc("components/team/application/useTeamChat.ts"),
    );
    expect(src).toContain("takePendingChatRoute(repoRoot)");
    expect(src).toContain("clearPendingChatRoute()");
    // Effects run in declaration order: the listener must be registered
    // before the mount collector re-dispatches, or the re-dispatch is heard
    // by nobody and the tap dies exactly where it used to.
    const listener = src.indexOf("addEventListener(CHAT_FOCUS_EVENT");
    const collector = src.indexOf("takePendingChatRoute(repoRoot)");
    expect(listener).toBeGreaterThan(-1);
    expect(collector).toBeGreaterThan(listener);
  });

  it("everyone dispatches the one focus event, by name", async () => {
    // A second string literal of the same event name is a rename waiting to
    // half-land.
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/chatRoute.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      if (body.includes('"aura:focus-chat-channel"')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
