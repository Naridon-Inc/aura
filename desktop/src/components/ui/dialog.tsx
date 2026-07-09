import * as React from "react";
import { FocusModal } from "@medusajs/ui";

import { cn } from "../../lib/utils";

const Dialog = FocusModal;
const DialogTrigger = FocusModal.Trigger;
const DialogClose = FocusModal.Close;
const DialogTitle = FocusModal.Title;
const DialogDescription = FocusModal.Description;
const DialogHeader = FocusModal.Header;
const DialogFooter = FocusModal.Footer;

function DialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

const DialogOverlay = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  (_props, _ref) => null,
);
DialogOverlay.displayName = "DialogOverlay";

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof FocusModal.Content>,
  React.ComponentPropsWithoutRef<typeof FocusModal.Content> & { showCloseButton?: boolean }
>(({ className, showCloseButton: _showCloseButton, ...props }, ref) => (
  <FocusModal.Content ref={ref} className={cn(className)} {...props} />
));
DialogContent.displayName = "DialogContent";

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
