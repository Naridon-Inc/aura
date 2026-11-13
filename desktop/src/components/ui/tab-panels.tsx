import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root, List, Trigger, Content } from "@radix-ui/react-tabs";
import { cn } from "../../lib/utils";
export const Tabs = Root;
export const TabsList = forwardRef<ElementRef<typeof List>, ComponentPropsWithoutRef<typeof List>>(
  ({ className, ...props }, ref) => (
    <List ref={ref} className={cn("ui-tabs-list", className)} {...props} />
  ),
);
TabsList.displayName = "TabsList";
export const TabsTrigger = forwardRef<
  ElementRef<typeof Trigger>,
  ComponentPropsWithoutRef<typeof Trigger>
>(({ className, ...props }, ref) => (
  <Trigger ref={ref} className={cn("ui-tabs-trigger", className)} {...props} />
));
TabsTrigger.displayName = "TabsTrigger";
export const TabsContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content>
>(({ className, ...props }, ref) => (
  <Content ref={ref} className={cn("ui-tabs-content", className)} {...props} />
));
TabsContent.displayName = "TabsContent";
