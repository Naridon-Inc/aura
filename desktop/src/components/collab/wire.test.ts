// What the server actually said, folded through the code the UI actually runs.
//
// The frames in `__fixtures__/wire-recording.json` are not written by hand.
// They were captured off the socket during `aura-cloud/tests/e2e/run.sh` —
// a real server, a real Postgres, real WebSocket clients — and each one is
// tagged with which peer received it. That matters: a hand-written fixture is
// the same guess as the code it tests, so it agrees with a renderer that has
// drifted away from the server. A recording disagrees.
//
// The assertions below are UI claims, not protocol claims. "A watcher's
// composer is locked" is `canDrive(state) === false`; "the guest sees the
// host's agent in the room" is a participant of kind `agent` in the roster the
// strip renders. The protocol itself is covered on the other side of the wire.

import { describe, expect, test } from "bun:test";

import { RECORDED, SESSION_ID, lastWhere, replay } from "./__fixtures__/replay";
import { parseServerFrame } from "../../lib/sessionLiveParse";
import {
  canDrive,
  isSessionHost,
  myAccess,
  sessionStream,
  splitParticipants,
} from "../../lib/sessionLiveSelectors";
import { railSessionFromLive } from "./rail/railFromLive";
import { sortParticipants } from "./collabPresence";

// `setTypingFlag` arms its expiry on `window`, which is right in the app and
// absent in a test process. Bun runs every test file in ONE process, so this
// global outlives this file: a half-`window` here is read by any module a
// LATER file imports, and module-scope code that guards on
// `typeof window !== "undefined"` then calls a method this object doesn't
// have. That is exactly how `settingsStore` — which registers its flush on
// `beforeunload` at import — took `cloudRunnerPanel.test.ts` down with it.
// So the shim carries the listener pair as no-ops: nothing here dispatches
// events, and a registration that goes nowhere is the honest fake.
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window: unknown }).window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

/**
 * Frames the renderer never sees, because the Tauri layer answers them itself.
 *
 * `tunnel_req` is served by `cmd_session_live/tunnel.rs` straight off the
 * connection pump: it proxies the request to a loopback port and replies with
 * `tunnel_res` without ever waking React. Its absence from `parseServerFrame`
 * is the design, so the coverage test below has to know that or it would read
 * a correct silence as a hole.
 */
const HANDLED_IN_RUST = new Set(["tunnel_req"]);

describe("the wire the UI was built against", () => {
  test("the recording is a real run, not an empty file", () => {
    expect(RECORDED.length).toBeGreaterThan(20);
    expect(SESSION_ID).toBe("sess-e2e-001");
  });

  test("every frame the server sent is one the renderer understands", () => {
    const unread = new Set<string>();
    for (const { frame } of RECORDED) {
      const type = String(frame.type);
      if (HANDLED_IN_RUST.has(type)) continue;
      if (parseServerFrame(frame) === null) unread.add(type);
    }
    // A type landing here means the server grew a frame the UI silently drops.
    expect([...unread]).toEqual([]);
  });
});

// The guest's socket outlives their promotion, so the watcher screen is the
// last moment before `drive` arrived — not the end of their connection.
const guestRun = replay("guest");
const watching = lastWhere(guestRun.steps, (s) => myAccess(s) === "watch");

describe("what a watcher sees", () => {
  const state = watching;

  test("they are in, as a guest", () => {
    expect(state.connection).toBe("live");
    expect(state.you?.name).toBe("Shahabas");
    expect(isSessionHost(state)).toBe(false);
  });

  test("their composer is locked. Watch is the level they were given", () => {
    expect(myAccess(state)).toBe("watch");
    expect(canDrive(state)).toBe(false);
  });

  test("the host and the host's agent are both in the room", () => {
    const { humans, agents } = splitParticipants(state.participants);
    expect(humans.map((p) => p.name)).toContain("Ashiq");
    expect(agents.length).toBeGreaterThan(0);
    // A human and a machine must never be one kind of row.
    expect(agents.every((p) => p.kind === "agent")).toBe(true);
    expect(humans.every((p) => p.kind === "human")).toBe(true);
  });

  test("the host's agent reads as the CLI it is, not as a person", () => {
    const { agents } = splitParticipants(state.participants);
    expect(agents[0]?.agent_kind).toBe("claude");
    expect(agents[0]?.name).toBe("Claude");
  });

  test("the roster puts the host first", () => {
    const ordered = sortParticipants(state.participants);
    expect(ordered[0]?.role).toBe("host");
  });

  test("the host is shown as online", () => {
    expect(state.hostOnline).toBe(true);
  });
});

describe("what the shared transcript shows", () => {
  const state = guestRun.final;
  const stream = sessionStream(state);

  test("the agent's output and the people's messages are one ordered list", () => {
    const texts = stream.map((item) =>
      item.kind === "entry" ? item.entry.text : item.msg.text,
    );
    expect(texts).toContain("Added a retry with backoff.");
    expect(texts).toContain("may I drive?");
    // Ordering is the whole reason they share a list: a remark has to sit at
    // the point in the run where it was made.
    const at = stream.map((item) =>
      item.kind === "entry" ? item.entry.at : item.msg.at,
    );
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("a message addressed to someone keeps who it was for", () => {
    const ask = stream.find(
      (item) => item.kind === "msg" && item.msg.text === "may I drive?",
    );
    expect(ask?.kind).toBe("msg");
    if (ask?.kind !== "msg") return;
    expect(ask.msg.intent).toBe("ask");
    expect(ask.msg.to).toBeTruthy();
    // Addressed at the host, and the host is somebody the roster can name.
    const target = state.participants.find((p) => p.id === ask.msg.to);
    expect(target?.name).toBe("Ashiq");
  });

  test("every author in the stream resolves to somebody in the roster", () => {
    const ids = new Set(state.participants.map((p) => p.id));
    for (const item of stream) {
      if (item.kind === "msg") expect(ids.has(item.msg.from)).toBe(true);
    }
  });
});

describe("what a promoted guest sees", () => {
  // The same person, after the host granted them `drive` and they reconnected.
  const state = replay("guest-rejoin").final;

  test("the promotion survived the socket", () => {
    expect(myAccess(state)).toBe("drive");
    expect(canDrive(state)).toBe(true);
  });

  test("and the replay brought back what they missed", () => {
    const stream = sessionStream(state);
    const texts = stream.map((item) =>
      item.kind === "entry" ? item.entry.text : item.msg.text,
    );
    expect(texts).toContain("Added a retry with backoff.");
    expect(texts.length).toBeGreaterThan(1);
  });
});

describe("what the host sees", () => {
  const hostRun = replay("host");

  test("they hold the session", () => {
    expect(isSessionHost(hostRun.final)).toBe(true);
    expect(canDrive(hostRun.final)).toBe(true);
  });

  test("the guest's arrival reached them", () => {
    // Asserted across the run, not at the end: the guest joins, is promoted
    // and leaves again inside this recording, so the host's closing roster is
    // correctly without them. What the host must never miss is the arrival.
    const sawGuest = hostRun.steps.some((s) =>
      s.participants.some((p) => p.name === "Shahabas"),
    );
    expect(sawGuest).toBe(true);
  });

  test("their own agent is in their roster too", () => {
    const { agents } = splitParticipants(hostRun.final.participants);
    expect(agents.map((p) => p.name)).toContain("Claude");
  });
});

describe("the sidebar row for this session", () => {
  const state = watching;
  const row = railSessionFromLive(
    { id: SESSION_ID, title: "Retry backoff", lastAt: 0 },
    state,
  );

  test("it reads as joined, at the level you actually hold", () => {
    expect(row.joined).toBe(true);
    expect(row.access).toBe("watch");
    expect(row.hostOnline).toBe(true);
  });

  test("it names who moved last, not the owner by default", () => {
    expect(row.lastActorId).toBeTruthy();
    expect(state.participants.some((p) => p.id === row.lastActorId)).toBe(true);
  });

  test("it carries both people and the agent as pips", () => {
    expect(row.participants.length).toBeGreaterThanOrEqual(2);
  });
});
