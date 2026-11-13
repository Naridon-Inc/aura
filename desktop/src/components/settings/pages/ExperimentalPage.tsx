import { useState } from "react";
import {
  setSidebarGlass,
  sidebarGlassAvailable,
  sidebarGlassEnabled,
} from "../../../lib/sidebarGlass";
import { setFlag, useFlagPrefs } from "../../../lib/settingsStore";
import { Toggle } from "../kit";

// Only switches something reads live here. Review changes and the proof trail
// open from /inspect and /replay whatever a switch says, and a task with its
// own files already gets its own copy of the repository, so a switch for any
// of the three would change nothing.
export function ExperimentalPage() {
  const flags = useFlagPrefs();
  const [glass, setGlass] = useState(sidebarGlassEnabled);
  return (
    <>
      <Toggle
        label="Show token savings"
        hint="A small estimate of the tokens Aura saved on each reply by using its code map instead of reading whole files. An estimate, not an exact count."
        value={flags.show_token_savings}
        onChange={(v) => setFlag("show_token_savings", v)}
      />
      <Toggle
        label="Show token usage per message"
        hint="Under each reply, show the input and output tokens that message actually used, straight from the model."
        value={flags.show_message_tokens}
        onChange={(v) => setFlag("show_message_tokens", v)}
      />
      {sidebarGlassAvailable() ? (
        <Toggle
          label="Sidebar transparency"
          hint="Let your desktop softly blur through the sidebar. Off gives it a plain solid background."
          value={glass}
          onChange={(v) => {
            setGlass(v);
            setSidebarGlass(v);
          }}
        />
      ) : null}
    </>
  );
}
