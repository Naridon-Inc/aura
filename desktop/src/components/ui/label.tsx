import { forwardRef, type LabelHTMLAttributes, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipProvider } from "./tooltip";
export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  optional?: boolean;
  hint?: ReactNode;
  size?: "xsmall" | "small" | "base" | "large";
  weight?: "regular" | "plus";
}
export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, children, optional, hint, size = "base", weight = "plus", ...props }, ref) => (
    <label
      ref={ref}
      className={cn("ui-label", className)}
      data-size={size}
      data-weight={weight}
      {...props}
    >
      <span>{children}</span>
      {optional && <span className="ui-label-optional">(Optional)</span>}
      {hint != null && (
        <TooltipProvider>
          <Tooltip content={hint}>
            <button type="button" aria-label="More information" className="ui-label-hint">
              <Info size={12} />
            </button>
          </Tooltip>
        </TooltipProvider>
      )}
    </label>
  ),
);
Label.displayName = "Label";
