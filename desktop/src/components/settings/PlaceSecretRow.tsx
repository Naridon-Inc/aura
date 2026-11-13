// One kept secret, as a row: its name, where it goes, and a way to give it a
// new value or forget it.
//
// There is no value on this row and no way to reveal one — see the note at
// the top of `lib/place/secrets.ts`. What a person can see is enough to tell
// two tokens apart (eight characters of a digest) and nothing that could be
// spent.

import { secretSentence, type SecretRef } from "../../lib/place/secrets";
import { SettingsEnvironmentRow } from "../ui/settings-environment-secrets";

/** Where a kept secret goes, in words. */
export function secretWhere(secret: SecretRef): string {
  if (!secret.git_host) return "Available to work you start";
  return secret.git_user
    ? `Used to push to ${secret.git_host} as ${secret.git_user}`
    : `Used to push to ${secret.git_host}`;
}

export function PlaceSecretRow({
  secret,
  busy,
  onForget,
  onReplace,
}: {
  secret: SecretRef;
  busy: boolean;
  onForget: () => void;
  onReplace: () => void;
}) {
  const added = new Date(secret.added_at * 1000).toLocaleDateString();
  return (
    <SettingsEnvironmentRow
      name={secret.name}
      title={secretSentence(secret)}
      detail={`${secretWhere(secret)} · ${secret.fingerprint}… · added ${added}`}
      busy={busy}
      onReplace={onReplace}
      onRemove={onForget}
      removeLabel="Forget"
    />
  );
}
