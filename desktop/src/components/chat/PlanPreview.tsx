import { useState, type ReactNode } from "react";
import { ChevronDown, FileText, ArrowUpRight } from "lucide-react";
import "./ChatComposer.css";

/** A plan stays in the conversation until the reader chooses to open it.
 * Transport-specific approval actions are supplied by the owning surface. */
export function PlanPreview({ title, summary, meta, status, onOpen, children, actions, extra }: {
  title: string;
  summary?: string;
  meta?: ReactNode;
  status?: string;
  onOpen?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  extra?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = !!children && (onOpen || expanded);
  return <section className="chat-plan-preview" aria-label={`Plan: ${title}`}>
    <button type="button" className="chat-plan-heading" onClick={() => onOpen ? onOpen() : setExpanded(v => !v)} aria-expanded={onOpen ? undefined : expanded}>
      <FileText size={17} strokeWidth={1.6} aria-hidden />
      <span className="chat-plan-title"><strong>{title}</strong><span>{status || "Plan"}</span></span>
      {onOpen ? <ArrowUpRight size={15} aria-hidden /> : <ChevronDown size={15} style={{ transform: expanded ? "rotate(180deg)" : undefined }} aria-hidden />}
    </button>
    {summary && <p className="chat-plan-summary">{summary}</p>}
    {visible && <div className="chat-plan-document">{children}</div>}
    {(meta || actions) && <footer className="chat-plan-footer"><span className="chat-plan-meta">{meta}</span><div className="chat-plan-actions">{actions}</div></footer>}
    {extra}
  </section>;
}
