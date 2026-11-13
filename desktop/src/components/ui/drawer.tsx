import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type HTMLAttributes,
} from "react";
import { Drawer as Primitive } from "vaul";
import { cn } from "../../lib/utils";
export function Drawer({
  autoFocus = true,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Root>) {
  return <Primitive.Root autoFocus={autoFocus} {...props} />;
}
export const DrawerTrigger = Primitive.Trigger;
export const DrawerClose = Primitive.Close;
export const DrawerPortal = Primitive.Portal;
export const DrawerHandle = Primitive.Handle;
export const DrawerNestedRoot = Primitive.NestedRoot;
export const DrawerOverlay = forwardRef<
  ElementRef<typeof Primitive.Overlay>,
  ComponentPropsWithoutRef<typeof Primitive.Overlay>
>(({ className, ...props }, ref) => (
  <Primitive.Overlay ref={ref} className={cn("ui-dialog-overlay", className)} {...props} />
));
DrawerOverlay.displayName = "DrawerOverlay";
export const DrawerContent = forwardRef<
  ElementRef<typeof Primitive.Content>,
  ComponentPropsWithoutRef<typeof Primitive.Content> & { showHandle?: boolean }
>(({ className, children, showHandle = true, ...props }, ref) => (
  <Primitive.Portal>
    <DrawerOverlay />
    <Primitive.Content
      ref={ref}
      className={cn("ui-drawer-content", className)}
      data-over-native-surface
      {...props}
    >
      {showHandle && <Primitive.Handle className="ui-drawer-handle" />}
      {children}
    </Primitive.Content>
  </Primitive.Portal>
));
DrawerContent.displayName = "DrawerContent";
export const DrawerTitle = forwardRef<
  ElementRef<typeof Primitive.Title>,
  ComponentPropsWithoutRef<typeof Primitive.Title>
>(({ className, ...props }, ref) => (
  <Primitive.Title ref={ref} className={cn("ui-dialog-title", className)} {...props} />
));
DrawerTitle.displayName = "DrawerTitle";
export const DrawerDescription = forwardRef<
  ElementRef<typeof Primitive.Description>,
  ComponentPropsWithoutRef<typeof Primitive.Description>
>(({ className, ...props }, ref) => (
  <Primitive.Description ref={ref} className={cn("ui-dialog-description", className)} {...props} />
));
DrawerDescription.displayName = "DrawerDescription";
export function DrawerHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-dialog-header", className)} {...props} />;
}
export function DrawerFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-dialog-footer", className)} {...props} />;
}
