import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Command as Primitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./dialog";
export const Command = forwardRef<
  ElementRef<typeof Primitive>,
  ComponentPropsWithoutRef<typeof Primitive>
>(({ className, ...props }, ref) => (
  <Primitive ref={ref} className={cn("ui-command", className)} {...props} />
));
Command.displayName = "Command";
export function CommandDialog({
  children,
  title = "Commands",
  description = "Search for an action and press Enter to select it.",
  onCloseAutoFocus,
  commandProps,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Dialog> & {
  title?: string;
  description?: string;
  /** Added to the dialog's own class, for a dialog sized for its content. */
  className?: string;
  onCloseAutoFocus?: ComponentPropsWithoutRef<typeof DialogContent>["onCloseAutoFocus"];
  /** Passed to the inner Command, for a caller that ranks its own results
   *  (`shouldFilter={false}`) or drives the selection (`value`). */
  commandProps?: ComponentPropsWithoutRef<typeof Command>;
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn("ui-command-dialog", className)}
        showCloseButton={false}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command {...commandProps}>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}
export const CommandInput = forwardRef<
  ElementRef<typeof Primitive.Input>,
  ComponentPropsWithoutRef<typeof Primitive.Input> & {
    /** Drawn between the search icon and the field (a scope chip). */
    leading?: ReactNode;
    /** Drawn after the field (a loader). */
    trailing?: ReactNode;
  }
>(({ className, leading, trailing, ...props }, ref) => (
  <div className="ui-command-search">
    <Search size={16} />
    {leading}
    <Primitive.Input ref={ref} className={cn("ui-command-input", className)} {...props} />
    {trailing}
  </div>
));
CommandInput.displayName = "CommandInput";
export const CommandList = forwardRef<
  ElementRef<typeof Primitive.List>,
  ComponentPropsWithoutRef<typeof Primitive.List>
>(({ className, ...props }, ref) => (
  <Primitive.List ref={ref} className={cn("ui-command-list", className)} {...props} />
));
CommandList.displayName = "CommandList";
export const CommandEmpty = forwardRef<
  ElementRef<typeof Primitive.Empty>,
  ComponentPropsWithoutRef<typeof Primitive.Empty>
>(({ className, ...props }, ref) => (
  <Primitive.Empty ref={ref} className={cn("ui-command-empty", className)} {...props} />
));
CommandEmpty.displayName = "CommandEmpty";
export const CommandGroup = forwardRef<
  ElementRef<typeof Primitive.Group>,
  ComponentPropsWithoutRef<typeof Primitive.Group>
>(({ className, ...props }, ref) => (
  <Primitive.Group ref={ref} className={cn("ui-command-group", className)} {...props} />
));
CommandGroup.displayName = "CommandGroup";
export const CommandItem = forwardRef<
  ElementRef<typeof Primitive.Item>,
  ComponentPropsWithoutRef<typeof Primitive.Item>
>(({ className, ...props }, ref) => (
  <Primitive.Item ref={ref} className={cn("ui-menu-row ui-command-item", className)} {...props} />
));
CommandItem.displayName = "CommandItem";
export const CommandSeparator = forwardRef<
  ElementRef<typeof Primitive.Separator>,
  ComponentPropsWithoutRef<typeof Primitive.Separator>
>(({ className, ...props }, ref) => (
  <Primitive.Separator ref={ref} className={cn("ui-menu-separator", className)} {...props} />
));
CommandSeparator.displayName = "CommandSeparator";
export function CommandShortcut({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("ui-menu-shortcut", className)} {...props} />;
}
export const CommandLoading = Primitive.Loading;
