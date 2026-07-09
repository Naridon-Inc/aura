import { Skeleton as MedusaSkeleton } from "@medusajs/ui";

export function Skeleton(props: React.ComponentPropsWithoutRef<typeof MedusaSkeleton>) {
  return <MedusaSkeleton aria-hidden {...props} />;
}

export function TaskCardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-ui-bg-base p-3 shadow-borders-base">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}

export function BoardColumnSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <TaskCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex flex-col" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-ui-border-base px-4 py-3">
          <Skeleton className="h-8 w-8 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-2.5 w-1/4" />
          </div>
          <Skeleton className="h-2.5 w-16" />
        </div>
      ))}
    </div>
  );
}
