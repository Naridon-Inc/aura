import { useEffect, useState } from "react";
import { Select } from "../../ui/select";
import { SettingsRow } from "../../ui/settings-row";
import { api, type TerminalProfile } from "../../../lib/api";
import {
  isNativeTerminalEnabled,
  setNativeTerminalEnabled,
} from "../../../lib/nativeTerminalStore";
import { setScrollback, setTerminalBool, useTerminalPrefs } from "../../../lib/settingsStore";
import { Stepper, Toggle } from "../kit";

// Scrollback is lines per open tab; below a thousand a single build log
// scrolls out of reach, and past a hundred thousand one tab holds tens of
// megabytes of history.
const SCROLLBACK_MIN = 1000;
const SCROLLBACK_MAX = 100000;

export function TerminalPage() {
  const terminal = useTerminalPrefs();
  // Read once on mount, the way the sidebar-glass toggle does: the engine is
  // resolved per terminal mount rather than subscribed to, so there is no
  // store to watch and nothing else can change it behind this pane's back.
  const [gpu, setGpu] = useState(isNativeTerminalEnabled);
  // Profiles + the persisted default live backend-side
  // (`cmd_terminal_profiles`, auto-seeded from `/etc/shells` + `$SHELL`),
  // not in the localStorage settings store — so this loads them directly
  // and writes the choice through the same command the `+` menu uses.
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([api.terminalProfileList(), api.terminalProfileDefault()])
      .then(([list, def]) => {
        if (!alive) return;
        setProfiles(list);
        setDefaultProfileId(def ?? list[0]?.id ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  function selectDefault(id: string) {
    setDefaultProfileId(id);
    api.terminalProfileSetDefault(id).catch(() => {});
  }
  return (
    <>
      {/* The `+` menu that opens these has always called them Shells and
          "Choose the Default Shell", and "profile" already means a git
          identity and an agent HOME on the Account page. `TerminalProfile`
          stays the type's name; on screen it is a shell. */}
      <SettingsRow
        title="Default shell"
        description="The shell every new terminal tab opens with."
        control={
          profiles.length > 0 ? (
            <Select
              value={defaultProfileId ?? ""}
              onChange={selectDefault}
              options={profiles.map((p) => ({ value: p.id, label: p.name }))}
              aria-label="Default shell"
              align="end"
            />
          ) : (
            <span className="ui-settings-status">No shells found</span>
          )
        }
      />
      <SettingsRow
        title="Scrollback"
        description="Number of lines retained in terminal history."
        control={
          <Stepper
            label="Scrollback"
            value={terminal.scrollback}
            onChange={(n) => setScrollback(n)}
            min={SCROLLBACK_MIN}
            max={SCROLLBACK_MAX}
            step={1000}
          />
        }
      />
      <Toggle
        label="Cursor blink"
        hint="Blink the cursor in terminal panes."
        value={terminal.cursor_blink}
        onChange={(v) => setTerminalBool("cursor_blink", v)}
      />
      <Toggle
        label="Bell"
        hint="Play the system bell when a program asks for it."
        value={terminal.bell}
        onChange={(v) => setTerminalBool("bell", v)}
      />
      {/* A pane whose GPU surface fails to start drops itself back to the
          in-page renderer automatically; this is for the user who would
          rather it didn't try. */}
      <Toggle
        label="GPU rendering"
        hint="Draw terminals with Aura's native GPU engine instead of the in-page one. Takes effect for terminals opened from now on."
        value={gpu}
        onChange={(v) => {
          setGpu(v);
          setNativeTerminalEnabled(v);
        }}
      />
    </>
  );
}
