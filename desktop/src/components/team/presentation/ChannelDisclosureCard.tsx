/** Team (chat) presentation — #aura first-entry disclosure card.
 *
 *  The first time a user opens the worldwide #aura channel we show a slim
 *  banner that says, in plain language, that their real name is visible to
 *  everyone using Aura. Decision is locked: real name, disclosed first — so
 *  the default action keeps the real name; switching to a handle is a quiet,
 *  one-tap opt-in scoped to this channel only.
 *
 *  Purely presentational: it owns no persistence and no identity state. The
 *  parent (ConversationView) decides when to mount it, marks it seen, and
 *  routes the chosen handle to the send path. */

import { useState } from "react";
import { Globe, Shuffle } from "lucide-react";
import { randomHandle } from "../domain";
import { Button } from "../../ui/button";

export function ChannelDisclosureCard({
  realName,
  onKeepRealName,
  onUsePseudonym,
  suggestedHandle,
}: {
  /** The user's real name as everyone in #aura will see it. */
  realName: string;
  /** Keep the real name — dismisses the card. */
  onKeepRealName: () => void;
  /** Switch to a pseudonym for #aura only — receives the chosen slug. */
  onUsePseudonym: (handle: string) => void;
  /** A calm, deterministic suggestion seeded from the device. */
  suggestedHandle: string;
}) {
  // false = the headline + "Looks good" view; true = the handle picker.
  const [picking, setPicking] = useState(false);
  const [handle, setHandle] = useState(suggestedHandle);

  // Fallback so the headline never reads "as ." for an unnamed device.
  const name = realName.trim() || "yourself";

  return (
    <div className="mx-3 mt-2 mb-1 rounded-md border border-line-soft bg-bg-1 px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span
          className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full"
          style={{
            background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
            color: "var(--color-accent)",
          }}
        >
          <Globe size={12} />
        </span>

        <div className="min-w-0 flex-1">
          {!picking ? (
            <>
              <div className="text-[12.5px] leading-snug text-text-1">
                You'll post in #aura as <b className="font-semibold">{name}</b>
              </div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-text-4">
                #aura is a public space — anyone using Aura, anywhere, can see
                your name and messages here.
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={onKeepRealName}
                  className="rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-bg-1 hover:opacity-90"
                >
                  Looks good
                </button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setPicking(true)}
                  className="px-1.5 text-[11.5px] text-text-3 hover:text-text-1"
                >
                  Use a handle instead
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="text-[12.5px] leading-snug text-text-1">
                Post in #aura as a handle instead
              </div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-text-4">
                Just here — your real name still shows in every other channel.
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="rounded border border-line-soft bg-bg-2 px-2 py-1 font-mono text-[11.5px] text-text-1">
                  {handle}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setHandle(randomHandle())}
                  title="Suggest another handle"
                  className="gap-1 px-1.5 text-[11px] text-text-3 hover:text-text-1"
                >
                  <Shuffle size={11} />
                  Shuffle
                </Button>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => onUsePseudonym(handle)}
                  className="rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-bg-1 hover:opacity-90"
                >
                  Use this handle
                </button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setPicking(false)}
                  className="px-1.5 text-[11.5px] text-text-3 hover:text-text-1"
                >
                  Back
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
