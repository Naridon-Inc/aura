import * as React from "react";
import { Tooltip as MedusaTooltip, TooltipProvider } from "@medusajs/ui";

import { cn } from "../../lib/utils";

type MedusaTooltipProps = React.ComponentPropsWithoutRef<typeof MedusaTooltip>;

type TooltipProps = Omit<MedusaTooltipProps, "children" | "content"> & {
  children?: React.ReactNode;
  content?: React.ReactNode;
};

type TooltipTriggerProps = React.HTMLAttributes<HTMLElement> & {
  asChild?: boolean;
  children?: React.ReactNode;
};

type TooltipContentProps = Omit<MedusaTooltipProps, "children" | "content"> & {
  children?: React.ReactNode;
};

function TooltipTrigger({ children }: TooltipTriggerProps) {
  return <>{children}</>;
}
TooltipTrigger.displayName = "TooltipTrigger";

function TooltipContent(_props: TooltipContentProps) {
  return null;
}
TooltipContent.displayName = "TooltipContent";

function isElementOfType<P>(child: React.ReactNode, type: React.ComponentType<P>): child is React.ReactElement<P> {
  return React.isValidElement(child) && child.type === type;
}

function Tooltip({ children, content: explicitContent, className, side, sideOffset, ...props }: TooltipProps) {
  let trigger: React.ReactNode = null;
  let content = explicitContent;
  let contentClassName = className;
  let contentSide = side;
  let contentSideOffset = sideOffset;

  React.Children.forEach(children, (child) => {
    if (isElementOfType<TooltipTriggerProps>(child, TooltipTrigger)) {
      trigger = child.props.children;
      return;
    }
    if (isElementOfType<TooltipContentProps>(child, TooltipContent)) {
      content = child.props.children;
      contentClassName = cn(contentClassName, child.props.className);
      contentSide = child.props.side ?? contentSide;
      contentSideOffset = child.props.sideOffset ?? contentSideOffset;
      return;
    }
    if (trigger == null) trigger = child;
  });

  if (content == null) return <>{trigger}</>;

  return (
    <MedusaTooltip
      content={content}
      className={contentClassName}
      side={contentSide}
      sideOffset={contentSideOffset}
      {...props}
    >
      {trigger}
    </MedusaTooltip>
  );
}
Tooltip.displayName = "Tooltip";

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
