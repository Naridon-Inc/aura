import { Button } from "../../ui/button";
import { ZOOM_MAX, ZOOM_MIN, useZoomLevel, zoomPercent } from "../../../lib/zoomStore";
import {
  setThemePreference,
  isDarkOnlyVariant,
  setThemeVariant,
  useThemePreference,
  useThemeVariant,
  // AURA-1298
  setThemeContrast,
  useResolvedTheme,
  useThemeContrast,
  type ThemePreference,
  type ThemeVariant,
} from "../../../lib/themeStore";
import {
  defaultTerminalFontSize,
  setFontSize,
  setTerminalFontSize,
  useFontSize,
  useTerminalPrefs,
} from "../../../lib/settingsStore";
import { SettingsActions } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import { Slider } from "../../ui/slider";
import { Row, ChoiceSelect, Stepper, Toggle } from "../kit";

// Below 9px terminal text stops being legible on a non-retina display, and
// past 20px an 80-column line no longer fits a half-width pane.
const TERMINAL_FONT_MIN = 9;
const TERMINAL_FONT_MAX = 20;

export function AppearancePage() {
  const theme = useThemePreference();
  const variant = useThemeVariant();
  const terminalSize = useTerminalPrefs().font_size ?? defaultTerminalFontSize();
  // Some packs ship dark-only palettes — picking light/system would be a
  // silent no-op (useResolvedTheme pins them to dark), so disable the
  // color-scheme picker and say why instead of letting it lie. Asked of
  // themeStore rather than restated here: this list was hand-copied and had
  // drifted to include Amber, which ships a real light palette — so light
  // mode was unreachable on the one pack everybody is on.
  const schemeDisabled = isDarkOnlyVariant(variant);
  // AURA-1298 — zoom is the same level ⌘+ / ⌘− move; contrast only has an
  // effect in dark, so the row says so instead of silently doing nothing.
  const [zoom, setZoom] = useZoomLevel();
  const contrast = useThemeContrast();
  const resolved = useResolvedTheme();
  const contrastInert = resolved !== "dark";
  return (
    <>
      <Row
        label="Theme"
        description="Choose your preferred appearance. System follows macOS and switches with it."
        hint={schemeDisabled ? "This style ships dark-only." : undefined}
      >
        <ChoiceSelect<ThemePreference>
          label="Theme"
          value={schemeDisabled ? "dark" : theme}
          disabled={schemeDisabled}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(next) => {
            if (schemeDisabled) return;
            setThemePreference(next);
          }}
        />
      </Row>
      {/* AURA-1298 */}
      <Toggle
        label="Low-contrast dark mode"
        hint={
          contrastInert
            ? "Only affects dark mode; you are in light right now."
            : "A little less white on black, for long sessions or dim rooms."
        }
        value={contrast === "low"}
        onChange={(on) => setThemeContrast(on ? "low" : "normal")}
      />
      {/* AURA-1298 */}
      <Row
        label="Zoom level"
        description="Makes everything in the window bigger or smaller. ⌘+ and ⌘− do the same thing; ⌘0 puts it back."
      >
        <SettingsActions>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setZoom(1)}
            disabled={zoomPercent(zoom) === 100}
          >
            Reset
          </Button>
          <Stepper
            label="Zoom level"
            value={zoomPercent(zoom)}
            onChange={(pct) => setZoom(pct / 100)}
            min={Math.round(ZOOM_MIN * 100)}
            max={Math.round(ZOOM_MAX * 100)}
            step={10}
            suffix="%"
          />
        </SettingsActions>
      </Row>
      {/* The terminal's size used to be compiled in, 12 on mac and 14
          elsewhere, with nowhere to change it. It covers the panes agents run
          in too, and never-set means the renderer's own default. */}
      <SettingsRow
        title="Terminal Font Size"
        description={`${terminalSize}px`}
        control={
          <Slider
            aria-label="Terminal font size"
            min={TERMINAL_FONT_MIN}
            max={TERMINAL_FONT_MAX}
            step={1}
            value={[terminalSize]}
            onValueChange={([value]) => setTerminalFontSize(value)}
          />
        }
      >
        <pre className="ui-settings-terminal-sample" style={{ fontSize: terminalSize }}>
          {"~/project main ±3 ?2 ❯ npm test\n✓ All tests passed!"}
        </pre>
      </SettingsRow>
    </>
  );
}

/** Appearance's rarer rows, drawn in its Advanced: the app's palette and the
 *  code editor's type size. */
export function AppearanceStyleRows() {
  const variant = useThemeVariant();
  const fontSize = useFontSize();
  return (
    <>
      <Row
        label="Style"
        description="The palette the whole app is painted from — window chrome, sidebar, chat and terminal all follow it."
      >
        <ChoiceSelect<ThemeVariant>
          label="Style"
          value={variant}
          options={[
            // No "Default" row: it named the pre-redesign palette, and
            // readVariant has resolved it to Amber for as long as there has
            // been one shell — so picking it did nothing.
            { value: "amber", label: "Amber" },
            { value: "emerald", label: "Aura emerald" },
            { value: "modal", label: "Modal" },
            // Ember is no longer offered, but an earlier version saved it for
            // many people and it still paints; name it while it is the one in
            // use, or the select reads blank over a palette that is on screen.
            ...(variant === "ember" ? [{ value: "ember" as const, label: "Ember" }] : []),
          ]}
          onChange={setThemeVariant}
        />
      </Row>
      <Row
        label="Editor font size"
        description="Type size in the code editor and in diffs. Terminals have their own size."
      >
        <Stepper
          label="Editor font size"
          value={fontSize}
          onChange={(n) => setFontSize(n)}
          min={11}
          max={16}
          suffix="px"
        />
      </Row>
    </>
  );
}
