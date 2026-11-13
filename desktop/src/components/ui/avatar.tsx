import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root, Image, Fallback } from "@radix-ui/react-avatar";
import { cn } from "../../lib/utils";
export const Avatar = forwardRef<ElementRef<typeof Root>, ComponentPropsWithoutRef<typeof Root>>(
  ({ className, ...props }, ref) => (
    <Root ref={ref} className={cn("ui-avatar", className)} {...props} />
  ),
);
Avatar.displayName = "Avatar";
export const AvatarImage = forwardRef<
  ElementRef<typeof Image>,
  ComponentPropsWithoutRef<typeof Image>
>(({ className, ...props }, ref) => (
  <Image ref={ref} className={cn("ui-avatar-image", className)} {...props} />
));
AvatarImage.displayName = "AvatarImage";
export const AvatarFallback = forwardRef<
  ElementRef<typeof Fallback>,
  ComponentPropsWithoutRef<typeof Fallback>
>(({ className, ...props }, ref) => (
  <Fallback ref={ref} className={cn("ui-avatar-fallback", className)} {...props} />
));
AvatarFallback.displayName = "AvatarFallback";
