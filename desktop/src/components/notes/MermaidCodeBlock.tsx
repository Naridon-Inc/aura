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
import { Button } from "../ui/button";

// Copy-to-clipboard affordance for the code header bar.
function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="iconXs"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        void navigator.clipboard.writeText(getText()).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={copied ? "Copied" : "Copy code"}
      aria-label="Copy code"
    >
      {copied ? <Check /> : <Copy />}
    </Button>
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
        className="ui-code-message ui-rich-editor-code"
        data-language={resolved.id ?? "text"}
      >
        <header contentEditable={false}>
          <label className="ui-rich-editor-code-lang">
            <span>
              {resolved.id ? resolved.label : "Plain text"}
              {resolved.detected && <small>auto</small>}
            </span>
            <select
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
          </label>
          <CopyButton getText={() => node.textContent} />
        </header>
        <pre>
          <NodeViewContent<"code"> as="code" />
        </pre>
      </NodeViewWrapper>
    );
  }

  const source = node.textContent;

  return (
    <NodeViewWrapper as="div" className="ui-code-message ui-rich-editor-code">
      <header contentEditable={false}>
        <span className="ui-rich-editor-code-lang">
          <CodeIcon />
          mermaid
        </span>
        <span className="ui-rich-editor-code-actions">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setMode("preview")}
            aria-pressed={mode === "preview"}
            title="Preview diagram"
          >
            <Eye />
            Preview
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setMode("edit")}
            aria-pressed={mode === "edit"}
            title="Edit source"
          >
            <Pencil />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              const next = (language ?? "").toLowerCase() === "mermaid"
                ? ""
                : "mermaid";
              updateAttributes({ language: next || null });
            }}
            title="Convert back to a plain code block"
          >
            Plain
          </Button>
        </span>
      </header>

      {mode === "edit" ? (
        <pre>
          <NodeViewContent<"code"> as="code" />
        </pre>
      ) : (
        <div contentEditable={false}>
          {source.trim().length > 0 ? (
            <MermaidDiagram code={source} minHeight={120} />
          ) : (
            <p className="ui-rich-editor-code-empty">
              Empty diagram. Switch to Edit and add mermaid source.
            </p>
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
