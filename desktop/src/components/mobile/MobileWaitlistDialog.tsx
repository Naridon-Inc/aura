// The phone waitlist as a dialog, opened from the What's New note. The
// shared dialog is the frame: title and description in its header, its own
// close button, Escape and a click outside both close it.
//
// Everything about the form itself lives in MobileWaitlistPane; this file is
// only the frame.

import { MobileWaitlistPane } from "./MobileWaitlistPane";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export function MobileWaitlistDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aura on your phone</DialogTitle>
          <DialogDescription>
            Aura is coming to iPhone and Android. Check on what your agents are doing, steer
            them, and approve work while you&rsquo;re away from your desk.
          </DialogDescription>
        </DialogHeader>
        <MobileWaitlistPane
          footer={
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Not now
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
