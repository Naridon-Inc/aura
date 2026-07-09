import * as React from "react";
import { Kbd as MedusaKbd } from "@medusajs/ui";

export type KbdProps = React.ComponentPropsWithoutRef<typeof MedusaKbd>;

export const Kbd = React.forwardRef<HTMLElement, KbdProps>((props, ref) => (
  <MedusaKbd ref={ref} {...props} />
));
Kbd.displayName = "Kbd";
