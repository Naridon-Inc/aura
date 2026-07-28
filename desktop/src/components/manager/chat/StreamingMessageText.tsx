//! Streaming assistant prose — renders the live text straight through
//! `MarkdownBody`.
//!
//! This component used to run a 16ms character-by-character "typewriter" drip
//! that re-parsed the ENTIRE markdown document through react-markdown ~60 times
//! a second. That remounted the rendered subtree every frame, which read as
//! terminal-like flicker and — worse — collapsed any text selection the user
//! made mid-stream and dropped clicks on links. The brain already delivers text
//! in coarse chunks (often a whole sentence at a time), so the drip added
//! nothing but churn on top of content that was already arriving smoothly.
//!
//! Now the received `text` is rendered directly: `MarkdownBody` re-parses only
//! when a real chunk lands (a few times a second), the DOM stays stable between
//! chunks, and prose stays selectable / links stay clickable while the turn is
//! still streaming. A trailing cursor marks that the turn is live.

import { MarkdownBody } from "./Markdown";

/** Render streaming assistant prose as live markdown. `streaming` only drives
 *  the trailing cursor now — the text itself is never held back. */
export function StreamingMessageText({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return <MarkdownBody source={text} trailingCursor={streaming} />;
}
