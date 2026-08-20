/** Team (chat) presentation — custom channel tab body.
 *
 *  Renders one team-shared URL tab (a ChannelTabDef pinned via the channel
 *  header's "+"): a slim toolbar (label · URL · open-external · remove)
 *  above a sandboxed iframe embedding the page. Honest about the iframe's
 *  limits — many sites send X-Frame-Options/CSP frame-ancestors and will
 *  refuse to embed, which a cross-origin parent cannot detect, so a
 *  persistent footer hint routes the user to "Open in browser" instead of
 *  letting a blank pane read as a bug. */

import { useState } from "react";
import { ExternalLink, Globe, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ChannelTabDef } from "../../../lib/api";
import { Button } from "../../ui/button";

/** A channel tab URL is attacker-controllable — it rides the team-synced
 *  channel definition, so any peer (or a poisoned `team.json`) can set it.
 *  Only absolute http(s) URLs may be embedded or opened: a `javascript:`,
 *  `data:`, `file:` or app-origin (`tauri:`) scheme — or a relative URL that
 *  resolves against the shell's own origin — must never reach the iframe
 *  `src` or the opener. Returns the normalised href, or null to refuse. */
function safeTabUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
}

export function ChannelCustomTab({
  tab,
  onRemove,
}: {
  tab: ChannelTabDef;
  /** Unpin this tab for the whole team (any member — mirrors add). */
  onRemove?: () => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const safeUrl = safeTabUrl(tab.url);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-line-soft bg-bg-content">
        <span className="text-text-4 flex-shrink-0">
          <Globe size={12} />
        </span>
        <span className="text-sm text-text-1 font-medium flex-shrink-0">
          {tab.label}
        </span>
        <span className="text-xs text-text-4 truncate min-w-0 flex-1">
          {tab.url}
        </span>
        {removeErr && (
          <span className="text-xs text-red truncate max-w-[200px]">
            {removeErr}
          </span>
        )}
        <Button
          variant="ghost"
          size="xs"
          disabled={!safeUrl}
          onClick={() => safeUrl && void openUrl(safeUrl)}
          className="gap-1 text-xs text-text-3 hover:text-text-1 flex-shrink-0"
          title="Open in your default browser"
        >
          <ExternalLink size={11} />
          <span>Open in browser</span>
        </Button>
        {onRemove &&
          (confirming ? (
            <span className="flex items-center gap-1 flex-shrink-0">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setConfirming(false);
                  setRemoveErr(null);
                  void (async () => {
                    try {
                      await onRemove();
                    } catch (e) {
                      setRemoveErr(String(e));
                    }
                  })();
                }}
                className="text-xs text-red"
              >
                Remove for everyone
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setConfirming(false)}
                className="text-xs text-text-3 hover:text-text-1"
              >
                Keep
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setConfirming(true)}
              className="text-text-4 hover:text-red flex-shrink-0"
              title="Remove this tab for the whole team"
              aria-label="Remove tab"
            >
              <Trash2 size={11} />
            </Button>
          ))}
      </div>

      {/* Embedded page. Sandboxed hard: scripts + forms + popups run, but NO
          `allow-same-origin` — the framed doc gets a null opaque origin so it
          can never claim the shell's origin and break out of the sandbox
          (the tab URL is team-controllable). No top-navigation / downloads /
          modals either. A non-http(s) URL is refused outright. */}
      {safeUrl ? (
        <iframe
          key={tab.id}
          src={safeUrl}
          title={tab.label}
          sandbox="allow-scripts allow-forms allow-popups"
          referrerPolicy="no-referrer"
          className="flex-1 min-h-0 w-full border-0 bg-white"
        />
      ) : (
        <div className="flex-1 min-h-0 w-full flex items-center justify-center px-6 text-center text-sm text-text-4">
          This tab points to an address Aura won't embed. Only http and https
          links can be shown here.
        </div>
      )}

      <div className="flex-shrink-0 px-3 py-1 border-t border-line-soft bg-bg-content text-2xs text-text-5 leading-snug">
        Blank? The site likely refuses to be embedded. Use “Open in
        browser” above.
      </div>
    </div>
  );
}
