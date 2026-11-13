import { useState } from "react";
import { Button } from "../../ui/button";
import { SettingsRow } from "../../ui/settings-row";
import { api } from "../../../lib/api";
import {
  completionSoundEnabled,
  setCompletionSoundEnabled,
  playCompletionChime,
} from "../../../lib/completionChime";
import { isChimeMuted, setChimeMuted, playChime } from "../../../lib/chime";
import {
  setMentionAlerts,
  setShowOnline,
  useMentionAlerts,
  usePokes,
  useShowOnline,
} from "../../../lib/cloudTeamPrefs";
import { setPokes } from "../../cloudplace/cloudPokes";
import { setEditorPref, useEditorPrefs } from "../../../lib/settingsStore";
import {
  readFollowUpBehavior,
  writeFollowUpBehavior,
  type FollowUpBehavior,
} from "../../../lib/followUpBehavior";
import { ChoiceSelect, Toggle } from "../kit";

type CompletionSound = "chime" | "none";

// Full disk access is a macOS privacy pane; other platforms have no
// equivalent prompt to skip, so the row only shows on a Mac.
const ON_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

export function GeneralPage() {
  // Completion sound is backed by completionChime's own pref helpers (the
  // stored value is "on"/"off", distinct from settingsStore's prefs), so
  // the chime and this control always read the same flag.
  const [sound, setSound] = useState<CompletionSound>(
    completionSoundEnabled() ? "chime" : "none",
  );
  // Follow-up behavior lives in its own localStorage pref (composer UX, not a
  // durable TOML setting) — read once here and write through the helper, which
  // also live-notifies any open composer.
  const [followUp, setFollowUp] = useState<FollowUpBehavior>(readFollowUpBehavior);
  return (
    <>
      <SettingsRow
        title="Follow-up behavior"
        description="Queue messages after the agent finishes, or steer the current turn."
        help="⌘↵ always steers, whichever option is set here."
        control={
          <ChoiceSelect<FollowUpBehavior>
            label="Follow-up behavior"
            value={followUp}
            options={[
              { value: "queue", label: "Queue" },
              { value: "steer", label: "Steer" },
            ]}
            onChange={(v) => {
              setFollowUp(v);
              writeFollowUpBehavior(v);
            }}
          />
        }
      />
      <SettingsRow
        title="Completion sound"
        description="Choose the sound for completed work."
        control={
          <ChoiceSelect<CompletionSound>
            label="Completion sound"
            value={sound}
            options={[
              { value: "chime", label: "Chime" },
              { value: "none", label: "None" },
            ]}
            onChange={(v) => {
              const on = v === "chime";
              setCompletionSoundEnabled(on);
              setSound(v);
              if (on) playCompletionChime();
            }}
          />
        }
      />
      {ON_MAC && (
        <SettingsRow
          title="Full disk access permissions"
          description="To let agents work without repeated folder permission prompts."
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void api.openMacosPrivacyPane("Privacy_AllFiles")}
            >
              Open System Settings
            </Button>
          }
        />
      )}
    </>
  );
}

/** General's rarer switches: team sounds and the code editor, drawn in its Advanced. */
export function GeneralEditorRows() {
  const editor = useEditorPrefs();
  // Message & huddle sounds share one mute flag (chime.ts), which also gates
  // the OS notification's system sound so "off" is silent on every path.
  const [msgSound, setMsgSound] = useState(!isChimeMuted());
  const mentionAlerts = useMentionAlerts();
  const showOnline = useShowOnline();
  const pokes = usePokes();
  const [pokesProblem, setPokesProblem] = useState("");
  return (
    <>
      <Toggle
        label="Cloud @mention alerts"
        hint="Tell me when a teammate @mentions me in a cloud workspace, even while I'm elsewhere in Aura."
        value={mentionAlerts}
        onChange={setMentionAlerts}
      />
      <Toggle
        label="Show teammates I'm online"
        hint="Let my organization see when I'm in Aura and which cloud workspace I have open. Off, they stop seeing me within two minutes."
        value={showOnline}
        onChange={setShowOnline}
      />
      <Toggle
        label="Pokes"
        hint={pokesProblem || "Poke teammates in cloud organizations, and get poked."}
        value={pokes}
        onChange={(v) => {
          setPokesProblem("");
          setPokes(v).catch((e: unknown) => setPokesProblem(e instanceof Error ? e.message : String(e)));
        }}
      />
      <Toggle
        label="Message & huddle sounds"
        hint="Play a soft chime for new team messages and huddles. Off also silences the system notification sound."
        value={msgSound}
        onChange={(v) => {
          setChimeMuted(!v);
          setMsgSound(v);
          if (v) playChime("message");
        }}
      />
      <Toggle
        label="Vim keybindings"
        hint="Edit with Vim key motions. Takes effect on the next file you open."
        value={editor.vim}
        onChange={(v) => setEditorPref("vim", v)}
      />
      <Toggle
        label="Minimap"
        hint="A zoomed-out map of the file on the right edge. Always off for very large files."
        value={editor.minimap}
        onChange={(v) => setEditorPref("minimap", v)}
      />
      <Toggle
        label="Sticky scroll"
        hint="Keep the current section's header pinned at the top as you scroll past it."
        value={editor.sticky_scroll}
        onChange={(v) => setEditorPref("sticky_scroll", v)}
      />
      <Toggle
        label="Indent guides"
        hint="Faint vertical lines marking indentation depth."
        value={editor.indent_guides}
        onChange={(v) => setEditorPref("indent_guides", v)}
      />
    </>
  );
}
