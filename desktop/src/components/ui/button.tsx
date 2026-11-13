import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

export const buttonVariants = cva("ui-button", {
  variants: {
    variant: {
      default: "ui-button-primary",
      destructive: "ui-button-danger",
      outlineDestructive: "ui-button-outline-danger",
      outline: "ui-button-outline",
      secondary: "ui-button-secondary",
      ghost: "ui-button-ghost",
      link: "ui-button-link",
      accentSoft: "ui-button-secondary",
      subtle: "ui-button-secondary",
    },
    size: {
      default: "ui-control-md",
      xs: "ui-control-xs",
      sm: "ui-control-sm",
      lg: "ui-control-lg",
      icon: "ui-control-md ui-control-icon",
      "icon-sm": "ui-control-xs ui-control-icon",
      iconSm: "ui-control-sm ui-control-icon",
      iconXs: "ui-control-xs ui-control-icon",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Control = asChild ? Slot : "button";
    return (
      <Control
        ref={ref}
        type={asChild ? type : (type ?? "button")}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
