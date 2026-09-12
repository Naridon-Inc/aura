// The claim under test: the frontend's sockets follow whichever cloud the app
// is actually talking to. Before this module, five sites answered with a
// literal `wss://auravcs.com`, so an app run against staging POSTed to staging
// and subscribed to PRODUCTION — chat silently broke and a test run put traffic
// on the live cloud.

import { describe, expect, it, beforeEach, mock } from "bun:test";

const invokeMock = mock(async (_cmd: string) => "https://auravcs.com");

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invokeMock(cmd),
}));

const {
  cloudOrigins,
  cloudOriginsNow,
  wsOriginFor,
  PUBLIC_CLOUD,
  __resetCloudOriginsForTest,
} = await import("./cloudOrigin");

beforeEach(() => {
  __resetCloudOriginsForTest();
  invokeMock.mockClear();
});

describe("wsOriginFor", () => {
  it("keeps the host and swaps only the scheme", () => {
    expect(wsOriginFor("https://auravcs.com")).toBe("wss://auravcs.com");
    // A staging stack is plain http on localhost — it must NOT be upgraded to
    // wss, which would fail to connect and read as "staging is broken".
    expect(wsOriginFor("http://localhost:3011")).toBe("ws://localhost:3011");
  });

  it("ignores a trailing slash, so callers can always append a path", () => {
    expect(wsOriginFor("http://localhost:3011/")).toBe("ws://localhost:3011");
  });

  it("treats a bare host as https, matching the Rust side", () => {
    expect(wsOriginFor("cloud.example.com")).toBe("wss://cloud.example.com");
  });
});

describe("cloudOrigins", () => {
  it("follows the override the app was started with", async () => {
    invokeMock.mockImplementation(async () => "http://localhost:3011");
    expect(await cloudOrigins()).toEqual({
      http: "http://localhost:3011",
      ws: "ws://localhost:3011",
    });
  });

  it("asks once and remembers — every socket gets the same answer", async () => {
    invokeMock.mockImplementation(async () => "http://localhost:3011");
    const [a, b, c] = await Promise.all([
      cloudOrigins(),
      cloudOrigins(),
      cloudOrigins(),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the public cloud when the command fails", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("no such command");
    });
    // Signed-in users on the public cloud must keep working even if this
    // command is missing from an older shell.
    expect(await cloudOrigins()).toEqual(PUBLIC_CLOUD);
  });

  it("falls back to the public cloud on an empty answer", async () => {
    invokeMock.mockImplementation(async () => "   ");
    expect(await cloudOrigins()).toEqual(PUBLIC_CLOUD);
  });

  it("trims a trailing slash so URLs never double up", async () => {
    invokeMock.mockImplementation(async () => "https://cloud.example.com/");
    expect((await cloudOrigins()).http).toBe("https://cloud.example.com");
  });
});

describe("cloudOriginsNow", () => {
  it("is the public cloud before anything has resolved", () => {
    expect(cloudOriginsNow()).toEqual(PUBLIC_CLOUD);
  });

  it("is the resolved answer afterwards", async () => {
    invokeMock.mockImplementation(async () => "http://localhost:3011");
    await cloudOrigins();
    expect(cloudOriginsNow().ws).toBe("ws://localhost:3011");
  });
});
