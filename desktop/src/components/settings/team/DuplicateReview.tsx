import { useState } from "react";

import { type DuplicateSuggestion } from "../../../lib/api";
import { Button } from "../../ui/button";
import { SettingsActions, SettingsError } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";

// Possible-duplicate review. The backend spots roster rows that probably
// belong to one person — a commit under a private "noreply" email next to the
// same person's real email, a display name that matches someone's GitHub
// login. Those are hunches, not facts, so nothing merges on its own: each one
// is said in plain words for a human to settle. "Same person" folds the rows
// together; "Different people" remembers the answer so it stops coming back.

type Confirm = (survivorEmail: string, mergedEmails: string[]) => Promise<void> | void;
type Reject = (emailA: string, emailB: string) => Promise<void> | void;

export function DuplicateReview({
  suggestions,
  onConfirm,
  onReject,
}: {
  suggestions: DuplicateSuggestion[];
  onConfirm: Confirm;
  onReject: Reject;
}) {
  if (suggestions.length === 0) return null;
  return (
    <SettingsSection
      title="Possible duplicates"
      description="These look like one person signing work in more than one way. Nothing merges until you say so."
    >
      {suggestions.map((s) => (
        <DuplicateRow
          key={`${s.survivor_email}|${[...s.emails].sort().join(",")}`}
          suggestion={s}
          onConfirm={onConfirm}
          onReject={onReject}
        />
      ))}
    </SettingsSection>
  );
}

function DuplicateRow({
  suggestion,
  onConfirm,
  onReject,
}: {
  suggestion: DuplicateSuggestion;
  onConfirm: Confirm;
  onReject: Reject;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { emails, handles, names, survivor_email, confidence, reason } = suggestion;
  // Prefer a name, fall back to a handle, then the email itself — whichever
  // reads most like a person.
  const labels = emails.map((e, i) => names[i]?.trim() || handles[i]?.trim() || e);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const others = emails.filter((e) => e.toLowerCase() !== survivor_email.toLowerCase());
      await onConfirm(survivor_email, others);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't merge these. Try again.");
      setBusy(false);
    }
    // On success the list re-fetches and this row unmounts.
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
      setError(e instanceof Error ? e.message : "Couldn't save that. Try again.");
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      title={labels.join(" and ")}
      description={
        <>
          {reason}
          {confidence === "medium" ? " · not sure" : ""}
        </>
      }
      help={error ? <SettingsError>{error}</SettingsError> : undefined}
      control={
        <SettingsActions>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void reject()}
            title="Keep them separate and stop suggesting this"
          >
            Different people
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void confirm()}
            title={`Treat these as one person. Keep ${survivor_email}`}
          >
            Same person
          </Button>
        </SettingsActions>
      }
    />
  );
}
