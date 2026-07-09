// MermaidCodeBlock — Tiptap NodeView wrapper for the StarterKit
// codeBlock node. When the block's `language` attr is "mermaid", the
// view flips between an editable source pane and a live SVG preview.
// Non-mermaid code blocks fall through to the normal <pre><code>
// rendering with no diagram chrome.

import { useState } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { Code as CodeIcon, Eye, Pencil } from "lucide-react";
import CodeBlock from "@tiptap/extension-code-block";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MermaidDiagram } from "./MermaidDiagram";
import { cn } from "../../lib/utils";

function CodeBlockView({ node, updateAttributes }: ReactNodeViewProps) {
  const language: string | undefined =
    (node.attrs as { language?: string | null }).language ?? undefined;
  const isMermaid = (language ?? "").toLowerCase() === "mermaid";
  const [mode, setMode] = useState<"preview" | "edit">(
    isMermaid ? "preview" : "edit",
  );

  if (!isMermaid) {
    return (
      <NodeViewWrapper
        as="div"
        className="tiptap-codeblock my-2 rounded-md bg-bg-2 overflow-hidden"
      >
        <pre className="p-3 m-0 text-[12.5px] leading-5">
          <NodeViewContent<"code"> as="code" />
        </pre>
      </NodeViewWrapper>
    );
  }

  const source = node.textContent;

  return (
    <NodeViewWrapper
      as="div"
      className="tiptap-mermaid my-2 rounded-md border border-line-soft overflow-hidden bg-bg-card"
    >
      <div
        className="flex items-center justify-between px-2 py-1 border-b border-line-soft bg-bg-2/60"
        contentEditable={false}
      >
        <div className="flex items-center gap-1.5 text-text-4">
          <CodeIcon className="w-3 h-3" strokeWidth={1.5} />
          <span className="t-2xs t-ui uppercase tracking-wider">mermaid</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={cn(
              "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px]",
              mode === "preview"
                ? "bg-bg-1 text-text-1"
                : "text-text-4 hover:text-text-1 hover:bg-bg-2",
            )}
            aria-pressed={mode === "preview"}
            title="Preview diagram"
          >
            <Eye className="w-3 h-3" strokeWidth={1.5} />
            Preview
          </button>
          <button
            type="button"
            onClick={() => setMode("edit")}
            className={cn(
              "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px]",
              mode === "edit"
                ? "bg-bg-1 text-text-1"
                : "text-text-4 hover:text-text-1 hover:bg-bg-2",
            )}
            aria-pressed={mode === "edit"}
            title="Edit source"
          >
            <Pencil className="w-3 h-3" strokeWidth={1.5} />
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              const next = (language ?? "").toLowerCase() === "mermaid"
                ? ""
                : "mermaid";
              updateAttributes({ language: next || null });
            }}
            className="h-6 px-2 inline-flex items-center text-[11px] text-text-4 hover:text-text-1 hover:bg-bg-2 rounded"
            title="Convert back to a plain code block"
          >
            Plain
          </button>
        </div>
      </div>

      {mode === "edit" ? (
        <pre className="p-3 m-0 text-[12.5px] leading-5 bg-bg-2">
          <NodeViewContent<"code"> as="code" />
        </pre>
      ) : (
        <div contentEditable={false} className="p-0">
          {source.trim().length > 0 ? (
            <MermaidDiagram code={source} minHeight={120} />
          ) : (
            <div className="t-xs italic px-3 py-6 text-center text-text-3">
              Empty diagram — switch to Edit and add mermaid source.
            </div>
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const MermaidAwareCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
