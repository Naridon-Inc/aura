// Moved to aura-shared/ui/intentProse — one source for the desktop app and
// the web console, so a session's "what happened" reads identically in both.
// This file stays as the local address, and as the one Tauri-specific
// binding: a markdown link inside a Tauri webview must open in the system
// browser, so IntentProse here arrives with onExternalAnchorClick pre-wired.
// Everything else passes through untouched.

import type { ComponentProps } from "react";

import { onExternalAnchorClick } from "../../lib/openExternal";
import { IntentProse as SharedIntentProse } from "@shared/ui/intentProse";

export { splitIntent, InlineEntities } from "@shared/ui/intentProse";

export function IntentProse(
  props: Omit<ComponentProps<typeof SharedIntentProse>, "onAnchorClick">,
) {
  return <SharedIntentProse {...props} onAnchorClick={onExternalAnchorClick} />;
}
