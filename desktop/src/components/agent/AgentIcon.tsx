// The Tauri-side face of the shared AgentIcon: everything moved to
// aura-shared/ui/agentIcon.tsx; this file binds the app's resolved theme so
// the shell's dozens of call sites keep their one-line import.
import type { ComponentProps } from "react";
import { useResolvedTheme } from "../../lib/themeStore";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { SharedUiProvider } from "@shared/ui/appContext";
import { AgentIcon as SharedAgentIcon } from "@shared/ui/agentIcon";

export {
  brandFor,
  type AgentBrand,
  type AgentRunState,
} from "@shared/ui/agentIcon";

export function AgentIcon(props: ComponentProps<typeof SharedAgentIcon>) {
  const theme = useResolvedTheme();
  return (
    <SharedUiProvider value={{ theme, onAnchorClick: onExternalAnchorClick }}>
      <SharedAgentIcon {...props} />
    </SharedUiProvider>
  );
}
