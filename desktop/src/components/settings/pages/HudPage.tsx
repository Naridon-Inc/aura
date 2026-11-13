import { Button } from "../../ui/button";
import { api } from "../../../lib/api";
import { setHudPref, useHudPrefs } from "../../../lib/settingsStore";
import type { HudPresentationMode } from "../../../lib/hud";
import { SettingsEmpty, SettingsIntro } from "../../ui/settings-blocks";
import { Row, ChoiceSelect, Stepper, Toggle } from "../kit";

// ── Floating HUD (⌃⌘A) ────────────────────────────────────────────────
//
// The HUD's shape is a personal preference: the bottom-center Capsule, a
// right-edge Sidebar that lives as a FAB, or a chromeless Minimal ("nerd")
// overlay. Mode + opacity persist in `~/.aura/settings.toml` via `setHudPref`
// and apply LIVE (no relaunch) — the setter pushes to the native window AND
// broadcasts `hud:settings` so a summoned HUD restyles itself instantly.
export function HudPage() {
  const hud = useHudPrefs();
  // Opacity is stored as a 0.2–1.0 fraction but tuned as a friendlier percent.
  const opacityPct = Math.round(hud.opacity * 100);
  // Everything past Availability shapes a window that, with the HUD off,
  // cannot appear — the enable row says so itself: "⌃⌘A and the menu-bar
  // icon do nothing and the HUD stays hidden". The Show HUD button was
  // already gated on this; the pet, the presentation and the sizes were not,
  // so the pane sat there taking settings for something that wasn't there.
  const off = !hud.enabled;
  return (
    <>
      <SettingsIntro>The always-on-top glance summoned with ⌃⌘A. Changes apply live.</SettingsIntro>
      <Toggle
        label="Enable the floating HUD"
        hint="When off, ⌃⌘A and the menu-bar icon do nothing and the HUD stays hidden. This sticks across restarts."
        value={hud.enabled}
        onChange={(v) => setHudPref("enabled", v)}
      />
      {off && (
        <SettingsEmpty>
          The HUD is off, so the rest of this page has nothing to change
          yet. Turn it on to shape it.
        </SettingsEmpty>
      )}
      <Toggle
        label="Desk pet"
        hint="A little companion perches on the HUD and reacts to what your agents are doing. Reading while they think, working while they edit, a hop when a task finishes."
        value={hud.pet}
        onChange={(v) => setHudPref("pet", v)}
        disabled={off}
      />
      <Row
        label="Presentation"
        description="Capsule sits bottom-center · Sidebar docks right as a panel · Minimal drops the glass."
      >
        <ChoiceSelect<HudPresentationMode>
          label="Presentation"
          value={hud.mode as HudPresentationMode}
          options={[
            { value: "capsule", label: "Capsule" },
            { value: "sidebar", label: "Sidebar" },
            { value: "minimal", label: "Minimal" },
            // Ambient is hidden from the list but still drawn for anyone who
            // picked it before; name it while it is in use rather than blank.
            ...(hud.mode === "ambient" ? [{ value: "ambient" as const, label: "Ambient" }] : []),
          ]}
          onChange={(next) => setHudPref("mode", next)}
          disabled={off}
        />
      </Row>
      <Row
        label="Opacity"
        description="How much of the screen behind shows through. Below about half the HUD reads as a ghost."
      >
        <Stepper
          label="Opacity"
          value={opacityPct}
          onChange={(pct) => setHudPref("opacity", pct / 100)}
          min={20}
          max={100}
          step={5}
          suffix="%"
          disabled={off}
        />
      </Row>
      {hud.mode === "sidebar" && (
        <>
          <Row label="Sidebar width" description="Panel width when the sidebar is open.">
            <Stepper
              label="Sidebar width"
              value={Math.round(hud.sidebar_width)}
              onChange={(px) => setHudPref("sidebar_width", px)}
              min={240}
              max={480}
              step={10}
              suffix="px"
              disabled={off}
            />
          </Row>
          <Row label="Sidebar height" description="How far down the screen edge the panel runs.">
            <Stepper
              label="Sidebar height"
              value={Math.round(hud.sidebar_height)}
              onChange={(px) => setHudPref("sidebar_height", px)}
              min={320}
              max={900}
              step={20}
              suffix="px"
              disabled={off}
            />
          </Row>
        </>
      )}
      <Row
        label="Show the HUD"
        description="Summon it to see the current shape (also ⌃⌘A anytime)."
      >
        <Button
          size="sm"
          variant="outline"
          disabled={!hud.enabled}
          onClick={() => void api.hudShow()}
        >
          Show HUD
        </Button>
      </Row>
    </>
  );
}
