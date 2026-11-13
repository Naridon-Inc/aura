import {
  createContext,
  useContext,
  forwardRef,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";
import { Root, Trigger, Content, Portal, Provider } from "@radix-ui/react-tooltip";
import { cn } from "../../lib/utils";
const TooltipProviderContext = createContext(false);
export function TooltipProvider({ children, ...props }: ComponentPropsWithoutRef<typeof Provider>) {
  return <TooltipProviderContext.Provider value={true}><Provider {...props}>{children}</Provider></TooltipProviderContext.Provider>;
}
type ContentProps = ComponentPropsWithoutRef<typeof Content>;
type TooltipProps = ComponentPropsWithoutRef<typeof Root> &
  Pick<ContentProps, "side" | "sideOffset" | "align" | "alignOffset" | "className"> & {
    content?: ReactNode;
  };
export function Tooltip({
  children,
  content,
  className,
  side,
  sideOffset,
  align,
  alignOffset,
  ...props
}: TooltipProps) {
  const hasProvider = useContext(TooltipProviderContext);
  const tooltip = content === undefined ? <Root {...props}>{children}</Root> : (
    <Root {...props}>
      <Trigger asChild>{isValidElement(children) ? children : <span>{children}</span>}</Trigger>
      <TooltipContent
        className={className}
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
      >
        {content}
      </TooltipContent>
    </Root>
  );
  return hasProvider ? tooltip : <TooltipProvider delayDuration={250}>{tooltip}</TooltipProvider>;
}
export const TooltipTrigger = Trigger;
export const TooltipContent = forwardRef<ElementRef<typeof Content>, ContentProps>(
  ({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
    <Portal>
      <Content
        ref={ref}
        className={cn("ui-tooltip", className)}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...props}
      />
    </Portal>
  ),
);
TooltipContent.displayName = "TooltipContent";
