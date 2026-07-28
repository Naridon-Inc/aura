// MermaidCodeBlock — Tiptap NodeView wrapper for the code block node.
//
// • language === "mermaid"  → flips between an editable source pane and a
//   live SVG preview.
// • any other language      → a single clean code surface with a slim header
//   (language picker + copy). Syntax colours are painted separately by the
//   CodeHighlight decoration plugin (see tiptap/codeHighlight.ts), so the
//   text here stays fully editable.

import { useState } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { Code as CodeIcon, Eye, Pencil, Copy, Check } from "lucide-react";
import CodeBlock from "@tiptap/extension-code-block";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MermaidDiagram } from "./MermaidDiagram";
import {
  resolvePrismLanguage,
  LANGUAGE_OPTIONS,
} from "./tiptap/codeHighlight";
import { cn } from "../../lib/utils";

// Copy-to-clipboard affordance for the code header bar.
function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        void navigator.clipboard.writeText(getText()).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="tiptap-codeblock__btn"
      title={copied ? "Copied" : "Copy code"}
      aria-label="Copy code"
    >
      {copied ? (
        <Check className="w-3 h-3" strokeWidth={2} />
      ) : (
        <Copy className="w-3 h-3" strokeWidth={1.75} />
      )}
    </button>
  );
}

function CodeBlockView({ node, updateAttributes }: ReactNodeViewProps) {
  const language: string | undefined =
    (node.attrs as { language?: string | null }).language ?? undefined;
  const isMermaid = (language ?? "").toLowerCase() === "mermaid";
  const [mode, setMode] = useState<"preview" | "edit">(
    isMermaid ? "preview" : "edit",
  );

  if (!isMermaid) {
    const code = node.textContent;
    const resolved = resolvePrismLanguage(language, code);
    // The picker reflects the explicit fence; a detected language shows as a
    // hint on the "Plain text" row rather than silently rewriting the fence.
    const selectValue = (language ?? "").toLowerCase();
    const plainLabel = resolved.detected
      ? `Plain text · looks like ${resolved.label}`
      : "Plain text";
    return (
      <NodeViewWrapper
        as="div"
        className="tiptap-codeblock"
        data-language={resolved.id ?? "text"}
      >
        <div className="tiptap-codeblock__bar" contentEditable={false}>
          <div className="tiptap-codeblock__lang-wrap">
            <span className="tiptap-codeblock__lang-label">
              {resolved.id ? resolved.label : "Plain text"}
              {resolved.detected && (
                <span className="tiptap-codeblock__auto">auto</span>
              )}
            </span>
            <select
              className="tiptap-codeblock__lang-select"
              value={selectValue}
              aria-label="Code language"
              onChange={(e) =>
                updateAttributes({ language: e.target.value || null })
              }
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.value === "" ? plainLabel : opt.label}
                </option>
              ))}
            </select>
          </div>
          <CopyButton getText={() => node.textContent} />
        </div>
        <pre className="tiptap-codeblock__pre">
          <NodeViewContent<"code"> as="code" />
        </pre>
      </NodeViewWrapper>
    );
  }

  const source = node.textContent;

  return (
    <NodeViewWrapper as="div" className="tiptap-mermaid">
      <div className="tiptap-codeblock__bar" contentEditable={false}>
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
        <pre className="tiptap-codeblock__pre">
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
