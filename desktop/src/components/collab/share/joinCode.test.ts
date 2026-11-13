import { describe, expect, test } from "bun:test";
import { extractJoinCode } from "./JoinSessionPanel";

describe("a pasted join link finds its code", () => {
  test("the share link the cloud hands out (/s/<code>)", () => {
    expect(extractJoinCode("https://auravcs.com/s/AbC123")).toBe("abc123");
  });

  test("a share link from a self-hosted origin", () => {
    expect(extractJoinCode("  https://aura.example.org/s/zz9yy8\n")).toBe("zz9yy8");
  });

  test("the older /join/<code> link", () => {
    expect(extractJoinCode("https://auravcs.com/join/qwerty")).toBe("qwerty");
  });

  test("a ?code= link", () => {
    expect(extractJoinCode("aura://join?code=K7M2P9")).toBe("k7m2p9");
  });

  test("a bare code, with spaces or dashes typed in", () => {
    expect(extractJoinCode(" k7m-2p9 ")).toBe("k7m2p9");
  });
});
