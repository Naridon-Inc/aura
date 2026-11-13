import { describe, expect, test } from "bun:test";

import { pickRepoAvatarSource } from "./repo-avatar";

describe("pickRepoAvatarSource", () => {
  const icon = "data:image/png;base64,iVBOR";
  const avatar = "https://github.com/o.png?size=64";

  test("a picked emoji outranks every picture", () => {
    expect(pickRepoAvatarSource({ emoji: "🚀", icon, avatar })).toEqual({
      kind: "emoji",
      emoji: "🚀",
    });
  });

  test("a picked icon outranks the repository's file and the owner's face", () => {
    const picked = "data:image/png;base64,UP";
    expect(pickRepoAvatarSource({ glyph: true, picked, icon, avatar })).toEqual({ kind: "glyph" });
    expect(pickRepoAvatarSource({ picked, icon, avatar })).toEqual({ kind: "picked", src: picked });
    expect(pickRepoAvatarSource({ picked, icon, avatar, failed: new Set([picked]) })).toEqual({
      kind: "icon",
      src: icon,
    });
    expect(pickRepoAvatarSource({ emoji: "🚀", glyph: true, picked })).toEqual({
      kind: "emoji",
      emoji: "🚀",
    });
  });

  test("the repository's own icon comes before the owner's face", () => {
    expect(pickRepoAvatarSource({ icon, avatar })).toEqual({ kind: "icon", src: icon });
  });

  test("the owner's face stands in when there is no icon file", () => {
    expect(pickRepoAvatarSource({ icon: null, avatar })).toEqual({ kind: "avatar", src: avatar });
  });

  test("a picture that failed to load is skipped for the next one", () => {
    expect(pickRepoAvatarSource({ icon, avatar, failed: new Set([icon]) })).toEqual({
      kind: "avatar",
      src: avatar,
    });
    expect(pickRepoAvatarSource({ icon, avatar, failed: new Set([icon, avatar]) })).toEqual({
      kind: "fallback",
    });
  });

  test("nothing known, or a blank emoji, is the fallback", () => {
    expect(pickRepoAvatarSource({})).toEqual({ kind: "fallback" });
    expect(pickRepoAvatarSource({ emoji: "  " })).toEqual({ kind: "fallback" });
  });
});
