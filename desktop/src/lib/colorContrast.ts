// colorContrast — tiny, dependency-free WCAG contrast math.
//
// Used to keep an imported / picked color theme from blacking out the whole
// app: before we reskin Aura's chrome from a theme's derived palette, we check
// that the background and the body text actually have enough contrast to be
// read. A theme whose derived text would vanish into its background is refused
// (the editor still themes; the chrome stays on Aura's own readable tokens).
//
// Pure functions of their inputs — no DOM, no clock — so they're unit-testable.

/** Parse a `#rgb` / `#rrggbb` / `#rrggbbaa` hex string to 0..255 channels.
 *  Returns null for anything that isn't a hex color. Alpha is ignored. */
export function hexToRgb(hex: unknown): { r: number; g: number; b: number } | null {
  if (typeof hex !== "string") return null;
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split("")
      .map((c) => c + c)
      .join("");
  } else if (h.length === 6 || h.length === 8) {
    h = h.slice(0, 6);
  } else {
    return null;
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** WCAG relative luminance (0..1) of an sRGB color. */
export function relativeLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** WCAG contrast ratio between two hex colors (1..21). Returns null if either
 *  side isn't a parseable hex color. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la == null || lb == null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** True when `fg` is legible on `bg`. The threshold is deliberately lenient
 *  (3:1 — WCAG's large-text floor) so we only block genuinely unreadable
 *  palettes, not merely low-contrast-but-usable ones. Unparseable input is
 *  treated as "not safe" so we fall back to Aura's own tokens. */
export function isReadablePair(bg: string, fg: string, min = 3): boolean {
  const ratio = contrastRatio(bg, fg);
  return ratio != null && ratio >= min;
}
