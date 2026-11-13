// The workspace details panel: the right sidebar's tab strip (with overflow
// arrows, the Review toggle and file search), the filter box, the change-scope
// row, the review checklist rows and the file preview. Every piece is
// controlled — the caller owns the tab, the query and the data.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Eye, Search } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tab-panels";
import { Button } from "./button";
import { Input } from "./input";
import { Checkbox } from "./checkbox";
import { DiffCount } from "./sidebar";
import { cn } from "../../lib/utils";
import "./details-panel.css";

export interface DetailsTab {
  value: string;
  label: string;
  /** Drawn as a small count after the label when above zero. */
  count?: number;
}

export interface DetailsSearch {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Enter in the box — a search past what the filter can do, such as the
   *  words inside the files. Omitted, Enter does nothing. */
  onSubmit?: (query: string) => void;
}

/** Tracks whether a horizontally scrolling strip has hidden tabs on either
 *  side, so the arrows only show when there is somewhere to scroll. */
function useOverflow() {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      setOverflow({
        left: element.scrollLeft > 1,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update);
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, []);
  return [ref, overflow] as const;
}

export function DetailsTabs({
  tabs,
  value,
  onValueChange,
  reviewValue,
  search,
  children,
}: {
  tabs: DetailsTab[];
  value: string;
  onValueChange: (value: string) => void;
  /** The tab the Review button opens. Omitted, there is no Review button. */
  reviewValue?: string;
  search?: DetailsSearch;
  children: ReactNode;
}) {
  const [tabsRef, overflow] = useOverflow();
  return (
    <Tabs className="ui-details-body" value={value} onValueChange={onValueChange}>
      <div className="ui-details-toolbar">
        {overflow.left && (
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Scroll details tabs left"
            onClick={() => tabsRef.current?.scrollBy({ left: -120, behavior: "smooth" })}
          >
            <ChevronLeft />
          </Button>
        )}
        <TabsList ref={tabsRef} className="ui-details-tabs" aria-label="Workspace details tabs">
          {tabs.map((tab) => {
            const counted = tab.count != null && tab.count > 0;
            // The count sits flush against the word on screen; the
            // accessible name keeps them apart so it reads as a number.
            return (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                aria-label={counted ? `${tab.label} · ${tab.count}` : undefined}
              >
                {tab.label}
                {counted && <small>{tab.count}</small>}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {overflow.right && (
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Scroll details tabs right"
            onClick={() => tabsRef.current?.scrollBy({ left: 120, behavior: "smooth" })}
          >
            <ChevronRight />
          </Button>
        )}
        {reviewValue && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onValueChange(reviewValue)}
            aria-pressed={value === reviewValue}
          >
            <Eye size={14} />
            Review
          </Button>
        )}
        {search && (
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Search files"
            aria-pressed={search.open}
            onClick={() => {
              if (search.open) search.onQueryChange("");
              search.onOpenChange(!search.open);
            }}
          >
            <Search />
          </Button>
        )}
      </div>
      {search?.open && (
        <Input
          autoFocus
          className="ui-details-search"
          aria-label="Filter files"
          placeholder="Filter files…"
          value={search.query}
          onChange={(event) => search.onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && search.onSubmit && search.query.trim()) {
              event.preventDefault();
              search.onSubmit(search.query.trim());
              return;
            }
            if (event.key !== "Escape") return;
            search.onQueryChange("");
            search.onOpenChange(false);
          }}
        />
      )}
      {children}
    </Tabs>
  );
}

/** One tab's body. `forceMount` keeps a panel alive once it has been opened,
 *  so a terminal or a scrolled list survives switching away and back. */
export function DetailsTabPanel({
  value,
  keepMounted,
  className,
  children,
}: {
  value: string;
  keepMounted?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TabsContent
      value={value}
      forceMount={keepMounted ? true : undefined}
      className={cn("ui-details-panel", className)}
    >
      {children}
    </TabsContent>
  );
}

/** The row above a change list: the scope picker on the left, the totals on
 *  the right. */
export function DetailsChangeScope({ children }: { children: ReactNode }) {
  return <div className="ui-details-change-scope">{children}</div>;
}

export function DetailsCaption({ children }: { children: ReactNode }) {
  return <div className="ui-details-caption">{children}</div>;
}

export function DetailsReviewRow({
  name,
  title,
  added,
  removed,
  reviewed,
  onReviewedChange,
  onOpen,
}: {
  name: string;
  title?: string;
  added: number;
  removed: number;
  reviewed: boolean;
  onReviewedChange: (reviewed: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <div className="ui-details-review-row">
      <Checkbox
        aria-label={`Mark ${name} reviewed`}
        checked={reviewed}
        onCheckedChange={(next) => onReviewedChange(next === true)}
      />
      <button type="button" title={title} onClick={onOpen}>
        {name}
      </button>
      <DiffCount added={added} removed={removed} />
    </div>
  );
}

export function DetailsFilePreview({
  name,
  onClose,
  children,
}: {
  name: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section className="ui-details-file-preview">
      <header>
        <span>{name}</span>
        <Button variant="ghost" size="xs" onClick={onClose}>
          Close file
        </Button>
      </header>
      <pre>{children}</pre>
    </section>
  );
}
