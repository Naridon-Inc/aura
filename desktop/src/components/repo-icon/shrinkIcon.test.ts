import { describe, expect, test } from "bun:test";

import { ICON_EDGE, fitIcon, uploadType } from "./shrinkIcon";

describe("uploadType", () => {
  test("takes the image types the picker offers", () => {
    expect(uploadType("/a/logo.png")).toBe("image/png");
    expect(uploadType("/a/logo.JPG")).toBe("image/jpeg");
    expect(uploadType("/a/logo.jpeg")).toBe("image/jpeg");
    expect(uploadType("/a/logo.gif")).toBe("image/gif");
    expect(uploadType("/a/logo.webp")).toBe("image/webp");
    expect(uploadType("/a/logo.svg")).toBe("image/svg+xml");
  });

  test("refuses anything else", () => {
    for (const p of ["/a/logo.ico", "/a/notes.txt", "/a/no-extension", ""]) {
      expect(uploadType(p)).toBeNull();
    }
  });
});

describe("fitIcon", () => {
  test("a large square fills the 128px icon", () => {
    expect(fitIcon(1024, 1024)).toEqual({ edge: ICON_EDGE, x: 0, y: 0, w: 128, h: 128 });
  });

  test("a wide image is centred top to bottom", () => {
    expect(fitIcon(512, 256)).toEqual({ edge: 128, x: 0, y: 32, w: 128, h: 64 });
  });

  test("a small image is not blown up", () => {
    expect(fitIcon(32, 16)).toEqual({ edge: 32, x: 0, y: 8, w: 32, h: 16 });
  });

  test("an image with no size is treated as icon-sized", () => {
    expect(fitIcon(0, 0)).toEqual({ edge: 128, x: 0, y: 0, w: 128, h: 128 });
  });
});
