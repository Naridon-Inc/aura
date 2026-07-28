// Possible-duplicate review banner — shared across every roster surface that
// wants to let a human settle who's who (the team-chat MembersRail and the
// Settings → Team → Members pane both mount it, so the merge affordance lives
// in one place instead of only in chat).
//
// The backend spots roster rows that *probably* belong to one person — a commit
// under a private "noreply" email next to the same person's real email, a
// display name that matches someone's GitHub login. Those are hunches, not
// facts, so nothing merges on its own: we surface each hunch here in plain words
// and let a human settle it. "Same person" folds the rows together; "Different
// people" remembers the answer so the hunch stops coming back.

import { useState } from "react";

import { type DuplicateSuggestion } from "../../../lib/api";
import { animalForName, tintForName } from "../../../lib/identityColors";

export function DuplicatesBanner({
  suggestions,
  onConfirm,
  onReject,
}: {
  suggestions: DuplicateSuggestion[];
  onConfirm?: (survivorEmail: string, mergedEmails: string[]) => Promise<void> | void;
  onReject?: (emailA: string, emailB: string) => Promise<void> | void;
}) {
  if (!onConfirm || !onReject || suggestions.length === 0) return null;
  return (
    <div className="mx-2 mb-2">
      <div className="text-[10px] uppercase tracking-wider text-text-5 font-medium pb-1 px-0.5">
        Possible duplicates — {suggestions.length}
      </div>
      <div className="flex flex-col gap-1.5">
        {suggestions.map((s) => (
          <DuplicateCard
            key={`${s.survivor_email}|${[...s.emails].sort().join(",")}`}
            suggestion={s}
            onConfirm={onConfirm}
            onReject={onReject}
          />
        ))}
      </div>
    </div>
  );
}

function DuplicateCard({
  suggestion,
  onConfirm,
  onReject,
}: {
  suggestion: DuplicateSuggestion;
  onConfirm: (survivorEmail: string, mergedEmails: string[]) => Promise<void> | void;
  onReject: (emailA: string, emailB: string) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { emails, handles, names, survivor_email, confidence, reason } = suggestion;
  // The rows this hunch groups. Prefer a name, fall back to a handle, then
  // the email itself — whichever reads most like a person.
  const labels = emails.map(
    (e, i) => names[i]?.trim() || handles[i]?.trim() || e,
  );

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const others = emails.filter(
        (e) => e.toLowerCase() !== survivor_email.toLowerCase(),
      );
      await onConfirm(survivor_email, others);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't merge these — try again.");
      setBusy(false);
    }
    // On success the list re-fetches and this card unmounts; no need to
    // clear `busy`.
  };

  const reject = async () => {
    setBusy(true);
    setError(null);
    try {
      // Break every pairing in the group so a 3-way hunch can't linger on a
      // sub-pair. Distinct unordered pairs only.
      for (let i = 0; i < emails.length; i++) {
        for (let j = i + 1; j < emails.length; j++) {
          await onReject(emails[i], emails[j]);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that — try again.");
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line-soft bg-bg-2/40 p-2">
      <div className="flex items-start gap-1.5">
        <span className="flex -space-x-1.5 flex-shrink-0 mt-[1px]">
          {emails.slice(0, 3).map((e, i) => {
            const key = handles[i] || e;
            return (
              <span
                key={e}
                className="w-4 h-4 rounded-full border border-bg-1 flex items-center justify-center"
                style={{ background: tintForName(key), fontSize: 9 }}
                aria-hidden
              >
                {animalForName(key)}
              </span>
            );
          })}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-text-2 leading-snug">
            {labels.map((l, i) => (
              <span key={emails[i]}>
                <span className="text-text-1">{l}</span>
                {i < labels.length - 1 && (
                  <span className="text-text-5"> and </span>
                )}
              </span>
            ))}
          </div>
          <div className="text-[10.5px] text-text-4 leading-snug mt-0.5">
            {reason}
            {confidence === "medium" && (
              <span className="text-text-5"> · not sure</span>
            )}
          </div>
        </div>
      </div>
      {error && (
        <div className="text-[10px] text-red mt-1 leading-snug">{error}</div>
      )}
      <div className="flex items-center gap-1 mt-1.5">
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="px-1.5 py-0.5 rounded text-[10px] leading-none border border-accent/25 text-accent hover:bg-accent/10 disabled:opacity-50"
          title={`Treat these as one person — keep ${survivor_email}`}
        >
          Same person
        </button>
        <button
          type="button"
          onClick={reject}
          disabled={busy}
          className="px-1.5 py-0.5 rounded text-[10px] leading-none border border-line-soft text-text-4 hover:text-text-1 hover:bg-bg-2 disabled:opacity-50"
          title="Keep them separate and stop suggesting this"
        >
          Different people
        </button>
      </div>
    </div>
  );
}
