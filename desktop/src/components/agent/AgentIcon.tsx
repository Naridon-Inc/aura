// Brand-colored agent marks. Real official vendor SVGs bundled at
// build time (via simple-icons npm + vite ?raw imports) so the marks
// render offline and pixel-identical to each vendor's product page.
// Anything unrecognised falls back to a neutral monogram tile.

// Vite raw-imports each SVG file at build time. The path data is
// extracted once at module load via a regex; cheap, deterministic,
// no runtime network. Adding a new agent: drop another entry in
// BRAND_PATHS and the icon shows up everywhere AgentIcon is mounted.
import claudeSvgRaw from "simple-icons/icons/claude.svg?raw";
import geminiSvgRaw from "simple-icons/icons/googlegemini.svg?raw";
import cursorSvgRaw from "simple-icons/icons/cursor.svg?raw";
import { useResolvedTheme } from "../../lib/themeStore";
import { AuraMark } from "../AuraMark";

export type AgentBrand = {
  fg: string;
  bg: string;
  ring: string;
};

// Pull the `d="…"` path attribute out of a simple-icons SVG. Their
// SVGs are a single <path> with a 24×24 viewbox, so one regex is
// enough — no full XML parser needed.
function extractPath(svg: string): string {
  const m = svg.match(/d="([^"]+)"/);
  return m ? m[1] : "";
}

const CLAUDE_PATH = extractPath(claudeSvgRaw);
const GEMINI_PATH = extractPath(geminiSvgRaw);
const CURSOR_PATH = extractPath(cursorSvgRaw);

// OpenAI's mark isn't shipped by simple-icons (vendor request). The
// path below is the official 6-fold rotationally-symmetric blossom
// approximation drawn from the published brand assets.
const OPENAI_PATH =
  "M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.787a4.5 4.5 0 0 1-.677 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z";

export function brandFor(agentId: string): AgentBrand {
  const id = agentId.toLowerCase();
  if (id === "aura-manager" || id.includes("aura")) {
    // Aura brand — off-white ring/dot on a soft Aura-bg tile, the same
    // mark as auravcs.com (#f5f5f3 fg, #050505 bg).
    return {
      fg: "#f5f5f3",
      bg: "color-mix(in srgb, #050505 80%, var(--color-bg-card))",
      ring: "color-mix(in srgb, #f5f5f3 35%, transparent)",
    };
  }
  if (id.includes("claude")) {
    return {
      fg: "var(--color-caret-orange)",
      bg: "color-mix(in srgb, var(--color-caret-orange) 16%, transparent)",
      ring: "color-mix(in srgb, var(--color-caret-orange) 55%, transparent)",
    };
  }
  if (id.includes("gemini")) {
    return {
      fg: "var(--color-blue)",
      bg: "color-mix(in srgb, var(--color-blue) 16%, transparent)",
      ring: "color-mix(in srgb, var(--color-blue) 55%, transparent)",
    };
  }
  if (id.includes("codex") || id.includes("openai")) {
    return {
      fg: "var(--color-green)",
      bg: "color-mix(in srgb, var(--color-green) 18%, transparent)",
      ring: "color-mix(in srgb, var(--color-green) 55%, transparent)",
    };
  }
  if (id.includes("cursor")) {
    return {
      fg: "var(--color-violet)",
      bg: "color-mix(in srgb, var(--color-violet) 18%, transparent)",
      ring: "color-mix(in srgb, var(--color-violet) 55%, transparent)",
    };
  }
  if (id.includes("kimi") || id.includes("moonshot")) {
    // Kimi-Coder (Moonshot AI) — indigo, matching the crescent-moon mark.
    return {
      fg: "#6366f1",
      bg: "color-mix(in srgb, #6366f1 16%, transparent)",
      ring: "color-mix(in srgb, #6366f1 55%, transparent)",
    };
  }
  if (id.includes("aider")) {
    // Aider — warm amber, matching its terminal-first brand.
    return {
      fg: "#eab308",
      bg: "color-mix(in srgb, #eab308 16%, transparent)",
      ring: "color-mix(in srgb, #eab308 55%, transparent)",
    };
  }
  if (id.includes("amp")) {
    // Sourcegraph Amp — coral/rose.
    return {
      fg: "#f43f5e",
      bg: "color-mix(in srgb, #f43f5e 16%, transparent)",
      ring: "color-mix(in srgb, #f43f5e 55%, transparent)",
    };
  }
  // openai-compat = the generic local-models / HF / Ollama / vLLM
  // adapter. Picks a neutral teal so it visually separates from the
  // first-party agent kinds without claiming any vendor's color.
  if (id === "openai-compat" || id.startsWith("openai-compat")) {
    return {
      fg: "var(--color-text-2)",
      bg: "var(--color-bg-card)",
      ring: "var(--color-line)",
    };
  }
  return {
    fg: "var(--color-text-2)",
    bg: "var(--color-bg-card)",
    ring: "var(--color-line)",
  };
}

/** Agent id → filename under `/public/app-icons/`. When a match is
 *  found we render the official multi-color brand SVG instead of the
 *  monochrome simple-icons path. Marks were lifted from superset.sh's
 *  desktop `app-icons/preset-icons/` (with `-white` variants for marks
 *  whose dark colors disappear on light tiles). */
type BrandFile = { dark: string; light?: string };

const BRAND_FILES: Record<string, BrandFile> = {
  claude:         { dark: "/app-icons/claude.svg" },
  gemini:         { dark: "/app-icons/gemini.svg" },
  codex:          { dark: "/app-icons/codex-white.svg",   light: "/app-icons/codex.svg" },
  cursor:         { dark: "/app-icons/cursor.svg" },
  "cursor-agent": { dark: "/app-icons/cursor-agent.svg" },
  kimi:           { dark: "/app-icons/kimi.svg" },
  opencode:       { dark: "/app-icons/opencode-white.svg", light: "/app-icons/opencode.svg" },
  windsurf:       { dark: "/app-icons/windsurf-white.svg", light: "/app-icons/windsurf.svg" },
  ghostty:        { dark: "/app-icons/ghostty.svg" },
  fleet:          { dark: "/app-icons/fleet.svg" },
  antigravity:    { dark: "/app-icons/antigravity.svg" },
  zed:            { dark: "/app-icons/zed.png" },
};

function brandFileFor(agentId: string, theme: "dark" | "light"): string | null {
  const id = agentId.toLowerCase();
  // Exact match first so `cursor-agent` doesn't fall through to `cursor`.
  const exact = BRAND_FILES[id];
  if (exact) return theme === "light" && exact.light ? exact.light : exact.dark;
  for (const key of Object.keys(BRAND_FILES)) {
    if (id.includes(key)) {
      const m = BRAND_FILES[key]!;
      return theme === "light" && m.light ? m.light : m.dark;
    }
  }
  return null;
}

type Props = {
  agentId: string;
  label?: string;
  size?: number;
  active?: boolean;
};

// 16px square mark — looks like a small glyph in the picker, scales up
// cleanly for the tab badge. Uses brand fg as foreground, brand bg as
// fill, and a soft ring when this is the active selection.
export function AgentIcon({ agentId, label, size = 16, active = false }: Props) {
  const brand = brandFor(agentId);
  const theme = useResolvedTheme();
  const id = agentId.toLowerCase();
  // When a multi-color brand SVG is available, drop the colored halo
  // tile — the mark sits on the surrounding surface like a sticker so
  // the brand colors aren't fighting our accent tint.
  const hasBrandFile = brandFileFor(id, theme) !== null;
  return (
    <span
      className="inline-flex items-center justify-center flex-shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(2, Math.round(size * 0.18)),
        background: hasBrandFile ? "transparent" : brand.bg,
        color: brand.fg,
        boxShadow: active && !hasBrandFile ? `0 0 0 1px ${brand.ring}` : undefined,
      }}
    >
      <Glyph id={id} label={label} size={size} theme={theme} />
    </span>
  );
}

function Glyph({
  id,
  label,
  size,
  theme,
}: {
  id: string;
  label?: string;
  size: number;
  theme: "dark" | "light";
}) {
  const s = Math.round(size * 0.78);

  // Aura Manager — the official Aura blossom mark. Inherits currentColor
  // from the brand fg so it tints with the tile.
  if (id === "aura-manager" || id.startsWith("aura")) {
    return <AuraMark size={s} />;
  }

  // Prefer the official multi-color brand mark from
  // `/public/app-icons/`. These are the same SVGs superset.sh ships
  // and look pixel-identical to the vendor's product page.
  const brandFile = brandFileFor(id, theme);
  if (brandFile) {
    return (
      <img
        src={brandFile}
        alt=""
        width={s}
        height={s}
        draggable={false}
        style={{ display: "block" }}
      />
    );
  }

  // openai-compat — generic "local model" glyph (a stylised chip).
  // Distinct enough from the brand marks above that the user can
  // tell at a glance the tab isn't a Claude/Gemini/Codex/Cursor.
  if (id === "openai-compat" || id.startsWith("openai-compat")) {
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
        <rect
          x="5"
          y="5"
          width="14"
          height="14"
          rx="2.5"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
        {[3, 9, 15, 21].map((y) => (
          <line
            key={`l-${y}`}
            x1="2"
            y1={y * 0.0 + (y === 3 ? 8 : y === 9 ? 12 : y === 15 ? 16 : 20)}
            x2="5"
            y2={y * 0.0 + (y === 3 ? 8 : y === 9 ? 12 : y === 15 ? 16 : 20)}
            stroke="currentColor"
            strokeWidth="1.4"
          />
        ))}
        {[3, 9, 15, 21].map((y) => (
          <line
            key={`r-${y}`}
            x1="19"
            y1={y === 3 ? 8 : y === 9 ? 12 : y === 15 ? 16 : 20}
            x2="22"
            y2={y === 3 ? 8 : y === 9 ? 12 : y === 15 ? 16 : 20}
            stroke="currentColor"
            strokeWidth="1.4"
          />
        ))}
      </svg>
    );
  }

  // simple-icons monochrome fallback for IDs we have a path but no
  // brand asset for. (Kept so the bundle still renders in tests where
  // `/public/app-icons/` may not be served.)
  let path: string | null = null;
  if (id.includes("claude")) path = CLAUDE_PATH;
  else if (id.includes("gemini")) path = GEMINI_PATH;
  else if (id.includes("cursor")) path = CURSOR_PATH;
  else if (id.includes("codex") || id.includes("openai")) path = OPENAI_PATH;
  if (path) {
    return (
      <svg
        width={s}
        height={s}
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ display: "block" }}
      >
        <path d={path} />
      </svg>
    );
  }

  // Generic: monogram letter.
  return (
    <span style={{ fontSize: Math.round(size * 0.6), fontWeight: 600 }}>
      {(label ?? id.charAt(0)).toUpperCase()}
    </span>
  );
}
