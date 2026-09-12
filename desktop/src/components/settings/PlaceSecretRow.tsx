// One kept secret, as a row: its name, where it goes, and a way to forget it.
//
// There is no value on this row and no way to reveal one — see the note at
// the top of `lib/place/secrets.ts`. What a person can see is enough to tell
// two tokens apart (eight characters of a digest) and nothing that could be
// spent.

import { Trash2 } from "lucide-react";
import { secretSentence, type SecretRef } from "../../lib/place/secrets";
import { Button } from "../ui/button";
import { AsciiSpinner } from "../ui/ascii-spinner";

export function PlaceSecretRow({
  secret,
  busy,
  onForget,
}: {
  secret: SecretRef;
  busy: boolean;
  onForget: () => void;
}) {
  const where = secret.git_host
    ? secret.git_user
      ? `Used to push to ${secret.git_host} as ${secret.git_user}`
      : `Used to push to ${secret.git_host}`
    : "Available to work you start";
  return (
    <div
      className="flex items-center gap-3 border-b border-line-soft py-2.5 last:border-b-0"
      title={secretSentence(secret)}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-mono text-[13px] text-text-1">{secret.name}</span>
          <span className="font-mono text-[11px] text-text-4">{secret.fingerprint}…</span>
        </div>
        <div className="text-xs text-text-3">{where}</div>
      </div>
      <span className="text-[11px] text-text-4">
        added {new Date(secret.added_at * 1000).toLocaleDateString()}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onForget}
        disabled={busy}
        aria-label={`Forget ${secret.name}`}
        title="Forget this secret"
      >
        {busy ? <AsciiSpinner /> : <Trash2 />}
      </Button>
    </div>
  );
}
