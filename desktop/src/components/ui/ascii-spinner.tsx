import { type CSSProperties } from "react";
import { cn } from "../../lib/utils";
export function AsciiSpinner({ className, size = 12 }: { className?: string; size?: number }) {
  return (
    <span
      className={cn("ui-activity-loader", className)}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      {Array.from({ length: 6 }, (_, index) => (
        <i key={index} style={{ "--activity-phase": index } as CSSProperties} />
      ))}
    </span>
  );
}
