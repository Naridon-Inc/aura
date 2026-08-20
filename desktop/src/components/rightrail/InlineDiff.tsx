// Inline unified diff for one changed file, rendered right under its row in
// the Changes panel — the real +/− content without leaving the rail. The body
// fills the panel width (short lines stretch, long lines scroll horizontally)
// so it reads like a proper diff rather than a truncated preview.
//
// Same reading treatment as the full UnifiedDiff pane: a restrained tinted row
// plus a coloured +/− marker, code itself on the neutral ramp. Peeking at six
// files in a row shouldn't feel like six highlighters.

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { useDiffWash } from "../diff/Churn";
import { diffMarkerColor } from "../diff/UnifiedDiff";

type LineKind = "add" | "del" | "hunk" | "ctx";
type DiffLine = { kind: LineKind; text: string };

// Strip the git file-header noise (`diff --git`, `index`, `+++/---`, mode and
// rename lines) — the row already names the file. Keep hunk headers as section
// markers and classify the body lines by their leading +/−/space.
function parseUnifiedDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of raw.split("\n")) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("rename ") ||
      line.startsWith("copy ") ||
      line.startsWith("similarity ") ||
      line.startsWith("dissimilarity ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      out.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      out.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", text: line.slice(1) });
    } else {
      out.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  // Drop a trailing blank context line so the block doesn't end on empty space.
  while (out.length && out[out.length - 1].kind === "ctx" && out[out.length - 1].text === "") {
    out.pop();
  }
  return out;
}

const ROW: Record<LineKind, string> = {
  add: "text-text-2",
  del: "text-text-2",
  hunk: "bg-bg-2/70 text-text-4",
  ctx: "text-text-3",
};

const GUTTER: Record<LineKind, string> = { add: "+", del: "−", hunk: "", ctx: "" };

export function InlineDiff({ repoRoot, path }: { repoRoot: string; path: string }) {
  const [lines, setLines] = useState<DiffLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wash = useDiffWash();

  useEffect(() => {
    let alive = true;
    setLines(null);
    setError(null);
    api
      .gitDiff(repoRoot, path)
      .then((raw) => {
        if (!alive) return;
        setLines(parseUnifiedDiff(raw || ""));
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, path]);

  const note = (text: string, tone = "text-text-4") => (
    <div className={`mx-2 mb-1 px-8 py-1.5 text-xs ${tone}`}>{text}</div>
  );

  if (error) return note(error, "text-red");
  if (lines === null) {
    return (
      <div className="mx-2 mb-1 flex items-center gap-1.5 px-8 py-1.5 text-xs text-text-4">
        <AsciiSpinner className="text-2xs" />
        <span>Reading this change…</span>
      </div>
    );
  }
  if (lines.length === 0) return note("No line changes to show.");

  return (
    <div className="mx-2 mb-1 overflow-x-auto rounded-sm border border-line-soft/60 bg-bg-1/50 font-mono text-xs leading-[1.55]">
      <div className="w-max min-w-full">
        {lines.map((l, i) => (
          <div
            key={i}
            className={`flex ${ROW[l.kind]}`}
            style={
              l.kind === "add"
                ? { background: wash.addLine }
                : l.kind === "del"
                  ? { background: wash.delLine }
                  : undefined
            }
          >
            <span
              className="w-4 shrink-0 select-none text-center"
              style={{
                color:
                  l.kind === "add"
                    ? diffMarkerColor(wash.addFg)
                    : l.kind === "del"
                      ? diffMarkerColor(wash.delFg)
                      : "var(--color-text-5)",
              }}
            >
              {GUTTER[l.kind]}
            </span>
            <span className="whitespace-pre pr-3">{l.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
