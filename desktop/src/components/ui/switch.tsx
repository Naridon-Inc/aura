import * as React from "react";
import { Switch as MedusaSwitch } from "@medusajs/ui";

export const Switch = React.forwardRef<
  React.ElementRef<typeof MedusaSwitch>,
  React.ComponentPropsWithoutRef<typeof MedusaSwitch>
>((props, ref) => <MedusaSwitch ref={ref} {...props} />);
Switch.displayName = "Switch";
