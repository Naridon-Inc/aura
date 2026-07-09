// Commons → Apps launcher.
//
// The home for full-surface mini-apps (Gmail / Gemini / Reddit-style clients)
// people "do things" in. Two sources, one compact grid:
//   • Your apps — first-party builtins you've enabled + `contributes.apps[]`
//     from every installed plugin. Clicking a tile opens it INLINE, right here
//     in the panel (sidebar-sized when this lives in the rail). A pop-out
//     button lifts it into a full editor tab only when you want the room.
//   • Worldwide catalog — a curated, global directory. Builtins enable in
//     place (they already ship); third-party apps route to the Plugin
//     Exchange, where the signed-bundle + ed25519-trust install flow lives.
//     The catalog is listing metadata only; it never grants capabilities.

import { useEffect, useMemo, useState } from "react";

import { useEditorStore } from "../../lib/editorStore";
import { pluginApps, usePluginContributes } from "../../lib/pluginContributesStore";
import { AppPaneSurface } from "../plugins/AppPaneSurface";
import {
  BUILTIN_APP_CATALOG,
  CATEGORY_LABEL,
  fetchWorldwideCatalog,
  type AppCatalogEntry,
} from "../../lib/appsCatalog";
import {
  builtinAppKey,
  builtinIdFromKey,
  enableBuiltin,
  getBuiltinApp,
  isBuiltinEnabled,
  useEnabledBuiltins,
} from "../../lib/commonsApps";

type Props = {
  /** Switch the Commons surface to its Plugins (Exchange) segment so the
   *  user can install an app the catalog lists but they don't have yet. */
  onGetApp: () => void;
};

export function AppsLauncher({ onGetApp }: Props) {
  const editor = useEditorStore();
  const { rows } = usePluginContributes();
  const installed = useMemo(() => pluginApps(rows), [rows]);
  const installedBundles = useMemo(
    () => new Set(installed.map((a) => a.pluginId)),
    [installed],
  );

  // The app opened INLINE in this panel (sidebar-sized), if any. Null = the
  // launcher grid. This is what makes apps live in the rail by default; only
  // the explicit pop-out button promotes them to a full editor tab.
  const [openKey, setOpenKey] = useState<string | null>(null);

  // Enabled first-party builtins — reactive, so enabling one in the catalog
  // immediately lights it up under "Your apps".
  const enabledBuiltinIds = useEnabledBuiltins();
  const enabledBuiltins = useMemo(
    () =>
      enabledBuiltinIds
        .map((id) => getBuiltinApp(id))
        .filter((d): d is NonNullable<typeof d> => !!d),
    [enabledBuiltinIds],
  );

  const [catalog, setCatalog] = useState<AppCatalogEntry[]>(BUILTIN_APP_CATALOG);

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchWorldwideCatalog(ctrl.signal).then((c) => setCatalog(c));
    return () => ctrl.abort();
  }, []);

  // Open inline (sidebar-sized) — the default. Pop-out (below) is opt-in.
  const openInline = (key: string) => setOpenKey(key);
  const openBuiltinInline = (id: string) => openInline(builtinAppKey(id));

  // Catalog rows the user doesn't already have: hide plugin-installed bundles
  // AND already-enabled builtins (they live under "Your apps" now).
  const discover = useMemo(
    () =>
      catalog.filter(
        (e) => !installedBundles.has(e.bundleId) && !isBuiltinEnabled(e.id),
      ),
    [catalog, installedBundles, enabledBuiltinIds],
  );

  const hasYours = installed.length > 0 || enabledBuiltins.length > 0;

  // Inline app view — a compact host header (back + title + pop-out) over the
  // shared AppPaneSurface, so the exact same app renders whether it's sized to
  // the rail here or lifted into a full tab.
  if (openKey) {
    const title = appTitleForKey(openKey, installed);
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg-0">
        <div className="flex-shrink-0 flex items-center gap-1.5 px-2 h-9 border-b border-line-soft">
          <button
            type="button"
            onClick={() => setOpenKey(null)}
            title="Back to apps"
            aria-label="Back to apps"
            className="w-7 h-7 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 3.5L5.5 8 10 12.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="text-text-1 text-[12px] font-medium truncate flex-1">
            {title}
          </span>
          <button
            type="button"
            onClick={() => {
              editor.openApp(openKey);
              setOpenKey(null);
            }}
            title="Open as a full editor tab"
            aria-label="Open as a full editor tab"
            className="w-7 h-7 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-bg-2 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M15 3h6v6M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <AppPaneSurface appKey={openKey} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-5 py-4 flex flex-col gap-5">
      <section>
        <SectionHeader title="Your apps" hint="Open here · pop out for room" />
        {!hasYours ? (
          <div className="text-text-4 text-[11.5px] leading-snug max-w-md">
            No apps yet. Enable one from the catalog below, or publish your own
            with{" "}
            <span className="font-mono text-text-3">aura plugin new</span> — a
            plugin that declares{" "}
            <span className="font-mono text-text-3">contributes.apps</span> shows
            up here.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] gap-2">
            {enabledBuiltins.map((b) => (
              <AppTile
                key={`builtin:${b.id}`}
                logo={b.logo}
                title={b.title}
                subtitle="Builtin"
                onOpen={() => openBuiltinInline(b.id)}
              />
            ))}
            {installed.map((app) => (
              <AppTile
                key={`${app.pluginId}:${app.id}`}
                glyph={app.icon ?? "▢"}
                title={app.title}
                subtitle={app.pluginId}
                onOpen={() => openInline(`${app.pluginId}:${app.id}`)}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeader
          title="Worldwide catalog"
          hint="Sandboxed · installs are signed + trust-gated"
        />
        {discover.length === 0 ? (
          <div className="text-text-4 text-[11.5px]">
            You have everything in the catalog. Nice.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-2">
            {discover.map((entry) => (
              <CatalogAppCard
                key={entry.id}
                entry={entry}
                onEnable={() => {
                  enableBuiltin(entry.id);
                  openBuiltinInline(entry.id);
                }}
                onGet={onGetApp}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Friendly title for an open app key, for the inline header. Builtins resolve
 *  from the registry; plugin apps from the live contributes rows; otherwise the
 *  raw key is a safe last resort. */
function appTitleForKey(
  appKey: string,
  installed: ReturnType<typeof pluginApps>,
): string {
  const builtinId = builtinIdFromKey(appKey);
  if (builtinId) return getBuiltinApp(builtinId)?.title ?? builtinId;
  const hit = installed.find((a) => `${a.pluginId}:${a.id}` === appKey);
  return hit?.title ?? appKey;
}

function SectionHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <header className="flex items-baseline justify-between mb-2">
      <span className="text-text-2 text-[12px] font-semibold">{title}</span>
      <span className="text-text-5 text-[10.5px]">{hint}</span>
    </header>
  );
}

/** Small square brand logo, or a glyph in a tinted box as fallback. */
function AppLogo({
  logo,
  glyph,
  size = 22,
}: {
  logo?: string;
  glyph?: string;
  size?: number;
}) {
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        className="rounded-[5px] object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex items-center justify-center rounded-[5px] bg-accent/10 text-accent"
      style={{ width: size, height: size, fontSize: size * 0.6 }}
    >
      {glyph ?? "▢"}
    </span>
  );
}

/** Compact installed/enabled app tile under "Your apps". */
function AppTile({
  logo,
  glyph,
  title,
  subtitle,
  onOpen,
}: {
  logo?: string;
  glyph?: string;
  title: string;
  subtitle: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className="group flex flex-col items-center gap-1.5 rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] hover:bg-bg-2 hover:border-accent/40 px-2 py-2.5 transition-colors text-center"
    >
      <AppLogo logo={logo} glyph={glyph} size={26} />
      <span className="text-text-1 text-[11.5px] font-medium truncate w-full">
        {title}
      </span>
      <span className="text-text-5 text-[9.5px] truncate w-full">
        {subtitle}
      </span>
    </button>
  );
}

/** Compact catalog card — logo + title + one-line tagline + a single CTA. */
function CatalogAppCard({
  entry,
  onEnable,
  onGet,
}: {
  entry: AppCatalogEntry;
  onEnable: () => void;
  onGet: () => void;
}) {
  const builtin = getBuiltinApp(entry.id);
  const ready = !!builtin?.ready;
  // builtin + ready  → Enable (it ships; flip on + open)
  // builtin + !ready → Soon  (real branding, honest disabled state)
  // otherwise        → Get   (route to the signed Exchange)
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] px-2.5 py-2">
      <AppLogo logo={entry.logo} glyph={entry.glyph} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-text-1 text-[12px] font-medium truncate">
            {entry.title}
          </span>
          <span className="text-[9px] text-text-5 bg-bg-1 border border-line-soft rounded px-1 flex-shrink-0">
            {CATEGORY_LABEL[entry.category]}
          </span>
        </div>
        <div
          className="text-text-4 text-[10.5px] leading-snug truncate"
          title={entry.tagline}
        >
          {entry.tagline}
        </div>
      </div>
      {builtin && !ready ? (
        <span
          className="flex-shrink-0 px-2 py-1 text-[10px] rounded bg-bg-1 border border-line-soft text-text-5"
          title="Branding is in; the integration ships soon."
        >
          Soon
        </span>
      ) : (
        <button
          type="button"
          onClick={ready ? onEnable : onGet}
          className="flex-shrink-0 px-2.5 py-1 text-[10.5px] rounded bg-accent/15 hover:bg-accent/25 text-accent transition-colors"
          title={
            ready
              ? "Enable this bundled app"
              : "Install from the Plugin Exchange"
          }
        >
          {ready ? "Enable" : "Get"}
        </button>
      )}
    </div>
  );
}
