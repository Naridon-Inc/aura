import * as React from "react";
import { Checkbox as MedusaCheckbox } from "@medusajs/ui";

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof MedusaCheckbox>,
  React.ComponentPropsWithoutRef<typeof MedusaCheckbox>
>((props, ref) => <MedusaCheckbox ref={ref} {...props} />);
Checkbox.displayName = "Checkbox";
