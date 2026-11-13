// Run with: bun test src/components/ui/toast.test.tsx
//
// A toast's action buttons say what they do, and a plain message keeps no
// empty slot for a glyph it doesn't draw.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastButton, toastGlyph, toastKind } from "./toast";

describe("a toast action button", () => {
  test("shows its label", () => {
    const html = renderToStaticMarkup(<ToastButton primary>Poke back</ToastButton>);
    expect(html).toMatch(/<button[^>]*>Poke back<\/button>/);
  });

  test("keeps the label on the quiet button too", () => {
    const html = renderToStaticMarkup(<ToastButton primary={false}>Not now</ToastButton>);
    expect(html).toMatch(/<button[^>]*>Not now<\/button>/);
  });
});

describe("a toast's glyph", () => {
  test("a plain message has none, so no empty slot is laid out for it", () => {
    expect(toastGlyph(toastKind("accent"))).toBeNull();
  });

  test("a toast with a kind draws that kind's glyph", () => {
    for (const tone of ["success", "info", "warning", "danger"] as const) {
      const html = renderToStaticMarkup(<>{toastGlyph(toastKind(tone))}</>);
      expect(html).toMatch(/^<svg[^>]*>.*<\/svg>$/);
    }
  });
});
