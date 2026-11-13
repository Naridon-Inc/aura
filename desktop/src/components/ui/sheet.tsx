import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Content } from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { DialogPortal, DialogOverlay, DialogClose } from "./dialog";
export {
  Dialog as Sheet,
  DialogTrigger as SheetTrigger,
  DialogClose as SheetClose,
  DialogPortal as SheetPortal,
  DialogOverlay as SheetOverlay,
  DialogHeader as SheetHeader,
  DialogFooter as SheetFooter,
  DialogTitle as SheetTitle,
  DialogDescription as SheetDescription,
} from "./dialog";
export const SheetContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content> & {
    side?: "left" | "right" | "top" | "bottom";
    showCloseButton?: boolean;
  }
>(({ className, side = "right", children, showCloseButton = true, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <Content
      ref={ref}
      className={cn("ui-sheet", className)}
      data-side={side}
      data-over-native-surface
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogClose className="ui-dialog-close" aria-label="Close panel">
          <X size={16} />
        </DialogClose>
      )}
    </Content>
  </DialogPortal>
));
SheetContent.displayName = "SheetContent";
