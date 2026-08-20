// MermaidDiagram — shared mermaid renderer used by Pages (Tiptap
// CodeBlock NodeView) and PlanTab's architecture diagram. The
// parse-first guard prevents mermaid's render() from injecting its
// syntax-error overlay SVG into document.body (the red bomb icon
// regression from #353).

import { useEffect, useId, useState } from "react";
import { useResolvedTheme } from "../../lib/themeStore";

type Props = {
  code: string;
  /** When set, error/loading states render with this height so the
   *  surrounding layout doesn't jump while the SVG resolves. */
  minHeight?: number;
};

export function MermaidDiagram({ code, minHeight }: Props) {
  const theme = useResolvedTheme();
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod: any = await import("mermaid");
        const mermaid = mod.default ?? mod;
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "default",
          securityLevel: "strict",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          themeVariables: { fontSize: "13px" },
        });
        const ok = await mermaid.parse(code, { suppressErrors: true });
        if (ok === false) {
          if (!cancelled) {
            setErr("invalid mermaid syntax");
            setSvg(null);
          }
          return;
        }
        const safeId = `mmd-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}-${Date.now()}`;
        const { svg } = await mermaid.render(safeId, code);
        if (!cancelled) {
          setSvg(svg);
          setErr(null);
        }
      } catch (e: any) {
        if (!cancelled) {
          setErr(String(e?.message ?? e));
          setSvg(null);
        }
      }
      if (typeof document !== "undefined") {
        document
          .querySelectorAll<HTMLElement>(
            "body > div[id^='dmermaid-'], body > div.mermaid-error",
          )
          .forEach((n) => n.remove());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, theme, reactId]);

  const frame: React.CSSProperties = {
    background: "var(--color-bg-card)",
    border: "1px solid var(--color-line-soft)",
    borderRadius: "var(--radius-md)",
    minHeight,
  };

  if (err) {
    return (
      <div
        className="t-xs p-3 overflow-x-auto"
        style={{ ...frame, color: "var(--color-text-2)" }}
      >
        <div
          className="section-label mb-1"
          style={{
            color: "var(--color-text-4)",
            letterSpacing: "0.12em",
          }}
        >
          mermaid · {err}
        </div>
        <pre className="font-mono whitespace-pre-wrap">{code}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div
        className="t-xs italic px-3 py-6 text-center"
        style={{ ...frame, color: "var(--color-text-3)" }}
      >
        Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="mermaid-frame flex justify-center p-3"
      style={{ ...frame, maxHeight: 360, overflow: "auto" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
