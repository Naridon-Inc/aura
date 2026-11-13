import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root, Indicator } from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "../../lib/utils";
type CheckboxProps = ComponentPropsWithoutRef<typeof Root>;
export const Checkbox = forwardRef<ElementRef<typeof Root>, CheckboxProps>(
  ({ className, checked, defaultChecked, ...props }, ref) => (
    <Root
      ref={ref}
      checked={checked}
      defaultChecked={defaultChecked}
      className={cn("ui-checkbox", className)}
      {...props}
    >
      <Indicator className="ui-checkbox-indicator">
        {checked === "indeterminate" ||
        (checked === undefined && defaultChecked === "indeterminate") ? (
          <Minus size={12} />
        ) : (
          <Check size={12} />
        )}
      </Indicator>
    </Root>
  ),
);
Checkbox.displayName = "Checkbox";
