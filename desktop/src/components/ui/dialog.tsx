import {
  createContext,
  useContext,
  useRef,
  useState,
  type RefObject,
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type HTMLAttributes,
} from "react";
import {
  Root,
  Trigger,
  Close,
  Portal,
  Overlay,
  Content,
  Title,
  Description,
} from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
const DialogFocus = createContext<RefObject<HTMLElement | null> | null>(null);
export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof Root>) {
  const [localOpen, setLocalOpen] = useState(defaultOpen ?? false);
  const active = open ?? localOpen;
  const previous = useRef(false);
  const origin = useRef<HTMLElement | null>(null);
  if (active && !previous.current && typeof document !== "undefined")
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previous.current = active;
  return (
    <DialogFocus.Provider value={origin}>
      <Root
        {...props}
        open={active}
        onOpenChange={(next) => {
          setLocalOpen(next);
          onOpenChange?.(next);
        }}
      >
        {children}
      </Root>
    </DialogFocus.Provider>
  );
}
export const DialogTrigger = Trigger;
export const DialogClose = Close;
export const DialogPortal = Portal;
export const DialogOverlay = forwardRef<
  ElementRef<typeof Overlay>,
  ComponentPropsWithoutRef<typeof Overlay>
>(({ className, ...props }, ref) => (
  <Overlay ref={ref} className={cn("ui-dialog-overlay", className)} {...props} />
));
DialogOverlay.displayName = "DialogOverlay";
export const DialogContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content> & { showCloseButton?: boolean }
>(({ className, children, showCloseButton = true, onCloseAutoFocus, ...props }, ref) => {
  const origin = useContext(DialogFocus);
  return (
    <Portal>
      <DialogOverlay />
      <Content
        ref={ref}
        className={cn("ui-dialog-content", className)}
        data-over-native-surface
        {...props}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (
            !event.defaultPrevented &&
            origin?.current?.isConnected &&
            origin.current !== document.body
          ) {
            event.preventDefault();
            origin.current.focus({ preventScroll: true });
          }
        }}
      >
        {children}
        {showCloseButton && (
          <Close className="ui-dialog-close" aria-label="Close dialog">
            <X size={16} />
          </Close>
        )}
      </Content>
    </Portal>
  );
});
DialogContent.displayName = "DialogContent";
export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-dialog-header", className)} {...props} />;
}
export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-dialog-footer", className)} {...props} />;
}
export const DialogTitle = forwardRef<
  ElementRef<typeof Title>,
  ComponentPropsWithoutRef<typeof Title>
>(({ className, ...props }, ref) => (
  <Title ref={ref} className={cn("ui-dialog-title", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";
export const DialogDescription = forwardRef<
  ElementRef<typeof Description>,
  ComponentPropsWithoutRef<typeof Description>
>(({ className, ...props }, ref) => (
  <Description ref={ref} className={cn("ui-dialog-description", className)} {...props} />
));
DialogDescription.displayName = "DialogDescription";
