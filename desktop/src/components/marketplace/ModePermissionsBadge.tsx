// Permissions badge — surfaces the "advanced" tools a mode opts into
// (shell.exec, fs.delete, net.fetch, git.commit). Renders as a
// small badge next to the mode's name; hovering it lists the full ACL.
//
// Why a dedicated component? The install sheet and the installed pane
// both need the same affordance, and the "this mode wants shell
// access" warning is load-bearing for trust — it should look identical
// everywhere it appears.

import { ShieldAlert } from "lucide-react";

import type { ToolAcl } from "../../lib/api";
import { Badge } from "../ui/badge";

// Subset of CANONICAL_TOOLS the Rust validator marks as RESERVED. The
// validator is the source of truth; this list mirrors it so the UI
// can render the badge without a round-trip. Keep in sync with
// `aura-shell/src-tauri/src/manager/modes/validate.rs::RESERVED_TOOLS`.
const RESERVED_TOOLS = new Set([
  "shell.exec",
  "shell.spawn",
  "net.fetch",
  "fs.delete",
  "git.commit",
]);

type Props = {
  toolAcl: ToolAcl;
  /** When true, the badge renders even if no reserved tools are wanted
   *  (shows a green "Safe" pill instead). */
  showSafe?: boolean;
};

export function ModePermissionsBadge({ toolAcl, showSafe = false }: Props) {
  const advancedWanted = new Set<string>();
  for (const t of toolAcl.allow) if (RESERVED_TOOLS.has(t)) advancedWanted.add(t);
  for (const t of toolAcl.advanced) if (RESERVED_TOOLS.has(t)) advancedWanted.add(t);
  const wanted = Array.from(advancedWanted).sort();

  if (wanted.length === 0) {
    if (!showSafe) return null;
    return (
      <Badge
        variant="secondary"
        title="No advanced tools. This mode cannot exec shell commands or modify state"
      >
        safe
      </Badge>
    );
  }

  return (
    <Badge variant="destructive" title={`Advanced tools requested: ${wanted.join(", ")}`}>
      <ShieldAlert size={12} aria-hidden />
      advanced ({wanted.length})
    </Badge>
  );
}

export { RESERVED_TOOLS };
