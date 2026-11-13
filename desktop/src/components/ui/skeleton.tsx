import { type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("ui-skeleton", className)} {...props} />;
}
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="ui-list-skeleton">
      {Array.from({ length: Math.max(0, Math.floor(rows)) }, (_, i) => (
        <div className="ui-list-skeleton-row" key={i}>
          <Skeleton className="size-8" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-2 w-1/4" />
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
