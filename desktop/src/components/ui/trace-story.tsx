// A Trace page read as a story. One narrow column; a line of counts with an
// optional switch at its end; a sentence on how to read what follows; then the
// moments on the shared timeline, newest first. Every Trace view, and every
// detail opened from one, is drawn on these, so the whole of Trace reads the
// way its sealed-records chain always has.

import { type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "./button";
import { TraceCaption } from "./trace-detail";
import "./trace-page.css";
import "./trace-story.css";

/** The page: a centred column that scrolls, with an optional footer bar. */
export function TraceStory({
  label,
  width = 720,
  footer,
  children,
}: {
  label: string;
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-trace-tool" aria-label={label}>
      <div className="ui-trace-tool-scroll">
        <div className="ui-trace-tool-column ui-trace-story" style={{ maxWidth: width }}>
          {children}
        </div>
      </div>
      {footer && <footer className="ui-trace-tool-footer">{footer}</footer>}
    </section>
  );
}

/** The count line at the top: an icon, a few figures, and the one control the
 *  page has (a switch or a link), pushed to the end. */
export function TraceStoryHead({
  icon,
  control,
  children,
}: {
  icon?: ReactNode;
  control?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ui-trace-story-head">
      {icon}
      <span>{children}</span>
      {control && <div className="ui-trace-story-control">{control}</div>}
    </div>
  );
}

/** How to read the page, in a sentence or two. */
export function TraceStoryIntro({ children }: { children: ReactNode }) {
  return <p className="ui-trace-story-intro">{children}</p>;
}

/** The way back from a detail to the list it was opened from, and, at the
 *  other end of the same line, what can be done with what is being read. */
export function TraceStoryBack({
  onBack,
  actions,
  children = "Back",
}: {
  onBack: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const back = (
    <Button variant="ghost" size="xs" className="ui-trace-story-back" onClick={onBack} title="Back (Esc)">
      <ArrowLeft />
      {children}
    </Button>
  );
  if (!actions) return back;
  return (
    <div className="ui-trace-story-backbar">
      {back}
      <div className="ui-trace-story-control">{actions}</div>
    </div>
  );
}

/** A detail's headline and the one muted line of facts under it. */
export function TraceStoryTitle({ meta, children }: { meta?: ReactNode; children: ReactNode }) {
  return (
    <header className="ui-trace-story-title">
      <h2>{children}</h2>
      {meta && <div className="ui-trace-story-meta">{meta}</div>}
    </header>
  );
}

/** One chapter of a detail: a quiet caption, then what happened. */
export function TraceStoryChapter({
  title,
  trailing,
  children,
}: {
  title: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-trace-story-chapter">
      <TraceCaption trailing={trailing}>{title}</TraceCaption>
      {children}
    </section>
  );
}

/** Running prose inside a chapter: what was asked, what the agent said. */
export function TraceStoryText({ children }: { children: ReactNode }) {
  return <div className="ui-trace-story-text">{children}</div>;
}

/** The muted line of facts under a moment's title: each fact a span, a lock
 *  or a mark where it carries one. */
export function TraceStoryMeta({ children }: { children: ReactNode }) {
  return <span className="ui-trace-story-meta">{children}</span>;
}

/** A day's moments: the day as a caption, its timeline under it. */
export function TraceStoryDay({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <section className="ui-trace-story-day">
      <TraceCaption>{label}</TraceCaption>
      {children}
    </section>
  );
}
