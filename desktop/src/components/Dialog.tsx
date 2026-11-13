import { type ReactNode } from "react";
import {
  Dialog as DialogPrimitive,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import "./ui/trace-page.css";

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
      <div className="ui-trace-tool">
        <div className="ui-trace-tool-scroll" data-fill={fill || undefined}>
          <div className="ui-trace-tool-column" style={{ maxWidth: width }}>
            {children}
          </div>
        </div>
        {footer && <footer className="ui-trace-tool-footer">{footer}</footer>}
      </div>
    );
  }

  return (
    <DialogPrimitive open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </DialogPrimitive>
  );
}
