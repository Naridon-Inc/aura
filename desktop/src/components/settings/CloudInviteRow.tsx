// "Invite through Aura": bringing a teammate onto a signed-in team by handing
// Aura Cloud their GitHub username, instead of editing git-remote permissions.
//
// Drawn as the member list's own "Invite member" action. It only mounts beside
// an Aura Cloud organization's roster — that is what an invite targets, and
// the server enforces that you're allowed to. Signed out, or in a personal
// account with no organization, there is no roster and so no invite; the team
// is still derived from git history, so nothing regresses for solo users.

import { useCallback, useState } from "react";
import { Plus } from "lucide-react";

import { api } from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import { toast } from "../../lib/toast";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { githubHandle, inviteMessage } from "./inviteMessage";
import "../ui/settings-team-members.css";

export function CloudInviteRow({ orgName }: { orgName: string }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  // Who was just added. Aura tells them nothing, so the dialog stays open on
  // the message to send them.
  const [added, setAdded] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);

  const invite = useCallback(async () => {
    const who = githubHandle(username);
    if (!who || busy) return;
    setBusy(true);
    try {
      await api.cloudOrgInvite(who);
      setUsername("");
      setCopied(await writeClipboardText(inviteMessage(orgName, who)));
      setAdded(who);
    } catch (e) {
      toast.danger("Couldn't add them", String(e));
    } finally {
      setBusy(false);
    }
  }, [username, busy, orgName]);

  const close = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setAdded(null);
      setCopied(null);
    }
  };

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Plus />
        Invite member
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogTitle>Invite to {orgName}</DialogTitle>
          {added ? (
            <>
              <DialogDescription>
                @{added} is on the team. Aura doesn{"’"}t message them, so send them this
                {copied ? " (it\u2019s on your clipboard)" : ""}:
              </DialogDescription>
              <p className="settings-invite-message">{inviteMessage(orgName, added)}</p>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setAdded(null)}>
                  Add someone else
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => setCopied(await writeClipboardText(inviteMessage(orgName, added)))}
                >
                  {copied ? "Copied" : copied === false ? "Couldn’t copy — try again" : "Copy message"}
                </Button>
                <Button type="button" onClick={() => close(false)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogDescription>
                Signed in to Aura Cloud, you add people through Aura, with no git permissions to hand
                out. Enter their GitHub username.
              </DialogDescription>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void invite();
                }}
              >
                <Input
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="github-username"
                  disabled={busy}
                  aria-label="GitHub username to invite"
                />
                <DialogFooter>
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => close(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!username.trim() || busy}>
                    {busy ? (
                      <>
                        <AsciiSpinner /> Adding…
                      </>
                    ) : (
                      "Add to team"
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
