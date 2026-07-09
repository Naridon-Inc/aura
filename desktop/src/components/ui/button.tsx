// Button primitive — shadcn pattern (CVA + Slot for asChild). First
// proof of the design-system migration; subsequent primitives copy
// this shape so consumers see one uniform API.
//
// Variants follow the canonical shadcn set (default / destructive /
// outline / secondary / ghost / link) re-themed against our arctic
// tokens. Sizes mirror Superset's recipe — h-7 (xs) is pulled in
// for chrome-density buttons that previously hand-rolled their own
// size classes.
//
// `asChild` lets a consumer render `<Button asChild><a href=…>` so
// links inherit the variant styling without nesting <a> in <button>.

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  // One radius (6px) and one type size for every button so the strip
  // reads as a set. Filled variants layer the metallic skin on top;
  // low-emphasis variants stay flat so the emphasis hierarchy holds.
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Filled variants share the metallic 3D skin (.btn3d-* in
        // styles.css). Low-emphasis variants stay flat so the emphasis
        // hierarchy still reads.
        default:
          "btn3d btn3d-primary",
        destructive:
          "btn3d btn3d-danger",
        outline:
          "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground transition-colors",
        secondary:
          "btn3d btn3d-neutral",
        // Colored-but-calm — wears the same metallic 3D skin as the rest
        // of the button family (.btn3d) but in a muted brand green, so a
        // full-width sidebar create CTA (New workspace, New task) reads as
        // "has color" yet stays consistent with every other button. A flat
        // tinted fill broke that consistency — it had color but no depth.
        accentSoft:
          "btn3d btn3d-accent",
        // Quiet, low-emphasis member of the 3D family (Medusa "secondary"
        // feel): a flat bg-2 fill with a hairline raise instead of the
        // metallic gradient + stacked drop shadows. Reads as a real,
        // pressable button (it lifts on hover, sinks on active) but sits a
        // level below `secondary` so it suits row actions, "View on
        // GitHub", and other supporting buttons without shouting.
        subtle:
          "btn3d btn3d-subtle",
        ghost:
          "hover:bg-accent hover:text-accent-foreground transition-colors",
        link:
          "text-primary underline-offset-4 hover:underline transition-colors",
      },
      // Tighter, consistent scale — heights step 24/26/28/32, shared
      // radius from the base. `default` is the everyday chrome button.
      size: {
        default:  "h-7 px-3",
        xs:       "h-6 px-2",
        sm:       "h-[26px] px-2.5",
        lg:       "h-8 px-4 text-[12.5px]",
        icon:     "h-7 w-7",
        "icon-sm": "h-6 w-6",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
