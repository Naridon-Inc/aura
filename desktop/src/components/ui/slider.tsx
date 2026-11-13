import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root, Track, Range, Thumb } from "@radix-ui/react-slider";
import { cn } from "../../lib/utils";
export const Slider = forwardRef<
  ElementRef<typeof Root>,
  ComponentPropsWithoutRef<typeof Root> & { thumbLabels?: string[] }
>(({ className, value, defaultValue = [0], thumbLabels, ...props }, ref) => (
  <Root
    ref={ref}
    className={cn("ui-slider", className)}
    value={value}
    defaultValue={defaultValue}
    {...props}
  >
    <Track className="ui-slider-track">
      <Range className="ui-slider-range" />
    </Track>
    {(value ?? defaultValue).map((_, index) => (
      <Thumb
        key={index}
        className="ui-slider-thumb"
        aria-label={
          thumbLabels?.[index] ??
          (props["aria-label"]
            ? `${props["aria-label"]}${(value ?? defaultValue).length > 1 ? ` ${index + 1}` : ""}`
            : `Value ${index + 1}`)
        }
      />
    ))}
  </Root>
));
Slider.displayName = "Slider";
