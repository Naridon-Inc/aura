// The pieces every agent sign-in form shares: save and remove with their
// toasts, a key field that clears once saved, and the row a saved sign-in
// shows instead of its value.

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";

import {
  agentCredentialsApi,
  credentialLabel,
  maskedHint,
  reloadAgentCredentials,
  useAgentCredentials,
  type CredentialName,
} from "../../lib/cloudAgentCredentials";
import { cloudProblem } from "../../lib/cloudWorkspacesApi";
import { toast } from "../../lib/toast";
import { askConfirm } from "../ui/ask";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Save one sign-in, say so, and refresh what every surface reads. */
export async function saveCredential(name: CredentialName, value: string, done: string): Promise<boolean> {
  try {
    await agentCredentialsApi.save(name, value);
    toast.success(done);
    await reloadAgentCredentials();
    return true;
  } catch (e) {
    toast.danger(`Could not save ${credentialLabel(name)}.`, cloudProblem(e).message);
    return false;
  }
}

export async function removeCredential(
  name: CredentialName,
  confirm: { title: string; body: string },
  done: string,
): Promise<void> {
  if (!(await askConfirm({ ...confirm, confirmLabel: "Disconnect", tone: "danger" }))) return;
  try {
    await agentCredentialsApi.remove(name);
    toast.success(done);
    await reloadAgentCredentials();
  } catch (e) {
    toast.danger(`Could not remove ${credentialLabel(name)}.`, cloudProblem(e).message);
  }
}

/** A key field with its label; clears once the save lands. */
export function SecretField({
  label,
  placeholder,
  action,
  onSave,
}: {
  label: string;
  placeholder: string;
  action?: ReactNode;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="ui-cloud-agent-key"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim() || busy) return;
        setBusy(true);
        if (await onSave(value.trim())) setValue("");
        setBusy(false);
      }}
    >
      <label>
        <span>{label}</span>
        {action}
      </label>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={!value.trim() || busy}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

/** A saved sign-in: that it is there, and the ways to change it. */
export function SavedRow({
  label,
  credential,
  note,
  replaceLabel = "Replace",
  onReplace,
  onDisconnect,
}: {
  label: string;
  /** The saved key this row stands for, shown masked. */
  credential?: CredentialName;
  note?: string;
  /** What the replace button says: "Reconnect" for a sign-in redone in
   *  the browser. */
  replaceLabel?: string;
  onReplace?: () => void;
  onDisconnect: () => void;
}) {
  const { credentials } = useAgentCredentials();
  const saved = credential && credentials.find((c) => c.name === credential && !c.workspace_id);
  return (
    <div className="ui-cloud-row ui-cloud-agent-saved">
      <Check size={14} />
      <span className="ui-cloud-agent-saved-text">
        <span>
          {label}
          {credential && <span className="ui-cloud-agent-mask">{maskedHint(saved || undefined)}</span>}
        </span>
        {note && <small>{note}</small>}
      </span>
      <span className="ui-cloud-create-spacer" />
      {onReplace && (
        <Button size="xs" variant="ghost" onClick={onReplace}>
          {replaceLabel}
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={onDisconnect}>
        Disconnect
      </Button>
    </div>
  );
}
