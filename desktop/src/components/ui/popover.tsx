import * as React from "react";
import { Popover as MedusaPopover } from "@medusajs/ui";

import { cn } from "../../lib/utils";

const Popover = MedusaPopover;
const PopoverTrigger = MedusaPopover.Trigger;
const PopoverAnchor = MedusaPopover.Anchor;

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof MedusaPopover.Content>,
  React.ComponentPropsWithoutRef<typeof MedusaPopover.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <MedusaPopover.Content
    ref={ref}
    align={align}
    sideOffset={sideOffset}
    className={cn("w-72 p-4", className)}
    {...props}
  />
));
PopoverContent.displayName = "PopoverContent";

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
