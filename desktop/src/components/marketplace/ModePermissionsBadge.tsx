// Permissions badge — surfaces the "advanced" tools a mode opts into
// (shell.exec, fs.delete, net.fetch, git.commit). Renders as a row of
// small pills next to the mode card title; clicking shows a tooltip
// with the full ACL.
//
// Why a dedicated component? The install sheet and the installed pane
// both need the same affordance, and the "this mode wants shell
// access" warning is load-bearing for trust — it should look identical
// everywhere it appears.

import { ShieldAlert } from "lucide-react";

import type { ToolAcl } from "../../lib/api";

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
      <span
        className="inline-flex items-center gap-1 rounded-full bg-bg-2 px-2 py-0.5 text-2xs text-text-3"
        title="No advanced tools. This mode cannot exec shell commands or modify state"
      >
        Safe
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-amber/10 px-2 py-0.5 text-2xs text-amber"
      title={`Advanced tools requested: ${wanted.join(", ")}`}
    >
      <ShieldAlert className="h-3 w-3" />
      Advanced ({wanted.length})
    </span>
  );
}

export { RESERVED_TOOLS };
