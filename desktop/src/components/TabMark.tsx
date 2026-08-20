// The mark a tab wears, resolved once for every surface that lists tabs.
//
// Three surfaces answer the same question — "what is this tab?" — and each
// used to draw its own answer. The split-pane strip drew real icons; the "+"
// picker beside it drew bare text characters (a terminal got "▤", and a FILE
// got "⌘", the Command-key symbol); the empty-pane picker drew a third set of
// hand-rolled SVGs that agreed with neither. Same tab, three marks, and two of
// the three surfaces are one click apart.
//
// `tabGlyph` already owns the destinations that have no icon elsewhere. What
// it deliberately does NOT own is the four kinds that resolve their mark from
// live data — an agent's own brand icon, a file's extension, and the two nav
// destinations that have carried a rail glyph all along. That resolution is
// what this component adds, so a caller gets a finished mark for ANY ref and
// no surface has to invent one again.

import { AgentIcon } from "./agent/AgentIcon";
import { FileIcon } from "./FileIcon";
import * as Icons from "./Icons";
import { tabGlyph } from "./tabGlyphs";
import type { WorkPaneRef } from "../lib/editorStore";

export function TabMark({
  refr,
  label,
  agentId,
  size = 11,
}: {
  refr: WorkPaneRef;
  /** The tab's own label — a file's mark comes from its extension. */
  label: string;
  /** Set for agent-backed tabs: the running agent's brand icon wins, because
   *  telling one Claude from one Gemini is the whole point of the row. */
  agentId?: string;
  size?: number;
}) {
  if (agentId) return <AgentIcon agentId={agentId} size={size} />;
  if (refr.kind === "terminal")
    return <Icons.Terminal size={size} className="opacity-80" />;
  if (refr.kind === "file") return <FileIcon name={label} size={size + 1} />;
  if (refr.kind === "pages") return <Icons.Pages size={size} />;
  if (refr.kind === "tasks")
    return <Icons.Tasks size={size} className="opacity-80" />;
  // Everything else: the mark its sidebar row draws. Null for the handful of
  // destinations that genuinely have none — the caller renders an empty slot
  // rather than a stand-in character that means nothing.
  return <span className="opacity-80">{tabGlyph(refr, size)}</span>;
}

/** The project a foreign tab belongs to, in the words the project switcher
 *  uses — the folder's own name. Tabs from another project used to be badged
 *  "ext" (and "foreign" on the pane picker), which is a word for the app's
 *  benefit rather than the reader's: it says a tab is from somewhere else
 *  without saying where, when naming the place costs the same room. */
export function projectName(root: string): string {
  const parts = (root ?? "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? root ?? "";
}
