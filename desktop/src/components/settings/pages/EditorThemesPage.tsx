import { useRef, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  SettingsActions,
  SettingsEmpty,
  SettingsError,
  SettingsIntro,
  SettingsStatusLine,
} from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import {
  applyPresetTheme,
  importThemeFromText,
  removeTheme,
  setActiveTheme,
  setApplyChrome,
  useActiveVsCodeTheme,
  useApplyChrome,
  useVsCodeThemes,
} from "../../../lib/vscodeThemesStore";
import { THEME_PRESETS } from "../../../lib/vscodeThemePresets";
import type { ConvertedTheme } from "../../../lib/vscodeTheme";
import { onExternalAnchorClick } from "../../../lib/openExternal";

// ── Editor Themes (VS Code theme import) ──────────────────────────────
//
// The first concrete slice of the "plugins like a VS Code extension system"
// track: import a VS Code color theme (`*-color-theme.json`) and apply it to
// the Monaco file editor — optionally reskinning the whole app chrome from its
// palette. Parsing + conversion live in `lib/vscodeTheme.ts`; persistence +
// Monaco registration in `lib/vscodeThemesStore.ts`. This pane is just the face.

/** A few representative colors from a converted theme, for the preview chips.
 *  Monaco rule foregrounds are stored without a leading `#`; re-add it.
 *  Accepts any `ConvertedTheme` (presets) or `StoredVsTheme` (imports). */
/** Where "Find themes on the VS Code Marketplace" goes. Pre-filtered to the
 *  Themes category and sorted by installs, because the thing this pane can
 *  actually consume is a color theme's JSON, not any extension. */
const MARKETPLACE_THEMES_URL =
  "https://marketplace.visualstudio.com/search?target=VSCode&category=Themes&sortBy=Installs";

function themeSwatches(t: ConvertedTheme): string[] {
  const colors = t.monaco.colors ?? {};
  const ruleColor = (token: string): string | undefined => {
    const r = t.monaco.rules.find((x) => x.token === token && x.foreground);
    return r?.foreground ? `#${r.foreground}` : undefined;
  };
  const accent = t.cssVars["--color-accent"] ?? "#888888";
  return [
    colors["editor.background"] ?? "#000000",
    colors["editor.foreground"] ?? "#ffffff",
    ruleColor("keyword") ?? ruleColor("storage") ?? accent,
    ruleColor("string") ?? colors["editor.foreground"] ?? "#ffffff",
    ruleColor("comment") ?? "#888888",
  ];
}

function ThemeSwatchRow({ colors }: { colors: string[] }) {
  return (
    <span className="ui-settings-swatches" aria-hidden="true">
      {colors.map((c, i) => (
        <span key={i} style={{ background: c }} title={c} />
      ))}
    </span>
  );
}

export function EditorThemesPage() {
  const themes = useVsCodeThemes();
  const active = useActiveVsCodeTheme();
  const applyChrome = useApplyChrome();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [paste, setPaste] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function doImport(text: string) {
    setError(null);
    setNote(null);
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Nothing to import. Pick a file or paste theme JSON.");
      return;
    }
    try {
      const imported = importThemeFromText(trimmed, Date.now());
      setActiveTheme(imported.id);
      setNote(`Imported and activated “${imported.name}”.`);
      setPaste("");
      setShowPaste(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      doImport(await file.text());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <SettingsIntro>Import a VS Code color theme and apply it to the code editor.</SettingsIntro>
      <SettingsSection
        title="Import a theme"
        description={
          <>
            Find themes on the{" "}
            {/* Anything that leaves the app has to go through
                `openExternal`; a bare `target="_blank"` is a no-op in the
                webview. */}
            <a href={MARKETPLACE_THEMES_URL} onClick={onExternalAnchorClick}>
              VS Code Marketplace
            </a>{" "}
            or any extension's <code>themes/*.json</code>. Syntax colors and
            editor chrome are mapped onto the editor; this matches the common
            token scopes, not every grammar-specific rule.
          </>
        }
      >
        <SettingsRow
          title="Theme file"
          description="A *-color-theme.json from a VS Code extension."
          control={
            <SettingsActions>
              <Button size="sm" variant="ghost" onClick={() => setShowPaste((v) => !v)}>
                {showPaste ? "Hide paste" : "Paste JSON"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload size={14} />
                Import theme file…
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.jsonc,application/json"
                hidden
                onChange={onFile}
              />
            </SettingsActions>
          }
        >
          {showPaste ? (
            <div className="ui-settings-paste">
              <Textarea
                aria-label="Theme JSON"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                spellCheck={false}
                placeholder="Paste the contents of a *-color-theme.json here…"
              />
              <SettingsActions>
                <Button size="sm" onClick={() => doImport(paste)}>
                  Import pasted theme
                </Button>
              </SettingsActions>
            </div>
          ) : null}
        </SettingsRow>
        {note && <SettingsStatusLine text={note} />}
        {error && <SettingsError>{error}</SettingsError>}
      </SettingsSection>

      <SettingsSection
        title="Built-in presets"
        description="Popular published palettes, ready to apply. No download needed. Each is run through the same converter as an imported file, and applying one adds it to your themes below."
      >
        {THEME_PRESETS.map((p) => {
          const isActive = active?.name === p.name;
          return (
            <SettingsRow
              key={p.name}
              title={p.name}
              description={p.isDark ? "Dark" : "Light"}
              control={
                <SettingsActions>
                  <ThemeSwatchRow colors={themeSwatches(p)} />
                  {isActive ? (
                    <Badge variant="highlight">Active</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setError(null);
                        setNote(null);
                        applyPresetTheme(p, Date.now());
                        setNote(`Applied “${p.name}”.`);
                      }}
                    >
                      Apply
                    </Button>
                  )}
                </SettingsActions>
              }
            />
          );
        })}
      </SettingsSection>

      {/* Titled "Active theme" until it was read on screen: the heading sat
          over eight rows, seven of them carrying an Activate button and a
          delete. It is the library — one row of it happens to be active. */}
      <SettingsSection title="Your themes">
        <ThemeChoiceRow
          name="Aura default"
          detail="GitHub-matched dark / light"
          swatches={["#0d1117", "#f0f6fc", "#ff7b72", "#a5d6ff", "#8b949e"]}
          active={active === null}
          onActivate={() => setActiveTheme(null)}
        />
        {themes.map((t) => (
          <ThemeChoiceRow
            key={t.id}
            name={t.name}
            detail={t.isDark ? "Dark" : "Light"}
            swatches={themeSwatches(t)}
            active={active?.id === t.id}
            onActivate={() => setActiveTheme(t.id)}
            onRemove={() => removeTheme(t.id)}
          />
        ))}
        {themes.length === 0 && (
          <SettingsEmpty>No imported themes yet. Import one above to get started.</SettingsEmpty>
        )}
      </SettingsSection>

      <SettingsSection title="Scope">
        <SettingsRow
          title="Also reskin the whole app"
          description="Apply the active theme's palette to Aura's chrome, not just the code editor. Turn off to keep the editor themed but the app on its own colors."
          help={
            applyChrome && active === null
              ? "No imported theme is active, so this has no effect yet."
              : undefined
          }
          control={
            <Switch
              aria-label="Also reskin the whole app"
              checked={applyChrome}
              onCheckedChange={setApplyChrome}
            />
          }
        />
      </SettingsSection>
    </>
  );
}

function ThemeChoiceRow({
  name,
  detail,
  swatches,
  active,
  onActivate,
  onRemove,
}: {
  name: string;
  detail: string;
  swatches: string[];
  active: boolean;
  onActivate: () => void;
  onRemove?: () => void;
}) {
  return (
    <SettingsRow
      title={name}
      description={detail}
      control={
        <SettingsActions>
          <ThemeSwatchRow colors={swatches} />
          {active ? (
            <Badge variant="highlight">Active</Badge>
          ) : (
            <Button size="sm" variant="outline" onClick={onActivate}>
              Activate
            </Button>
          )}
          {onRemove && (
            <Button
              size="iconSm"
              variant="ghost"
              aria-label={`Remove ${name}`}
              onClick={onRemove}
            >
              <Trash2 size={14} />
            </Button>
          )}
        </SettingsActions>
      }
    />
  );
}
