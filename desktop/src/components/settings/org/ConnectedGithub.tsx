// Settings → Organization → Connected GitHub: the GitHub accounts and
// organizations whose repositories can run on this organization's cloud.
// Every member sees the list; an owner or admin connects more and removes
// them. Removing keeps the projects; nothing new is copied through it.

import { useCallback, useEffect, useState } from "react";

import {
  connectedLine,
  listConnectedGithub,
  removeConnectedGithub,
  type ConnectedGithub as Row,
  type ConnectedGithubList,
} from "../../../lib/cloudGithub";
import { messageOf, onOrgChanged } from "../../../lib/cloudOrgs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { ErrorNote, LoadingState } from "../../ui/state";
import { ConnectGithubFlow } from "./ConnectGithubFlow";

export function ConnectedGithub() {
  const [list, setList] = useState<ConnectedGithubList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asked, setAsked] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);

  const load = useCallback(() => {
    listConnectedGithub()
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((e: unknown) => {
        setList((l) => l ?? { installations: [], can_manage: false });
        setError(messageOf(e));
      });
  }, []);
  useEffect(() => {
    load();
    return onOrgChanged(load);
  }, [load]);

  const remove = (row: Row) => {
    setAsked(null);
    setDone(null);
    setRemoving(row.installation_id);
    removeConnectedGithub(row.installation_id)
      .then(load)
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setRemoving(null));
  };

  const rows = list?.installations ?? [];
  return (
    <SettingsSection
      title="Connected GitHub"
      description="Repositories in these GitHub accounts and organizations can run on this organization’s cloud. Which repositories each one opens is chosen on GitHub."
    >
      {list === null && <LoadingState label="Reading connected GitHub accounts…" />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {done && <p className="ui-cloud-note">{done}</p>}
      {list !== null && rows.length === 0 && !error && (
        <p className="ui-cloud-note">No GitHub account is connected yet, so projects can’t be copied to the cloud.</p>
      )}
      {rows.map((row) => (
        <SettingsRow
          key={row.installation_id}
          title={row.account_login}
          description={connectedLine(row)}
          control={
            list?.can_manage ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={removing === row.installation_id}
                onClick={() => setAsked(row)}
              >
                {removing === row.installation_id ? "Removing…" : "Remove"}
              </Button>
            ) : null
          }
        />
      ))}
      {list?.can_manage ? (
        <ConnectGithubFlow
          first={rows.length === 0}
          onConnected={(note) => {
            setDone(note);
            load();
          }}
        />
      ) : (
        list !== null && <p className="ui-cloud-note">Only an owner or admin can connect or remove GitHub accounts.</p>
      )}
      <AlertDialog open={!!asked} onOpenChange={(open) => !open && setAsked(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Stop using {asked?.account_login}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its projects stay in Aura, but cloud computers can’t copy anything new from it. The app stays installed on GitHub
            until you remove it there.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => asked && remove(asked)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
