// A mermaid diagram drawn to SVG text in the app's palette, one at a time
// (mermaid keeps global state between renders) and remembered per source and
// theme, so a message re-rendering doesn't draw it again.

export type MermaidTheme = "dark" | "light";

const PALETTES = {
  dark: {
    bg: "#131110",
    fg: "#EAE8E6",
    line: "#766F6B",
    surface: "#2C2826",
    border: "#454038",
  },
  light: {
    bg: "#FFFFFF",
    fg: "#2C2826",
    line: "#BCB6B3",
    surface: "#FAFAF9",
    border: "#EAE8E6",
  },
} as const;

/** The mermaid settings for a theme: the base theme recoloured to the app. */
export function mermaidConfig(theme: MermaidTheme) {
  const p = PALETTES[theme];
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: "base" as const,
    darkMode: theme === "dark",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    themeVariables: {
      background: p.bg,
      primaryColor: p.surface,
      primaryTextColor: p.fg,
      primaryBorderColor: p.border,
      lineColor: p.line,
      textColor: p.fg,
    },
  };
}

export function mermaidCacheKey(source: string, theme: MermaidTheme) {
  return `${theme}\u0000${source}`;
}

const cache = new Map<string, Promise<string>>();
const CACHE_LIMIT = 64;
let queue: Promise<unknown> = Promise.resolve();
let count = 0;

async function draw(source: string, theme: MermaidTheme): Promise<string> {
  const mod: any = await import("mermaid");
  const mermaid = mod.default ?? mod;
  mermaid.initialize(mermaidConfig(theme));
  try {
    // Parse first: a failed render() leaves its error drawing in the page.
    const ok = await mermaid.parse(source, { suppressErrors: true });
    if (ok === false) throw new Error("invalid mermaid syntax");
    count += 1;
    const { svg } = await mermaid.render(`mermaid-preview-${count}`, source);
    return svg as string;
  } finally {
    if (typeof document !== "undefined") {
      document
        .querySelectorAll<HTMLElement>("body > div[id^='dmermaid-'], body > div.mermaid-error")
        .forEach((n) => n.remove());
    }
  }
}

/** The diagram's SVG text; rejects when the source isn't valid mermaid. */
export function renderMermaid(source: string, theme: MermaidTheme): Promise<string> {
  const key = mermaidCacheKey(source, theme);
  const hit = cache.get(key);
  if (hit) return hit;
  const next = queue.then(() => draw(source, theme));
  queue = next.catch(() => {});
  cache.set(key, next);
  next.catch(() => cache.delete(key));
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return next;
}
