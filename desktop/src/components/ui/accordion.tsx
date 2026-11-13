import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root, Item, Header, Trigger, Content } from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
export const Accordion = Root;
export const AccordionItem = forwardRef<
  ElementRef<typeof Item>,
  ComponentPropsWithoutRef<typeof Item>
>(({ className, ...props }, ref) => (
  <Item ref={ref} className={cn("ui-accordion-item", className)} {...props} />
));
AccordionItem.displayName = "AccordionItem";
export const AccordionTrigger = forwardRef<
  ElementRef<typeof Trigger>,
  ComponentPropsWithoutRef<typeof Trigger>
>(({ className, children, ...props }, ref) => (
  <Header>
    <Trigger ref={ref} className={cn("ui-accordion-trigger", className)} {...props}>
      {children}
      <ChevronDown size={14} />
    </Trigger>
  </Header>
));
AccordionTrigger.displayName = "AccordionTrigger";
export const AccordionContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content>
>(({ className, ...props }, ref) => (
  <Content ref={ref} className={cn("ui-accordion-content", className)} {...props} />
));
AccordionContent.displayName = "AccordionContent";
