// "Who can use", raised from the Machines page. The list and its switches are
// `MachineAccessList`, the same one Settings › Cloud computer shows inline.

import { Users } from "lucide-react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { accessIntro } from "../../lib/cloudAccess";
import { MachineAccessList, useMachineAccess } from "./MachineAccessList";
import "./machine-access.css";

export function MachineAccessDialog({
  open,
  onOpenChange,
  orgName,
  myRole: roleHint,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The org these machines belong to, for the title. */
  orgName: string | null;
  /** Your role as the machine list read it; the roster's answer wins. */
  myRole: string | null;
}) {
  const access = useMachineAccess(open, roleHint);

  const openRoles = () => {
    onOpenChange(false);
    window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane: "team" } }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ui-machine-access">
        <DialogHeader>
          <DialogTitle className="ui-machine-access-title">
            <Users size={18} aria-hidden />
            Who can use {orgName ? `${orgName}'s` : "the team's"} machines
          </DialogTitle>
          <DialogDescription>{accessIntro(access)}</DialogDescription>
        </DialogHeader>
        <MachineAccessList access={access} />
        {!access.alone && (
          <DialogFooter className="ui-machine-access-footer">
            <span>Making and removing machines comes with the Admin role.</span>
            <Button size="sm" variant="ghost" onClick={openRoles}>
              Manage roles
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
