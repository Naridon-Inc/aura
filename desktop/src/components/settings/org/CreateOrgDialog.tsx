// Make an organization from the desktop: a name, the address it gets (made
// from the name until you type your own), and the switch to it once it exists.

import { useState } from "react";

import { createOrg, slugOf, slugOk } from "../../../lib/cloudAdmin";
import { messageOf, switchOrg } from "../../../lib/cloudOrgs";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";

export function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("");
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = typed ?? slugOf(name);

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setName("");
      setTyped(null);
      setError(null);
    }
  };

  const submit = () => {
    if (!name.trim()) return setError("Name the organization.");
    if (!slugOk(slug)) return setError("The address takes 2–40 lowercase letters, digits and dashes.");
    setBusy(true);
    setError(null);
    createOrg(name.trim(), slug)
      .then((org) => switchOrg(org.slug || slug))
      .then(() => {
        setBusy(false);
        close(false);
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(messageOf(e));
      });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogTitle>Create organization</DialogTitle>
        <DialogDescription>You’ll be its owner, and the app switches to it once it’s made.</DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="ui-form-field">
            Name
            <Input
              autoFocus
              aria-label="Organization name"
              placeholder="Acme Labs"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="ui-form-field">
            Address
            <Input
              aria-label="Organization address"
              placeholder="acme-labs"
              value={slug}
              onChange={(e) => setTyped(e.target.value.toLowerCase())}
            />
          </label>
          {error && (
            <p role="alert" className="ui-field-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <AsciiSpinner size={11} />}
              Create organization
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
