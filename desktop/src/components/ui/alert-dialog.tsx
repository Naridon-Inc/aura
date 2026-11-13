import {
  createContext,
  useContext,
  useRef,
  useState,
  type RefObject,
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import {
  Root,
  Trigger,
  Portal,
  Overlay,
  Content,
  Title,
  Description,
  Action,
  Cancel,
} from "@radix-ui/react-alert-dialog";
import { cn } from "../../lib/utils";
import { buttonVariants } from "./button";
export { DialogHeader as AlertDialogHeader, DialogFooter as AlertDialogFooter } from "./dialog";
const AlertDialogFocus = createContext<RefObject<HTMLElement | null> | null>(null);
export function AlertDialog({
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
    <AlertDialogFocus.Provider value={origin}>
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
    </AlertDialogFocus.Provider>
  );
}
export const AlertDialogTrigger = Trigger;
export const AlertDialogPortal = Portal;
export const AlertDialogOverlay = forwardRef<
  ElementRef<typeof Overlay>,
  ComponentPropsWithoutRef<typeof Overlay>
>(({ className, ...props }, ref) => (
  <Overlay ref={ref} className={cn("ui-dialog-overlay", className)} {...props} />
));
AlertDialogOverlay.displayName = "AlertDialogOverlay";
export const AlertDialogContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content>
>(({ className, onCloseAutoFocus, ...props }, ref) => {
  const origin = useContext(AlertDialogFocus);
  return (
    <Portal>
      <AlertDialogOverlay />
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
      />
    </Portal>
  );
});
AlertDialogContent.displayName = "AlertDialogContent";
export const AlertDialogTitle = forwardRef<
  ElementRef<typeof Title>,
  ComponentPropsWithoutRef<typeof Title>
>(({ className, ...props }, ref) => (
  <Title ref={ref} className={cn("ui-dialog-title", className)} {...props} />
));
AlertDialogTitle.displayName = "AlertDialogTitle";
export const AlertDialogDescription = forwardRef<
  ElementRef<typeof Description>,
  ComponentPropsWithoutRef<typeof Description>
>(({ className, ...props }, ref) => (
  <Description ref={ref} className={cn("ui-dialog-description", className)} {...props} />
));
AlertDialogDescription.displayName = "AlertDialogDescription";
export const AlertDialogAction = forwardRef<
  ElementRef<typeof Action>,
  ComponentPropsWithoutRef<typeof Action>
>(({ className, ...props }, ref) => (
  <Action ref={ref} className={cn(buttonVariants(), className)} {...props} />
));
AlertDialogAction.displayName = "AlertDialogAction";
export const AlertDialogCancel = forwardRef<
  ElementRef<typeof Cancel>,
  ComponentPropsWithoutRef<typeof Cancel>
>(({ className, ...props }, ref) => (
  <Cancel ref={ref} className={cn(buttonVariants({ variant: "outline" }), className)} {...props} />
));
AlertDialogCancel.displayName = "AlertDialogCancel";
