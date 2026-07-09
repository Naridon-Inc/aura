import { type ReactNode } from "react";
import { IconButton } from "@medusajs/ui";
import { XMark } from "@medusajs/icons";
import {
  Dialog as DialogPrimitive,
  DialogClose,
  DialogContent as DialogContentPrimitive,
  DialogTitle,
} from "./ui/dialog";

type DialogProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  inline?: boolean;
  fill?: boolean;
};

export function Dialog({ open, title, onClose, children, footer, width = 520, inline = false, fill = false }: DialogProps) {
  if (inline) {
    if (!open) return null;
    return (
      <div className="flex h-full w-full flex-col bg-ui-bg-base">
        <div className={`min-h-0 flex-1 ${fill ? "flex" : "overflow-auto"}`}>
          <div
            className={`mx-auto w-full px-8 py-7 ${fill ? "flex h-full min-h-0 flex-col" : ""}`}
            style={{ maxWidth: width }}
          >
            {children}
          </div>
        </div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ui-border-base px-8 py-3">
            {footer}
          </div>
        )}
      </div>
    );
  }

  return (
    <DialogPrimitive open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContentPrimitive
        showCloseButton={false}
        className="inset-auto left-1/2 top-[18vh] max-w-none translate-x-[-50%] translate-y-0 gap-0 overflow-hidden p-0"
        style={{ maxWidth: width, width: "100%" }}
        onPointerDownOutside={onClose}
        onEscapeKeyDown={onClose}
      >
        <header className="flex items-center border-b border-ui-border-base px-4 py-2.5">
          <DialogTitle className="txt-compact-small-plus text-ui-fg-base">{title}</DialogTitle>
          <DialogClose asChild>
            <IconButton
              type="button"
              size="small"
              variant="transparent"
              onClick={onClose}
              className="ml-auto"
              aria-label="Close dialog"
              title="Close (esc)"
            >
              <XMark aria-hidden />
            </IconButton>
          </DialogClose>
        </header>
        <div className="px-4 py-3">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-ui-border-base px-4 py-2.5">
            {footer}
          </div>
        )}
      </DialogContentPrimitive>
    </DialogPrimitive>
  );
}
