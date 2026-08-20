// Identity choice dialog — asks which of *your own* identities should
// appear on your messages in this repo.
//
// Triggered on the FIRST chat send in a repo, and from the sidebar notice.
// It has two modes, decided by the evidence this machine can actually
// produce (see `./identityChoices`):
//
//   • at least one identity this computer can prove is yours, and it
//     differs from what you're sending as → pick between them;
//   • no such identity and no local git author at all → set one up
//     (`IdentitySetupForm`), because a menu with nothing legitimate on it
//     is not a question worth asking.
//
// It used to have a third behaviour, and that was the bug: with no local
// git email it listed every `claimed` member of the repo's committed
// roster as a candidate "you". A stranger who cloned a public project and
// wasn't signed in was offered precisely one identity on their first
// message — a real teammate's name, handle and email. Roster membership
// describes other people; it is not evidence about the person at this
// keyboard. `buildIdentityChoices` no longer enumerates it.
//
// Layout follows the rest of the chat dialog family (`ChatDoctorDialog`,
// `SettingsDialog`): centred modal, "remember choice" checkbox mapping to
// `api.identityOverrideSet`. Cancelling sends under the existing default —
// same behaviour as if the dialog were never shown.

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../ui/button";
import { IdentitySetupForm } from "./IdentitySetupForm";
import { buildIdentityChoices } from "./identityChoices";
import {
  api,
  type ChatDoctorReport,
  type CloudAuthStatus,
  type TeamManifest,
} from "../../lib/api";

export type IdentityChoiceDialogProps = {
  /** Absolute repo root the choice applies to — the override key. */
  repoRoot: string;
  /** Pre-fetched ChatDoctor report so the dialog doesn't issue its own
   *  network call. Caller refreshes it after `onPicked`. */
  report: ChatDoctorReport;
  /** Team manifest, used only to match the signed-in Aura account to a
   *  seat it is recorded on — never to enumerate other people. */
  manifest: TeamManifest | null;
  /** Signed-in Aura account, or `null` when signed out / not yet read. */
  account: CloudAuthStatus | null;
  /** Fired after the user picks AND the override write succeeds. The
   *  parent then triggers `aura:identity-updated` so CommsPanel reloads
   *  `effective_handle` / `effective_name`. */
  onPicked: () => void;
  /** Close without persisting a choice. The send proceeds under the
   *  existing default — exactly the legacy behaviour. */
  onClose: () => void;
};

/** First-send identity picker. Persists the user's choice via
 *  `identity_override_set` when the "remember for this repo" checkbox is
 *  ticked; otherwise it just dispatches `aura:identity-updated` so the
 *  rest of the session sees the picked handle without writing to disk. */
export function IdentityChoiceDialog({
  repoRoot,
  report,
  manifest,
  account,
  onPicked,
  onClose,
}: IdentityChoiceDialogProps) {
  const choices = useMemo(
    () => buildIdentityChoices({ report, manifest, account }),
    [report, manifest, account],
  );
  // Nothing to switch to means there is no choice to make, whatever else
  // is in the roster — fall through to the setup form instead of drawing
  // a one-row menu or an empty one.
  const canChoose = choices.some((c) => !c.isLocalGit);
  const [pickedId, setPickedId] = useState<string>(
    () => choices.find((c) => !c.isLocalGit)?.id ?? choices[0]?.id ?? "",
  );
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Esc to dismiss — same pattern as the other modals in this folder.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const picked = choices.find((c) => c.id === pickedId) ?? null;

  const apply = async () => {
    if (!picked) {
      onClose();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (remember && !picked.isLocalGit) {
        await api.identityOverrideSet(
          repoRoot,
          picked.handle,
          picked.name || picked.handle,
          picked.email,
        );
      } else if (remember && picked.isLocalGit) {
        // Explicitly picking the local-git default with "remember"
        // ticked means "stop asking me on this repo, treat the git
        // email as canonical going forward". Clear any existing
        // override so the resolver falls back to the alias map.
        await api.identityOverrideClear(repoRoot);
      }
      window.dispatchEvent(new CustomEvent("aura:identity-updated"));
      onPicked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="identity-choice-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[460px] max-w-[92vw] rounded-md border border-line bg-bg-1 shadow-xl">
        <header className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
          <h2
            id="identity-choice-title"
            className="text-base font-semibold text-text-1"
          >
            {canChoose
              ? "Which name should your messages carry?"
              : "Tell Aura who you are"}
          </h2>
          <button
            type="button"
            aria-label="Close identity picker"
            onClick={onClose}
            className="text-text-3 hover:text-text-1"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {canChoose ? (
          <>
            <div className="px-4 py-3 text-sm text-text-2 leading-snug">
              You go by more than one name on this project. Pick the one your
              teammates should see on your messages here. Aura only lists names
              it can tell are yours.
            </div>

            <ul className="px-4 pb-2 space-y-1.5">
              {choices.map((c) => {
                const checked = c.id === pickedId;
                return (
                  <li key={c.id}>
                    <label
                      className={`flex items-start gap-2 rounded border px-2.5 py-2 cursor-pointer ${
                        checked
                          ? "border-accent/40 bg-accent/10"
                          : "border-line-soft bg-bg-2 hover:bg-state-hover"
                      }`}
                    >
                      <input
                        type="radio"
                        name="identity-choice"
                        value={c.id}
                        checked={checked}
                        onChange={() => setPickedId(c.id)}
                        // The selected row already wears the brand tint; the
                        // radio inside it was drawing in the OS blue.
                        className="mt-0.5 accent-accent"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-text-1 truncate">
                          @{c.handle}
                          {c.isLocalGit && (
                            <span className="section-label ml-1.5">
                              (what you use now)
                            </span>
                          )}
                        </div>
                        {c.name && c.name !== c.handle && (
                          <div className="text-xs text-text-3 truncate">
                            {c.name}
                          </div>
                        )}
                        {c.email && (
                          <div className="text-xs text-text-4 truncate font-mono">
                            {c.email}
                          </div>
                        )}
                        <div className="mt-0.5 text-xs text-text-4 leading-snug">
                          {c.reason}
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>

            <label className="flex items-center gap-2 px-4 py-2 text-xs text-text-2 cursor-pointer">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember this choice for this project
            </label>

            {err && (
              <div className="mx-4 mb-2 rounded border border-red/30 bg-red/10 px-2 py-1 text-xs text-red">
                {err}
              </div>
            )}

            <footer className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onClose}
                disabled={busy}
                className="text-sm"
              >
                Cancel
              </Button>
              <button
                type="button"
                onClick={apply}
                disabled={busy || !picked}
                className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-sm text-accent transition-colors hover:bg-accent/25 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Use this name"}
              </button>
            </footer>
          </>
        ) : (
          <IdentitySetupForm
            repoRoot={repoRoot}
            account={account}
            initialName={report.git_name ?? ""}
            initialEmail={report.git_email ?? ""}
            onSaved={onPicked}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
