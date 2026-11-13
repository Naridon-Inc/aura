// A mermaid fence drawn as its diagram. On hover two small buttons show at
// its top right: copy the source, and expand. Expanded, the diagram fills a
// sheet 90% of the window — "Mermaid diagram" with zoom in, zoom out, reset
// view, copy and close — where the wheel or a pinch zooms about the cursor
// and a drag moves it. Opening the sheet starts it at its fitted size.

import { useEffect, useState } from "react";
import { Check, Copy, Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";

import { writeClipboardText } from "../../lib/clipboard";
import { renderMermaid, type MermaidTheme } from "../../lib/mermaidRender";
import { useResolvedTheme } from "../../lib/themeStore";
import { cn } from "../../lib/utils";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./dialog";
import { Tooltip } from "./tooltip";
import { usePanZoom } from "./use-pan-zoom";
import "./mermaid-block.css";

type Drawn = { state: "loading" } | { state: "error" } | { state: "ready"; svg: string };

function useMermaidSvg(source: string, theme: MermaidTheme): Drawn {
  const [drawn, setDrawn] = useState<Drawn>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setDrawn({ state: "loading" });
    renderMermaid(source, theme).then(
      (svg) => live && setDrawn({ state: "ready", svg }),
      () => live && setDrawn({ state: "error" }),
    );
    return () => {
      live = false;
    };
  }, [source, theme]);
  return drawn;
}

function CopySourceButton({ source, className }: { source: string; className: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Tooltip content="Copy Mermaid source">
      <button
        type="button"
        className={className}
        aria-label="Copy Mermaid source"
        onClick={async () => setCopied(await writeClipboardText(source))}
      >
        {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      </button>
    </Tooltip>
  );
}

export function MermaidBlock({ content }: { content: string }) {
  const theme: MermaidTheme = useResolvedTheme() === "dark" ? "dark" : "light";
  const drawn = useMermaidSvg(content, theme);
  const [open, setOpen] = useState(false);
  const { isPanning, style, containerProps, zoomIn, zoomOut, resetView } = usePanZoom({
    transformOrigin: "center",
  });
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) resetView();
  };

  if (drawn.state === "loading") {
    return <div className="ui-mermaid-note">Rendering diagram...</div>;
  }
  if (drawn.state === "error") {
    return <div className="ui-mermaid-note" data-error="">Failed to render diagram</div>;
  }
  return (
    <>
      <div className="ui-mermaid">
        <div className="ui-mermaid-svg" dangerouslySetInnerHTML={{ __html: drawn.svg }} />
        <div className="ui-mermaid-tools">
          <CopySourceButton source={content} className="ui-mermaid-float" />
          <button
            type="button"
            className="ui-mermaid-float"
            title="Expand diagram"
            aria-label="Expand diagram"
            onClick={() => onOpenChange(true)}
          >
            <Maximize2 size={16} aria-hidden />
          </button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="ui-mermaid-sheet" showCloseButton={false} aria-describedby={undefined}>
          <div className="ui-mermaid-sheet-head">
            <DialogTitle className="ui-mermaid-sheet-title">Mermaid diagram</DialogTitle>
            <div className="ui-mermaid-sheet-tools">
              <button type="button" className="ui-mermaid-tool" title="Zoom in" aria-label="Zoom in" onClick={zoomIn}>
                <Plus size={16} aria-hidden />
              </button>
              <button type="button" className="ui-mermaid-tool" title="Zoom out" aria-label="Zoom out" onClick={zoomOut}>
                <Minus size={16} aria-hidden />
              </button>
              <button
                type="button"
                className="ui-mermaid-tool"
                title="Reset view"
                aria-label="Reset view"
                onClick={resetView}
              >
                <RotateCcw size={16} aria-hidden />
              </button>
              <div className="ui-mermaid-sheet-rule" aria-hidden />
              <CopySourceButton source={content} className="ui-mermaid-tool" />
              <DialogClose className="ui-mermaid-tool" aria-label="Close">
                <X size={16} aria-hidden />
              </DialogClose>
            </div>
          </div>
          <div className={cn("ui-mermaid-stage", isPanning && "ui-mermaid-stage-panning")} {...containerProps}>
            <div
              className="ui-mermaid-stage-svg"
              style={style}
              dangerouslySetInnerHTML={{ __html: drawn.svg }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
