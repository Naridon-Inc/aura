// "Aura doesn't know who you are" — the repair, not a menu.
//
// This is what the first-send identity flow shows when there is no team
// identity this computer can prove is yours. Previously that case fell
// through to a picker listing whoever else was on the repo's roster, which
// invited a brand-new user to send messages under a stranger's name. There
// is nothing to pick between here, so we don't pretend there is: we ask
// for the one thing that is genuinely missing and write it down.
//
// Saving sets this repository's git author (repo-local `user.name` /
// `user.email` via `git_identity_set` — never `--global`), which is the
// same field the rest of Aura reads to decide who signed a change. When an
// Aura account is signed in the fields arrive already filled from it, so
// the common case is one click.

import { useState } from "react";
import { Button } from "../ui/button";
import { api, type CloudAuthStatus } from "../../lib/api";
import { gitIdentityFromAccount } from "../../lib/accountIdentity";

export type IdentitySetupFormProps = {
  /** Repo whose git author is being set. */
  repoRoot: string;
  /** Signed-in Aura account, used to prefill. `null` when signed out. */
  account: CloudAuthStatus | null;
  /** Name already configured on this computer, if any. */
  initialName: string;
  /** Email already configured on this computer, if any. */
  initialEmail: string;
  /** Fired after the identity is written. */
  onSaved: () => void;
  /** Dismiss without writing anything. */
  onClose: () => void;
};

export function IdentitySetupForm({
  repoRoot,
  account,
  initialName,
  initialEmail,
  onSaved,
  onClose,
}: IdentitySetupFormProps) {
  const fromAccount = gitIdentityFromAccount(account);
  const [name, setName] = useState(initialName || fromAccount?.name || "");
  const [email, setEmail] = useState(initialEmail || fromAccount?.email || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const prefilledFromAccount =
    Boolean(fromAccount) && !initialName && !initialEmail;
  const ready = name.trim().length > 0 && email.trim().includes("@");

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.gitIdentitySet(repoRoot, name.trim(), email.trim());
      window.dispatchEvent(new CustomEvent("aura:identity-updated"));
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="px-4 py-3 text-sm text-text-2 leading-snug">
        Your messages here can't carry your name yet, because this computer
        hasn't been told who is using it. Add a name and an email and Aura will
        sign your work with them in this project.
        {prefilledFromAccount && (
          <div className="mt-1.5 text-xs text-text-3">
            Filled in from the Aura account you're signed in to. Change either
            one if you'd rather.
          </div>
        )}
      </div>

      <div className="space-y-2.5 px-4 pb-1">
        <label className="block">
          <span className="section-label">Your name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alex Rivera"
            autoFocus
            className="mt-1 w-full rounded border border-line-soft bg-bg-2 px-2.5 py-1.5 text-sm text-text-1 outline-none focus:border-accent/50"
          />
        </label>
        <label className="block">
          <span className="section-label">Your email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="alex@example.com"
            className="mt-1 w-full rounded border border-line-soft bg-bg-2 px-2.5 py-1.5 font-mono text-sm text-text-1 outline-none focus:border-accent/50"
          />
        </label>
      </div>

      <p className="px-4 pb-1 pt-2 text-xs text-text-4 leading-snug">
        This applies to this project only, and stays on your computer until you
        send or commit something.
      </p>

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
          Not now
        </Button>
        <button
          type="button"
          onClick={save}
          disabled={busy || !ready}
          className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-sm text-accent transition-colors hover:bg-accent/25 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </footer>
    </>
  );
}
