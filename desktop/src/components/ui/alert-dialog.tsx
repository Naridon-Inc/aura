import * as React from "react";
import { Prompt } from "@medusajs/ui";

const AlertDialog = Prompt;
const AlertDialogTrigger = Prompt.Trigger;
const AlertDialogContent = Prompt.Content;
const AlertDialogHeader = Prompt.Header;
const AlertDialogFooter = Prompt.Footer;
const AlertDialogTitle = Prompt.Title;
const AlertDialogDescription = Prompt.Description;
const AlertDialogAction = Prompt.Action;
const AlertDialogCancel = Prompt.Cancel;

function AlertDialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

const AlertDialogOverlay = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  (_props, _ref) => null,
);
AlertDialogOverlay.displayName = "AlertDialogOverlay";

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
