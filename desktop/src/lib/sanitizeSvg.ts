/** Sanitize an untrusted SVG glyph before it is injected via
 *  `dangerouslySetInnerHTML`.
 *
 *  Plugin icons can be raw `<svg>` markup and travel over the Commons
 *  exchange (team-shared bundles) and the unsigned-dev path, so the markup is
 *  attacker-controllable. A naive `<script>`-strip is not enough: SVG carries
 *  script through event-handler attributes (`onload`, `onclick`, …),
 *  `<foreignObject>` (arbitrary embedded HTML), and `javascript:` URLs on
 *  `href`/`xlink:href`.
 *
 *  Strategy: parse with the browser's own SVG parser, then walk the tree and
 *  keep only a presentational allowlist of elements, dropping every event
 *  handler attribute and any external/script-bearing reference. Anything the
 *  parser rejects, or that yields no `<svg>` root, collapses to an empty
 *  string so the caller falls back to the label initial. */

/** Presentational SVG elements a glyph legitimately needs. Deliberately
 *  excludes `script`, `foreignObject`, `a`, `use` (external ref), `image`,
 *  `animate*`/`set` (event-bearing), and `handler`. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "title",
  "desc",
  "symbol",
  "text",
  "tspan",
  "filter",
  "fegaussianblur",
  "feoffset",
  "feblend",
  "femerge",
  "femergenode",
  "fecolormatrix",
  "fecomposite",
  "feflood",
]);

function scrubElement(el: Element): void {
  // Drop every event-handler attribute and any reference that could carry a
  // scheme (`href`/`xlink:href`); a glyph never needs an external/script ref.
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "href" || name === "xlink:href" || name.endsWith(":href")) {
      const val = attr.value.trim().toLowerCase();
      // Only same-document fragment refs (e.g. gradients) are safe.
      if (!val.startsWith("#")) {
        el.removeAttribute(attr.name);
      }
    }
  }

  for (const child of Array.from(el.children)) {
    if (!ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
      child.remove();
      continue;
    }
    scrubElement(child);
  }
}

/** Returns sanitized `<svg>` markup, or "" if the input is not safe SVG. */
export function sanitizeSvgGlyph(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("<svg")) return "";
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(trimmed, "image/svg+xml");
  } catch {
    return "";
  }
  if (doc.getElementsByTagName("parsererror").length > 0) return "";
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return "";
  scrubElement(root);
  return new XMLSerializer().serializeToString(root);
}
