// Settings → API access: the org's API keys. A key is named, given only what
// it may do, shown once when it's made, and revoked from here. Making and
// revoking are an admin's; a member sees the list and the server's refusal.

import { useCallback, useEffect, useState } from "react";

import { API_SCOPES, createApiKey, keyLine, listApiKeys, liveKeys, revokeApiKey, type CloudApiKey } from "../../../lib/cloudAdmin";
import { messageOf, onOrgChanged } from "../../../lib/cloudOrgs";
import { useCloudPlan } from "../../../lib/useCloudPlan";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { CloudApiSettings } from "../../ui/cloud-services";
import { LoadingState } from "../../ui/state";
import { SignedOutCloud } from "./SignedOutCloud";
import "../../ui/cloud-patterns.css";

const COPY = {
  create: "Create API key",
  submit: "Create key",
  revoke: "Revoke",
  createdTitle: "API key created",
  createdDescription: "Copy it now. It is shown once and can’t be read again.",
  createDescription: "Name the key after what will use it, and give it only what it needs.",
  copy: "Copy key",
};

export function ApiKeysPage({ onSignIn }: { onSignIn: () => void }) {
  const read = useCloudPlan();
  const [keys, setKeys] = useState<CloudApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<CloudApiKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(() => {
    listApiKeys()
      .then((list) => {
        setKeys(list);
        setError(null);
      })
      .catch((e: unknown) => {
        setKeys((k) => k ?? []);
        setError(messageOf(e));
      });
  }, []);
  useEffect(() => {
    if (read.state === "signed_out" || read.state === "loading") return;
    load();
    return onOrgChanged(load);
  }, [read.state, load]);

  if (read.state === "signed_out") return <SignedOutCloud what="make API keys for your organization" onSignIn={onSignIn} />;
  if (keys === null) return <LoadingState label="Reading your API keys…" />;

  const revoke = (key: CloudApiKey) => {
    setAsked(null);
    setRevoking(key.id);
    revokeApiKey(key.id)
      .then(load)
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setRevoking(null));
  };

  return (
    <>
      <CloudApiSettings
        intro={<p>Keys let scripts, CI and other tools act for your organization, with only the permissions you give them.</p>}
        keys={liveKeys(keys).map((k) => ({
          id: k.id,
          name: k.label,
          detail: keyLine(k),
          revocable: k.revocable !== false,
        }))}
        empty={<p className="ui-cloud-note">No keys yet.</p>}
        error={error}
        scopes={API_SCOPES}
        defaultScopes={["repo:read"]}
        copy={COPY}
        revoking={revoking}
        onCreate={async (label, scopes) => {
          const made = await createApiKey(label, scopes);
          load();
          return made.token;
        }}
        onRevoke={(id) => setAsked(keys.find((k) => k.id === id) ?? null)}
      >
        {read.cloudUrl && (
          <>
            <h3 style={{ marginTop: 28 }}>Server</h3>
            <p>Send a key as a bearer token to this server.</p>
            <code className="ui-cloud-path">{read.cloudUrl}</code>
          </>
        )}
      </CloudApiSettings>
      <AlertDialog open={!!asked} onOpenChange={(open) => !open && setAsked(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Revoke {asked?.label}?</AlertDialogTitle>
          <AlertDialogDescription>Anything using this key stops working on its next request. This can’t be undone.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => asked && revoke(asked)}>Revoke key</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
