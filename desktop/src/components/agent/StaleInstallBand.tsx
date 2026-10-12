// The one line a terminal grows when the CLI inside it cannot update itself.
//
// An agent surface has no header, and this does not put one back — it is the
// same bargain `SharedSessionBand` makes next door. It appears only when this
// particular agent's install is the reason its own "please update" prompt never
// clears, and it renders nothing at all otherwise, which is nearly always.
//
// It earns the row because of where the confusion happens. The detector and the
// full explanation have existed in Settings → Agents for a while, and that pane
// is not where anybody is when they read "update available" for the ninth time;
// they are looking at this terminal. A fact that only exists two panes away
// from the symptom it explains is a fact nobody has.
//
// It can be dismissed, because the app cannot fix it: the folders a shell
// searches are the user's to change. Dismissing is remembered by the exact
// version pair, so it stays gone until the next version arrives and the nag
// resumes with new numbers.

import type { JSX } from "react";
import { X } from "lucide-react";

import {
  dismissNudge,
  parentDir,
  tildePath,
  useInstallNudge,
} from "../../lib/agentInstallHealth";

export type StaleInstallBandProps = {
  /** The agent this pane is running — `claude`, `codex`, `gemini`, … */
  agentId: string;
};

export function StaleInstallBand({ agentId }: StaleInstallBandProps): JSX.Element | null {
  const nudge = useInstallNudge(agentId);
  if (!nudge) return null;

  const fix =
    nudge.trouble === "off-path-only"
      ? `Add ${tildePath(parentDir(nudge.other.path))} to your PATH, or reinstall it somewhere already on it.`
      : `Install it into ${tildePath(parentDir(nudge.running?.path ?? nudge.other.path))} instead, or put ${tildePath(parentDir(nudge.other.path))} ahead of it in your PATH.`;

  return (
    <div className="flex items-center gap-2 h-7 px-2 border-b border-amber/30 bg-amber/5 shrink-0">
      <span className="text-2xs text-text-2 truncate" title={`${nudge.line}\n\n${fix}`}>
        {nudge.line}
      </span>

      <div className="flex-1" />

      {/* The long version — paths, every copy found, what to do — already
          exists one pane away. This points at it rather than restating it in
          a row that has to stay one line tall. */}
      <button
        type="button"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("aura:open-settings", { detail: { pane: "agents" } }),
          )
        }
        className="text-2xs text-amber hover:underline whitespace-nowrap"
      >
        How to fix
      </button>

      <button
        type="button"
        onClick={() => dismissNudge(nudge.signature)}
        title="Stop telling me about this version"
        aria-label="Dismiss"
        className="rounded p-0.5 text-text-4 hover:bg-state-hover hover:text-text-2"
      >
        <X size={11} />
      </button>
    </div>
  );
}
