// Identity choice dialog — surfaces the per-repo identity override
// picker when a user has multiple plausible identities (their local git
// email, plus one or more team roster handles their git email
// canonicalises to via alias).
//
// Triggered on the FIRST chat send in a repo when:
//   1. No per-repo override is currently set, AND
//   2. The local git email doesn't match any roster primary email, AND
//   3. There's at least one canonical roster handle to choose from
//      (either via alias, or by offering each enrolled member).
//
// Layout follows the rest of the chat dialog family (CommsPanel's
// `ChatDoctorDialog`, `SettingsDialog`): centred modal, dark amber
// accent for identity-related affordances, "remember choice" checkbox
// that maps directly to `api.identityOverrideSet`. Cancelling without a
// pick simply sends the message under the email-local-part fallback —
// same behaviour as if the dialog were never shown.

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../ui/button";
import { api, type ChatDoctorReport, type TeamManifest } from "../../lib/api";

type Choice = {
  /** Stable id used for the radio button. */
  id: string;
  /** Handle without the leading `@`. */
  handle: string;
  /** Display name for the second line. Empty string falls back to handle. */
  name: string;
  /** Email this choice represents. Persisted into the override so the
   *  cloud presence beacon stamps the same address teammates see. */
  email: string;
  /** Whether this is the local git identity (the do-nothing default). */
  isLocalGit: boolean;
};

export type IdentityChoiceDialogProps = {
  /** Absolute repo root the choice applies to — the override key. */
  repoRoot: string;
  /** Pre-fetched ChatDoctor report so the dialog doesn't issue its own
   *  network call. Caller refreshes it after `onPicked`. */
  report: ChatDoctorReport;
  /** Team manifest used to enumerate possible identities beyond the
   *  alias-resolved one. Lets a user with two genuinely-claimable
   *  identities (e.g. two roster handles with overlapping aliases) pick
   *  among them. */
  manifest: TeamManifest | null;
  /** Fired after the user picks AND the override write succeeds. The
   *  parent then triggers `aura:identity-updated` so CommsPanel reloads
   *  `effective_handle` / `effective_name`. */
  onPicked: () => void;
  /** Close without persisting a choice. The send proceeds under the
   *  email-local-part default — exactly the legacy behaviour. */
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
  onPicked,
  onClose,
}: IdentityChoiceDialogProps) {
  const choices = useMemo<Choice[]>(() => buildChoices(report, manifest), [
    report,
    manifest,
  ]);
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
        // ticked means "stop nagging me on this repo, treat the git
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

  if (choices.length === 0) {
    // Nothing to choose between — dismiss silently so the send flow
    // doesn't stall on an empty dialog.
    return null;
  }

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
      <div className="w-[460px] max-w-[92vw] rounded-md border border-line-1 bg-bg-1 shadow-xl">
        <header className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
          <h2
            id="identity-choice-title"
            className="text-[12.5px] font-semibold text-text-1"
          >
            Send as which identity?
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

        <div className="px-4 py-3 text-[11.5px] text-text-2 leading-snug">
          Your local git email is{" "}
          <code className="font-mono">{report.git_email || "—"}</code>, but the
          team roster recognises you under a different handle. Pick the one
          that should appear on your chat messages in this repo.
        </div>

        <ul className="px-4 pb-2 space-y-1.5">
          {choices.map((c) => {
            const checked = c.id === pickedId;
            return (
              <li key={c.id}>
                <label
                  className={`flex items-start gap-2 rounded border px-2.5 py-2 cursor-pointer ${
                    checked
                      ? "border-amber-500/40 bg-amber-500/10"
                      : "border-line-soft bg-bg-2 hover:bg-bg-hover"
                  }`}
                >
                  <input
                    type="radio"
                    name="identity-choice"
                    value={c.id}
                    checked={checked}
                    onChange={() => setPickedId(c.id)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-text-1 truncate">
                      @{c.handle}
                      {c.isLocalGit && (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-text-4">
                          (local git)
                        </span>
                      )}
                    </div>
                    {c.name && c.name !== c.handle && (
                      <div className="text-[11px] text-text-3 truncate">
                        {c.name}
                      </div>
                    )}
                    <div className="text-[10.5px] text-text-4 truncate font-mono">
                      {c.email || "—"}
                    </div>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>

        <label className="flex items-center gap-2 px-4 py-2 text-[11px] text-text-2 cursor-pointer">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember this choice for this repo
        </label>

        {err && (
          <div className="mx-4 mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
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
            className="text-[11.5px]"
          >
            Cancel
          </Button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || !picked}
            className="rounded border border-amber-500/40 bg-amber-500/20 px-3 py-1 text-[11.5px] text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Use this identity"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Build the deduped choice list shown by the dialog. The canonical
 *  alias-resolved handle (if any) goes first, then claimed roster
 *  members the user might also be, then the local git identity as the
 *  "do nothing" fallback. We dedupe by email so a member who is both
 *  the canonical resolved handle AND a roster row doesn't appear twice. */
function buildChoices(
  report: ChatDoctorReport,
  manifest: TeamManifest | null,
): Choice[] {
  const out: Choice[] = [];
  const seenEmails = new Set<string>();
  const pushOnce = (choice: Choice) => {
    const key = choice.email.toLowerCase();
    if (key && seenEmails.has(key)) return;
    if (key) seenEmails.add(key);
    out.push(choice);
  };

  // 1. Canonical alias-resolved handle first — that's the headline fix
  //    (teammate@example.com when the user's local git is the hotmail alias).
  if (report.canonical_handle && report.canonical_handle !== report.handle) {
    pushOnce({
      id: `canonical:${report.canonical_handle}`,
      handle: report.canonical_handle,
      name: report.canonical_handle,
      email: report.canonical_email ?? report.git_email,
      isLocalGit: false,
    });
  }

  // 2. Other claimed roster members. The user might be enrolled under
  //    more than one handle on a multi-account repo — let them pick.
  const members = manifest?.members ?? [];
  for (const m of members) {
    if (!m.claimed) continue;
    pushOnce({
      id: `member:${m.handle}`,
      handle: m.handle,
      name: m.name || m.handle,
      email: m.email,
      isLocalGit: false,
    });
  }

  // 3. The local git identity itself as the explicit "do nothing"
  //    option. Always last so the eye-tracking lands on the canonical
  //    choice first.
  if (report.git_email) {
    pushOnce({
      id: `local:${report.git_email}`,
      handle: report.handle || emailLocalPart(report.git_email),
      name: report.git_name || report.handle,
      email: report.git_email,
      isLocalGit: true,
    });
  }

  return out;
}

function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return (at >= 0 ? email.slice(0, at) : email).toLowerCase();
}
