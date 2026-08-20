import { describe, expect, test } from "bun:test";

import {
  MAX_LIVE_REMOTE_PLACES,
  NO_REMOTE_PLACES,
  blurRemotePlaces,
  enterRemotePlace,
  focusRemotePlace,
  focusedRemotePlace,
  isRemotePlaceEntered,
  leaveRemotePlace,
  remotePlaceKey,
} from "./remotePlaces";

const BOX = "ubuntu@18.196.118.42";
const OTHER = "ubuntu@3.122.52.150";

describe("what makes two entries the same place", () => {
  test("the same box on the same project is one place", () => {
    expect(remotePlaceKey({ machineId: BOX, repoRoot: "/src/aura" })).toBe(
      remotePlaceKey({ machineId: BOX, repoRoot: "/src/aura/" }),
    );
  });

  test("one box holding two projects is two places", () => {
    // `machine_id(user, host, repo_path)` is already how a cloud copy is keyed;
    // entering the second project on a box must not read as re-entering the
    // first.
    expect(remotePlaceKey({ machineId: BOX, repoRoot: "/src/aura" })).not.toBe(
      remotePlaceKey({ machineId: BOX, repoRoot: "/src/web" }),
    );
  });

  test("a conversation with no box yet is keyed by the conversation", () => {
    expect(remotePlaceKey({ threadKey: "thread-7" })).toBe(
      remotePlaceKey({ threadKey: "thread-7", machineId: "  " }),
    );
  });

  test("'open my machine' is still one place per project", () => {
    expect(remotePlaceKey({ repoRoot: "/src/aura" })).toBe(
      remotePlaceKey({ repoRoot: "/src/aura" }),
    );
    expect(remotePlaceKey({ repoRoot: "/src/aura" })).not.toBe(
      remotePlaceKey({ repoRoot: "/src/web" }),
    );
  });
});

describe("entering a place", () => {
  test("the first one is entered and focused", () => {
    const places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });

    expect(places.entered).toHaveLength(1);
    expect(focusedRemotePlace(places)).toEqual({ machineId: BOX });
  });

  test("a second machine does not cost you the first", () => {
    // The whole point. One `leavePages()` on the way in used to make places
    // mutually exclusive.
    let places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });
    places = enterRemotePlace(places, { machineId: OTHER });

    expect(places.entered.map((p) => p.machineId)).toEqual([BOX, OTHER]);
    expect(focusedRemotePlace(places)?.machineId).toBe(OTHER);
    expect(isRemotePlaceEntered(places, remotePlaceKey({ machineId: BOX }))).toBe(
      true,
    );
  });

  test("re-entering somewhere you already are is a focus, not a copy", () => {
    let places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });
    places = enterRemotePlace(places, { machineId: OTHER });
    places = enterRemotePlace(places, { machineId: BOX });

    expect(places.entered).toHaveLength(2);
    // …and it is now the most recently focused, so it is last.
    expect(places.entered.map((p) => p.machineId)).toEqual([OTHER, BOX]);
    expect(focusedRemotePlace(places)?.machineId).toBe(BOX);
  });

  test("a later click's detail wins", () => {
    // Two rows for the same box carry different repo roots only when they are
    // different places; the same place clicked again may still have learned
    // something (a thread it was reached through).
    let places = enterRemotePlace(NO_REMOTE_PLACES, {
      machineId: BOX,
      repoRoot: "/src/aura",
    });
    places = enterRemotePlace(places, {
      machineId: BOX,
      repoRoot: "/src/aura",
      threadKey: "thread-7",
    });

    expect(places.entered).toHaveLength(1);
    expect(focusedRemotePlace(places)?.threadKey).toBe("thread-7");
  });

  test("past the ceiling the least recently focused is dropped", () => {
    let places = NO_REMOTE_PLACES;
    for (let i = 0; i <= MAX_LIVE_REMOTE_PLACES; i += 1) {
      places = enterRemotePlace(places, { machineId: `box-${i}` });
    }

    expect(places.entered).toHaveLength(MAX_LIVE_REMOTE_PLACES);
    // The oldest went; the one just entered is still in front.
    expect(places.entered[0]!.machineId).toBe("box-1");
    expect(focusedRemotePlace(places)?.machineId).toBe(
      `box-${MAX_LIVE_REMOTE_PLACES}`,
    );
  });
});

describe("stepping off without leaving", () => {
  test("blurring keeps every machine and shows none of them", () => {
    let places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });
    places = enterRemotePlace(places, { machineId: OTHER });
    places = blurRemotePlaces(places);

    expect(places.entered).toHaveLength(2);
    expect(focusedRemotePlace(places)).toBeNull();
  });

  test("blurring twice is the same value, so nothing re-renders", () => {
    const places = blurRemotePlaces(
      enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX }),
    );

    expect(blurRemotePlaces(places)).toBe(places);
  });

  test("going back in front of one you blurred is one call", () => {
    let places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });
    places = enterRemotePlace(places, { machineId: OTHER });
    const key = remotePlaceKey({ machineId: BOX });
    places = blurRemotePlaces(places);
    places = focusRemotePlace(places, key);

    expect(focusedRemotePlace(places)?.machineId).toBe(BOX);
    expect(places.entered).toHaveLength(2);
  });

  test("focusing somewhere you never entered changes nothing", () => {
    const places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });

    expect(focusRemotePlace(places, "machine:nowhere:")).toBe(places);
  });

  test("focusing the one already in front changes nothing", () => {
    const places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });

    expect(focusRemotePlace(places, places.focusedKey!)).toBe(places);
  });
});

describe("leaving for real", () => {
  test("the one you left goes; the ones you didn't stay", () => {
    let places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });
    places = enterRemotePlace(places, { machineId: OTHER });
    places = leaveRemotePlace(places, remotePlaceKey({ machineId: OTHER }));

    expect(places.entered.map((p) => p.machineId)).toEqual([BOX]);
  });

  test("leaving the one in front leaves you where you were, not in another box", () => {
    // "Leave" means leave. Dropping someone into a different machine's shell
    // because it happened to be next in the list is the one answer nobody
    // asked for — the page they opened the box from is uncovered instead.
    let places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });
    places = enterRemotePlace(places, { machineId: OTHER });
    places = leaveRemotePlace(places, remotePlaceKey({ machineId: OTHER }));

    expect(focusedRemotePlace(places)).toBeNull();
  });

  test("leaving one you are not in front of keeps you where you are", () => {
    let places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });
    places = enterRemotePlace(places, { machineId: OTHER });
    places = leaveRemotePlace(places, remotePlaceKey({ machineId: BOX }));

    expect(focusedRemotePlace(places)?.machineId).toBe(OTHER);
  });

  test("leaving somewhere you were not is the same value", () => {
    const places = enterRemotePlace(NO_REMOTE_PLACES, { machineId: BOX });

    expect(leaveRemotePlace(places, remotePlaceKey({ machineId: OTHER }))).toBe(
      places,
    );
  });
});

describe("two projects on one box, and a conversation into a third", () => {
  test("all three are held at once", () => {
    let places = enterRemotePlace(NO_REMOTE_PLACES, {
      machineId: BOX,
      repoRoot: "/src/aura",
    });
    places = enterRemotePlace(places, {
      machineId: BOX,
      repoRoot: "/src/web",
    });
    places = enterRemotePlace(places, {
      threadKey: "thread-7",
      repoRoot: "/src/aura",
    });

    expect(places.entered).toHaveLength(3);
    expect(focusedRemotePlace(places)?.threadKey).toBe("thread-7");
    // …and the first is still open behind the other two.
    expect(
      isRemotePlaceEntered(
        places,
        remotePlaceKey({ machineId: BOX, repoRoot: "/src/aura" }),
      ),
    ).toBe(true);
  });
});
