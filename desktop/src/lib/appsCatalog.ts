// Worldwide Commons app catalog.
//
// The Commons "Apps" launcher shows two sources side by side:
//   1. INSTALLED apps — `contributes.apps[]` from enabled plugins
//      (resolved live via `pluginApps()` in pluginContributesStore). These
//      open as a full-surface `app` workpane.
//   2. The WORLDWIDE CATALOG — a curated, global directory of app-plugins
//      anyone can publish. This is metadata only: a catalog entry never
//      grants capabilities or runs code. Obtaining an app still goes through
//      the same signed Plugin Exchange / bundle-install + ed25519 trust gate
//      as every other plugin, so the catalog can list third-party apps
//      without weakening the security model.
//
// The catalog is fetched from a public, credential-free endpoint and falls
// back to a shipped curated set when offline or the endpoint is unreachable.
// No secrets, IPs, or auth — it is a plain public JSON document.

export type AppCategory = "ai" | "mail" | "social" | "dev" | "fun";

/** How a catalog app is obtained. Drives the launcher CTA. */
export type AppSource =
  // Ships inside Aura — present as soon as the bundled plugin is enabled.
  | "builtin"
  // Published to the team/worldwide Plugin Exchange — install over the rail
  // with the normal trust prompt.
  | "exchange";

export type AppCatalogEntry = {
  /** Canonical app id (the `<appId>` half of an `app` pane key). */
  id: string;
  /** Bundle that provides the app, e.g. `com.aura.gemini`. The launcher
   *  matches this against installed `pluginApps[].pluginId` to know whether
   *  the app is already available. */
  bundleId: string;
  title: string;
  tagline: string;
  category: AppCategory;
  publisher: string;
  /** Emoji or short glyph shown on the tile (kept tiny — no remote images
   *  so a catalog entry can't beacon). Fallback when there's no local logo. */
  glyph: string;
  /** Optional brand logo, served from the bundled `public/app-icons/` set
   *  ONLY (a local path, never a remote URL — remote rows can't supply one,
   *  preserving the no-beacon guarantee). */
  logo?: string;
  /** Human-readable capability summary — what the app can reach. Shown so a
   *  user sees the blast radius before they ever install. */
  capabilities: string[];
  source: AppSource;
  /** Optional public homepage (informational only). */
  homepage?: string;
};

export const CATEGORY_LABEL: Record<AppCategory, string> = {
  ai: "AI",
  mail: "Mail",
  social: "Social",
  dev: "Developer",
  fun: "Fun",
};

// Shipped curated catalog — the fallback when the worldwide endpoint is
// unreachable, and the seed every Aura install starts from. Gemini is the
// reference app that proves the host-credential-injection pipe (the API key
// stays host-side; the sandbox only ever sees responses).
export const BUILTIN_APP_CATALOG: AppCatalogEntry[] = [
  {
    id: "gemini",
    bundleId: "@aura/gemini",
    title: "Gemini",
    tagline: "Chat with Google Gemini without leaving Aura.",
    category: "ai",
    publisher: "Aura",
    glyph: "✦",
    logo: "/app-icons/gemini.svg",
    capabilities: ["net:fetch:generativelanguage.googleapis.com", "storage:kv"],
    source: "builtin",
    homepage: "https://ai.google.dev",
  },
  {
    id: "gmail",
    bundleId: "@aura/gmail",
    title: "Gmail",
    tagline: "Read and triage mail in a sandboxed Commons app.",
    category: "mail",
    publisher: "Aura",
    glyph: "✉",
    logo: "/app-icons/gmail.svg",
    capabilities: ["net:fetch:gmail.googleapis.com", "storage:kv"],
    source: "builtin",
    homepage: "https://mail.google.com",
  },
  {
    id: "reddit",
    bundleId: "@aura/reddit",
    title: "Reddit",
    tagline: "Browse subreddits in-editor. The reference public-API app.",
    category: "social",
    publisher: "Aura",
    glyph: "👽",
    logo: "/app-icons/reddit.svg",
    capabilities: ["net:fetch:www.reddit.com", "storage:kv"],
    source: "builtin",
    homepage: "https://www.reddit.com",
  },
  {
    id: "hackernews",
    bundleId: "@aura/hackernews",
    title: "Hacker News",
    tagline: "Top, New, Ask & Show HN. One tap to the thread.",
    category: "social",
    publisher: "Aura",
    glyph: "🟧",
    logo: "/app-icons/hackernews.svg",
    capabilities: ["net:fetch:hn.algolia.com", "storage:kv"],
    source: "builtin",
    homepage: "https://news.ycombinator.com",
  },
];

/** Public, credential-free worldwide catalog endpoint. A plain JSON document
 *  — listing only, never code. Overridable for self-hosting via
 *  `localStorage["aura.commons.catalogUrl"]`. */
function catalogUrl(): string {
  try {
    const override = localStorage.getItem("aura.commons.catalogUrl");
    if (override) return override;
  } catch {
    /* no localStorage (popout/headless) → default */
  }
  return "https://commons.auravcs.com/apps/catalog.json";
}

function isCategory(v: unknown): v is AppCategory {
  return v === "ai" || v === "mail" || v === "social" || v === "dev" || v === "fun";
}

/** Validate one raw catalog row into a typed entry, or null if malformed.
 *  Defensive: the worldwide doc is third-party data, so every field is
 *  range-checked and the source is forced to `exchange` (a remote listing
 *  can never claim to be a trusted builtin). */
function coerceEntry(raw: unknown): AppCatalogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const bundleId = typeof r.bundleId === "string" ? r.bundleId.trim() : "";
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!id || !bundleId || !title) return null;
  const category = isCategory(r.category) ? r.category : "dev";
  const caps = Array.isArray(r.capabilities)
    ? r.capabilities.filter((c): c is string => typeof c === "string").slice(0, 8)
    : [];
  return {
    id,
    bundleId,
    title,
    tagline: typeof r.tagline === "string" ? r.tagline.slice(0, 160) : "",
    category,
    publisher: typeof r.publisher === "string" ? r.publisher.slice(0, 60) : "Unknown",
    glyph: typeof r.glyph === "string" ? r.glyph.slice(0, 2) : "▢",
    capabilities: caps,
    // Remote rows are never trusted as builtin — installing still runs the
    // signed Exchange path with its trust prompt.
    source: "exchange",
    homepage: typeof r.homepage === "string" ? r.homepage : undefined,
  };
}

/** Fetch the worldwide catalog, merged over the shipped curated set.
 *  Always resolves (never throws): on any network/parse failure it returns
 *  the builtin list so the launcher is never empty. Builtin entries win on
 *  id collision so a remote row can't shadow a trusted bundled app. */
export async function fetchWorldwideCatalog(
  signal?: AbortSignal,
): Promise<AppCatalogEntry[]> {
  try {
    const res = await fetch(catalogUrl(), {
      signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return BUILTIN_APP_CATALOG;
    const body = (await res.json()) as unknown;
    const rawList = Array.isArray(body)
      ? body
      : Array.isArray((body as Record<string, unknown>)?.apps)
        ? ((body as Record<string, unknown>).apps as unknown[])
        : [];
    const remote = rawList
      .map(coerceEntry)
      .filter((e): e is AppCatalogEntry => e !== null);
    const byId = new Map<string, AppCatalogEntry>();
    for (const e of remote) byId.set(e.id, e);
    // Builtins override remote rows of the same id.
    for (const e of BUILTIN_APP_CATALOG) byId.set(e.id, e);
    return [...byId.values()];
  } catch {
    return BUILTIN_APP_CATALOG;
  }
}
