// The model's reasoning, folded to one line above the answer: "Thinking…"
// with a spinner while it is still being written, "Thought for Ns" once it
// settles, and "Thought process" for a reasoning block read back from history,
// whose duration was never recorded.

import { useEffect, useRef, useState } from "react";

import { ToolCall } from "../../ui/message";
import { MarkdownBody } from "./Markdown";

/** One reasoning disclosure. The duration is self-measured: the clock starts
 *  the first time the block is seen live and stops when streaming ends, so a
 *  settled thought reads "Thought for Ns" without the parent threading a
 *  timestamp. Always the same element, so a disclosure the reader opened mid-
 *  thought stays open when the thought settles. */
export function ReasoningBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const startRef = useRef<number | null>(null);
  const [durationSec, setDurationSec] = useState<number | null>(null);

  if (streaming && startRef.current == null) {
    startRef.current = Date.now();
  }

  useEffect(() => {
    if (!streaming && startRef.current != null && durationSec == null) {
      const secs = Math.max(1, Math.round((Date.now() - startRef.current) / 1000));
      setDurationSec(secs);
    }
  }, [streaming, durationSec]);

  if (!text.trim()) return null;

  const title = streaming
    ? "Thinking…"
    : durationSec != null
      ? `Thought for ${durationSec}s`
      : "Thought process";

  return (
    <ToolCall title={title} status={streaming ? "running" : "done"}>
      <MarkdownBody source={text} trailingCursor={streaming} />
    </ToolCall>
  );
}
