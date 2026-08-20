import { Skeleton as MedusaSkeleton } from "@medusajs/ui";

export function Skeleton(props: React.ComponentPropsWithoutRef<typeof MedusaSkeleton>) {
  return <MedusaSkeleton aria-hidden {...props} />;
}

// `TaskCardSkeleton` / `BoardColumnSkeleton` used to live here, drawing ghost
// cards while a board loaded. They're gone: every board now loads through the
// shared `BoardColumn`, which shows the app's one block loader (AsciiSpinner)
// instead of pretending cards are already there. Two loading idioms for the
// same wait was one too many.

export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex flex-col" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
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
