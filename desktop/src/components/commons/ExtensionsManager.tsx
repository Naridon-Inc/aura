// Extensions manager — the stateful core behind the Extensions wizard.
//
// Framing: this surface brings *editor add-ons* from the VS Code world (themes,
// language support, snippets, smart code help) into Aura — VS Code is a
// compatibility *source* here, not the way you extend the ADE. Add-ons built
// for Aura itself (skills, MCP servers, agent tools, panels) live in the Aura
// plugin system under Commons → Plugins. See the design Page
// ".aura/notes/team/ade-native-extensions.md".
//
// Audience is non-engineers: lead with what an add-on *does for you* (colors,
// language support, snippets), be honest about what Aura can and can't run, and
// never show gallery/marketplace jargon. Aura reads only an extension's safe,
// declarative parts — its themes, language rules, and snippets — and never runs
// the extension's own program. The heavy lifting (download, jailed extract,
// install index) is the Rust `cmd_vsix` surface; this is the calm face of it.
//
// One stateful component, two views. The wizard mounts it once and flips `view`
// between its tabs, so search results and busy/notice state survive a tab
// switch instead of resetting.

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import { pickPath } from "../../lib/nativeDialog";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  installExtension,
  installExtensionFile,
  removeExtension,
  setExtensionEnabled,
  useInstalledExtensions,
} from "../../lib/vscodeExt/vsixStore";
import type {
  ContributesSummary,
  InstalledExtension,
  OpenVsxHit,
} from "../../lib/vscodeExt/vsixTypes";
import {
  bandTextClass,
  hasActiveSupport,
  kindLabels,
  overallBand,
  whatYouGetLine,
} from "../../lib/vscodeExt/supportLabels";
import { ExtensionRailPanel } from "../rightrail/ExtensionRailPanel";
import { compactNumber } from "../../lib/compactNumber";

export type ExtensionsView = "discover" | "installed";

export function ExtensionsManager({ view }: { view: ExtensionsView }) {
  const installed = useInstalledExtensions();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OpenVsxHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Which installed extension is open in the Installed tab's detail pane.
  // Lifted here (not in InstalledView) so the selection survives a tab flip,
  // matching the manager's "state survives tab switch" contract.
  const [selectedExtId, setSelectedExtId] = useState<string | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const installedIds = new Set(installed.map((e) => e.id));

  // Debounced Open VSX search. An empty query clears results rather than
  // listing the whole gallery — searching is the entry point, not a dump.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      api
        .vsixSearch(q, 24)
        .then((hits) => {
          if (!alive.current || mine !== seq.current) return;
          setResults(hits);
          setError(null);
        })
        .catch((e) => {
          if (!alive.current || mine !== seq.current) return;
          setResults([]);
          setError(friendlyError(e));
        })
        .finally(() => {
          if (alive.current && mine === seq.current) setSearching(false);
        });
    }, 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const install = useCallback(async (hit: OpenVsxHit) => {
    const key = `${hit.namespace}.${hit.name}`;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await installExtension(hit.namespace, hit.name);
      setNotice(`Added ${hit.displayName || hit.name}`);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);

  const installFromFile = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const picked = await pickPath({ title: "Choose a .vsix file" });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      setBusy("file");
      const ext = await installExtensionFile(path);
      setNotice(`Added ${ext.displayName || ext.name}`);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);

  const toggle = useCallback(async (ext: InstalledExtension, on: boolean) => {
    setError(null);
    // Clear any stale "Added X"/"Removed X" notice so it can't read as if this
    // toggle were that earlier action.
    setNotice(null);
    try {
      await setExtensionEnabled(ext.id, on);
    } catch (e) {
      setError(friendlyError(e));
    }
  }, []);

  const remove = useCallback(async (ext: InstalledExtension) => {
    setBusy(`rm:${ext.id}`);
    setError(null);
    setNotice(null);
    try {
      await removeExtension(ext.id);
      setNotice(`Removed ${ext.displayName || ext.name}`);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div
        className={`mx-auto px-6 py-5 flex flex-col gap-4 ${
          view === "installed" ? "max-w-[1040px]" : "max-w-[760px]"
        }`}
      >
        {(error || notice) && (
          <div className="flex flex-col gap-2">
            {error && (
              <div className="text-sm text-red bg-red/10 border border-red/30 rounded px-2.5 py-1.5 leading-snug break-words">
                {error}
              </div>
            )}
            {notice && (
              <div className="text-sm text-accent-green bg-accent-green/10 border border-accent-green/20 rounded px-2.5 py-1.5 leading-snug">
                {notice}
              </div>
            )}
          </div>
        )}

        {view === "discover" ? (
          <DiscoverView
            query={query}
            setQuery={setQuery}
            results={results}
            searching={searching}
            busy={busy}
            installedIds={installedIds}
            onInstall={(h) => void install(h)}
            onInstallFile={() => void installFromFile()}
          />
        ) : (
          <InstalledView
            installed={installed}
            busy={busy}
            selectedExtId={selectedExtId}
            onSelect={setSelectedExtId}
            onToggle={(e, on) => void toggle(e, on)}
            onRemove={(e) => void remove(e)}
          />
        )}
      </div>
    </div>
  );
}

// ── Discover ─────────────────────────────────────────────────────────────────

/** The curated rows a non-engineer can browse without knowing what to type.
 *  `category` is the Open VSX category name (None = overall popular). Labels are
 *  plain-language; we lead with what Aura can actually apply. */
const BROWSE_CATEGORIES: { id: string; label: string; category: string | null }[] =
  [
    { id: "popular", label: "Popular", category: null },
    { id: "themes", label: "Color themes", category: "Themes" },
    { id: "languages", label: "Languages", category: "Programming Languages" },
    { id: "snippets", label: "Snippets", category: "Snippets" },
  ];

// A tiny shared cache + concurrency gate for the pre-install capability preview.
// Each card asks "what would this actually give me?" — two cheap gallery GETs —
// so we de-dupe by id, remember the answer for the session, and never run more
// than a few lookups at once (a browse row is ~18 cards). Lives at module scope
// so it survives tab switches and re-renders.
const previewCache = new Map<string, ContributesSummary | "error">();
const previewInflight = new Map<string, Promise<ContributesSummary>>();
const previewQueue: Array<() => void> = [];
let activePreviews = 0;
const MAX_CONCURRENT_PREVIEWS = 4;

function pumpPreviewQueue() {
  while (activePreviews < MAX_CONCURRENT_PREVIEWS && previewQueue.length > 0) {
    const job = previewQueue.shift();
    if (job) job();
  }
}

function fetchPreview(
  namespace: string,
  name: string,
): Promise<ContributesSummary> {
  const id = `${namespace}.${name}`;
  const cached = previewCache.get(id);
  if (cached && cached !== "error") return Promise.resolve(cached);
  const existing = previewInflight.get(id);
  if (existing) return existing;
  const p = new Promise<ContributesSummary>((resolve, reject) => {
    previewQueue.push(() => {
      activePreviews += 1;
      api
        .vsixPreviewContributes(namespace, name)
        .then((c) => {
          previewCache.set(id, c);
          resolve(c);
        })
        .catch((e) => {
          previewCache.set(id, "error");
          reject(e);
        })
        .finally(() => {
          activePreviews -= 1;
          previewInflight.delete(id);
          pumpPreviewQueue();
        });
    });
  });
  previewInflight.set(id, p);
  pumpPreviewQueue();
  return p;
}

function DiscoverView({
  query,
  setQuery,
  results,
  searching,
  busy,
  installedIds,
  onInstall,
  onInstallFile,
}: {
  query: string;
  setQuery: (q: string) => void;
  results: OpenVsxHit[] | null;
  searching: boolean;
  busy: string | null;
  installedIds: Set<string>;
  onInstall: (hit: OpenVsxHit) => void;
  onInstallFile: () => void;
}) {
  const [catId, setCatId] = useState("popular");
  const [browse, setBrowse] = useState<OpenVsxHit[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const browseSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const isSearching = query.trim().length > 0;

  // Pull the selected category's live list whenever it changes (and we're not
  // in search mode). Cheap, cached at the gallery; the capability chips fetch
  // lazily on top.
  useEffect(() => {
    if (isSearching) return;
    const cat = BROWSE_CATEGORIES.find((c) => c.id === catId) ?? BROWSE_CATEGORIES[0];
    const mine = ++browseSeq.current;
    setBrowsing(true);
    setBrowseError(null);
    api
      .vsixBrowse(cat.category, "downloads", 18)
      .then((hits) => {
        if (!alive.current || mine !== browseSeq.current) return;
        setBrowse(hits);
      })
      .catch((e) => {
        if (!alive.current || mine !== browseSeq.current) return;
        setBrowse([]);
        setBrowseError(friendlyError(e));
      })
      .finally(() => {
        if (alive.current && mine === browseSeq.current) setBrowsing(false);
      });
  }, [catId, isSearching]);

  const grid = isSearching ? results : browse;
  const loading = isSearching ? searching : browsing;

  return (
    <section className="flex flex-col gap-3">
      <p className="text-text-3 text-sm leading-relaxed">
        Bring editor add-ons (color themes, language support, and snippets) 
        from the open VS Code gallery into your workspace. Aura uses only the
        safe parts it can read; it never runs an extension’s own program. For
        add-ons built for Aura itself, see Commons → Plugins.
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a theme or language (e.g. Dracula, Rust)…"
          className="flex-1"
          aria-label="Search extensions"
          autoFocus
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy === "file"}
          onClick={onInstallFile}
          title="Install a .vsix file you already have"
        >
          {busy === "file" ? "Adding…" : "Install from file…"}
        </Button>
      </div>

      {/* Category browse chips — hidden while the user is searching by name. */}
      {!isSearching && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {BROWSE_CATEGORIES.map((c) => {
            const active = c.id === catId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCatId(c.id)}
                className={`h-[26px] px-2.5 rounded-full text-sm font-medium border transition-colors ${
                  active
                    ? "text-white border-transparent"
                    : "text-text-3 border-line-soft hover:bg-state-hover hover:text-text-1"
                }`}
                style={active ? { background: "var(--color-accent)" } : undefined}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-1.5 text-text-4 text-sm py-1">
          <AsciiSpinner />
          {isSearching ? "Searching…" : "Loading…"}
        </div>
      )}

      {browseError && !isSearching && !loading && (
        <div className="text-text-4 text-sm py-1 leading-snug">
          {browseError}
        </div>
      )}

      {isSearching && results && !searching && results.length === 0 && (
        <div className="text-text-4 text-sm py-1 leading-snug">
          Nothing matched “{query.trim()}”. Try a shorter or different word.
        </div>
      )}

      {grid && grid.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {grid.map((hit) => (
            <ExtCard
              key={`${hit.namespace}.${hit.name}`}
              hit={hit}
              installed={installedIds.has(`${hit.namespace}.${hit.name}`)}
              busy={busy === `${hit.namespace}.${hit.name}`}
              onInstall={() => onInstall(hit)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** One extension in the Discover grid. Carries the lazily-fetched, honest
 *  "what you'd actually get" chip so a non-engineer knows before they install
 *  whether it applies (a theme) or just "runs its own program" (unsupported). */
function ExtCard({
  hit,
  installed,
  busy,
  onInstall,
}: {
  hit: OpenVsxHit;
  installed: boolean;
  busy: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="border border-line-soft rounded-md px-3 py-2.5 bg-bg-0 shadow-[var(--shadow-card)] flex items-start gap-3">
      <ExtIcon url={hit.iconUrl} name={hit.displayName || hit.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-text-1 text-base font-medium truncate">
            {hit.displayName || hit.name}
          </span>
          <span className="text-text-4 text-xs tabular-nums flex-shrink-0">
            v{hit.version}
          </span>
        </div>
        <div className="text-text-4 text-xs mt-0.5 truncate font-mono">
          {hit.namespace}
        </div>
        <CapabilityChip hit={hit} />
        {hit.description && (
          <div className="text-text-3 text-sm mt-1 leading-snug line-clamp-2">
            {hit.description}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 mt-1.5">
          {hit.downloadCount > 0 ? (
            <span className="text-text-4 text-xs">
              {compactNumber(hit.downloadCount)} installs
            </span>
          ) : (
            <span />
          )}
          {installed ? (
            <span className="text-text-4 text-xs">Added</span>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={onInstall}
            >
              {busy ? "Adding…" : "Add"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The honest pre-install capability line. Reads the gallery manifest (cached,
 *  rate-gated) and says plainly what Aura would apply — or, for a code-only
 *  extension, that it "runs its own program" and isn't supported. Stays silent
 *  on a lookup failure rather than crying wolf. */
function CapabilityChip({ hit }: { hit: OpenVsxHit }) {
  const id = `${hit.namespace}.${hit.name}`;
  const initial = previewCache.get(id);
  const [summary, setSummary] = useState<ContributesSummary | null>(
    initial && initial !== "error" ? initial : null,
  );
  const [state, setState] = useState<"loading" | "done" | "error">(
    initial && initial !== "error" ? "done" : initial === "error" ? "error" : "loading",
  );

  useEffect(() => {
    if (state === "done" || state === "error") return;
    let live = true;
    fetchPreview(hit.namespace, hit.name)
      .then((c) => {
        if (!live) return;
        setSummary(c);
        setState("done");
      })
      .catch(() => {
        if (live) setState("error");
      });
    return () => {
      live = false;
    };
    // Re-run only when the identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (state === "loading") {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-text-4 text-xs">
        <AsciiSpinner />
        Checking…
      </div>
    );
  }
  if (state === "error" || !summary) return null;

  // The accent is honest: arctic-blue only when Aura applies/runs something
  // today; coming-soon reads muted; not-yet / nothing reads amber. The line
  // itself leads with what's active, or — when nothing is — says plainly what
  // it adds (a debugger, a full program) so the user isn't misled into
  // installing a no-op.
  const band = overallBand(summary);
  const active = hasActiveSupport(summary);
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      <div className={`text-xs leading-snug ${bandTextClass(band)}`}>
        {whatYouGetLine(summary)}
      </div>
      {/* No active contribution → spell it out before they install, so they
          aren't surprised that adding it does nothing here yet. */}
      {!active && (
        <div className="text-text-4 text-xs leading-snug">
          Adding this won’t change anything in Aura yet.
        </div>
      )}
    </div>
  );
}

// ── Installed ────────────────────────────────────────────────────────────────

function InstalledView({
  installed,
  busy,
  selectedExtId,
  onSelect,
  onToggle,
  onRemove,
}: {
  installed: InstalledExtension[];
  busy: string | null;
  selectedExtId: string | null;
  onSelect: (id: string | null) => void;
  onToggle: (ext: InstalledExtension, on: boolean) => void;
  onRemove: (ext: InstalledExtension) => void;
}) {
  if (installed.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <div className="text-text-4 text-sm leading-snug py-2">
          Nothing installed yet. Use the Discover tab to add your first theme or
          language pack.
        </div>
      </section>
    );
  }

  // Resolve the selection against the live list so a removed extension never
  // strands the detail pane; default to the first installed one so the pane is
  // never blank when the user has extensions.
  const selected =
    installed.find((e) => e.id === selectedExtId) ?? installed[0];

  return (
    <section className="flex flex-col gap-3">
      {/* Master (list) + detail (per-kind breakdown). The list stays compact —
          one line per kind — while the detail pane spells out exactly what each
          contribution kind does and whether Aura can run it. */}
      <div className="flex flex-col md:flex-row gap-4 items-start">
        <ul className="flex flex-col gap-2 flex-1 min-w-0 w-full">
          {installed.map((ext) => {
            const labels = kindLabels(ext.contributes);
            const active = labels.some((l) => l.band === "active");
            const isSelected = ext.id === selected.id;
            return (
              <li key={ext.id}>
                <div
                  onClick={() => onSelect(ext.id)}
                  className="border rounded-md px-3 py-2.5 bg-bg-0 shadow-[var(--shadow-card)] flex items-start gap-3 cursor-pointer transition-colors"
                  style={{
                    borderColor: isSelected
                      ? "var(--color-accent)"
                      : "var(--color-line-soft)",
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-text-1 text-base font-medium truncate">
                        {ext.displayName || ext.name}
                      </span>
                      <span className="text-text-4 text-xs tabular-nums flex-shrink-0">
                        v{ext.version}
                      </span>
                      {!ext.enabled && (
                        <span className="text-2xs text-text-4 bg-bg-1 border border-line-soft rounded px-1.5 py-0.5">
                          off
                        </span>
                      )}
                    </div>
                    {/* One honest row per kind: ✓ for what's active, "coming
                        soon"/"not yet" for the kinds Aura can't run. */}
                    {labels.length === 0 ? (
                      <div className="text-text-4 text-sm mt-1 leading-snug">
                        Nothing Aura can use here.
                      </div>
                    ) : (
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {labels.map((l) => (
                          <li
                            key={l.key}
                            className="flex items-baseline gap-1.5 text-sm leading-snug"
                            title={l.tech}
                          >
                            <span className={`flex-shrink-0 ${bandTextClass(l.band)}`}>
                              {l.band === "active" ? "✓" : "•"}
                            </span>
                            <span className={bandTextClass(l.band)}>{l.title}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {active && ext.contributes.hasBrowser && ext.enabled && (
                      <div className="text-text-4 text-xs mt-1 leading-snug">
                        Open the Command Palette (⌘K) and search its name to run it.
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 self-center flex items-center gap-2.5">
                    <Switch
                      checked={ext.enabled}
                      onCheckedChange={(on) => onToggle(ext, on)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={ext.enabled ? "Turn off" : "Turn on"}
                      title={ext.enabled ? "Turn off" : "Turn on"}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy === `rm:${ext.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(ext);
                      }}
                      className="text-text-4 hover:text-red"
                      title="Remove"
                    >
                      {busy === `rm:${ext.id}` ? "Removing…" : "Remove"}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {/* Detail pane: the full per-kind story for the selected extension. */}
        <div className="w-full md:w-[320px] md:flex-shrink-0 md:sticky md:top-0 border border-line-soft rounded-md overflow-hidden h-[420px]">
          <ExtensionRailPanel ext={selected} />
        </div>
      </div>

      <p className="text-text-4 text-xs leading-relaxed mt-1 border-t border-line-soft pt-3">
        Language rules and snippets apply to the editor automatically. To switch
        to a color theme you installed, open{" "}
        <span className="text-text-3">Settings → Editor Themes</span> and pick it
        under “From your extensions.” Extensions that ship a web program run
        right here. Find their commands in the Command Palette (⌘K). Ones that
        need the full desktop VS Code app. Most debuggers and language servers. 
        can’t run here, and Microsoft-only extensions can’t be used outside VS
        Code. Everything here comes from the open Open&nbsp;VSX gallery.
      </p>
    </section>
  );
}

/** Small square icon for a gallery hit; falls back to a monogram tile when the
 *  extension ships no icon or the image fails to load. */
function ExtIcon({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        onError={() => setFailed(true)}
        className="w-9 h-9 rounded flex-shrink-0 object-cover bg-bg-1"
      />
    );
  }
  return (
    <div className="w-9 h-9 rounded flex-shrink-0 bg-bg-1 border border-line-soft flex items-center justify-center text-text-3 text-base font-semibold">
      {(name[0] ?? "?").toUpperCase()}
    </div>
  );
}

/** Turn raw Rust/transport error strings into one calm sentence. */
function friendlyError(e: unknown): string {
  const s = String(e ?? "").trim();
  if (!s) return "Something went wrong. Please try again.";
  if (/network|dns|timed out|connect|reqwest/i.test(s)) {
    return "Couldn’t reach the extension gallery. Check your connection and try again.";
  }
  if (/not found|404|no such/i.test(s)) {
    return "That extension isn’t on the open gallery (Open VSX).";
  }
  return s.replace(/^error:\s*/i, "").slice(0, 200);
}
