// UnifiedDiff — a calm, dependency-free renderer for a single file's unified
// diff text (the output of `git diff HEAD -- <file>`). Unlike PrDiffBody it
// mounts no Monaco editor and carries no PR/comment coupling, so it's cheap to
// render many of them stacked in a session's Changes tab. It parses the diff
// into hunks, tracks old/new line numbers for the gutter, and tints adds/dels
// with the same green/red palette the PR file cards use. Real data only: it
// renders exactly what git produced and nothing else.

import { useMemo, type CSSProperties } from "react";
import { useResolvedTheme } from "../../lib/themeStore";
import { AURA_DIFF_CSS } from "../../lib/monacoTheme";

type Kind = "add" | "del" | "ctx" | "hunk" | "meta";

type DiffLine = {
  kind: Kind;
  /** Old-file line number (null for additions / hunk headers). */
  oldNo: number | null;
  /** New-file line number (null for deletions / hunk headers). */
  newNo: number | null;
  text: string;
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parse one file's unified-diff body into renderable lines, tracking the
 *  old/new line cursors across hunks. Metadata lines (`diff --git`, `index`,
 *  `---`, `+++`) are dropped — the caller already shows the path. */
function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  if (!diff) return out;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split("\n")) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file mode") ||
      raw.startsWith("deleted file mode") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode")
    ) {
      continue;
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldNo = parseInt(hunk[1], 10);
      newNo = parseInt(hunk[3], 10);
      out.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
      continue;
    }
    // "\ No newline at end of file" — a marker, not a content line.
    if (raw.startsWith("\\")) {
      out.push({ kind: "meta", oldNo: null, newNo: null, text: raw });
      continue;
    }
    const lead = raw.charAt(0);
    if (lead === "+") {
      out.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
    } else if (lead === "-") {
      out.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    } else {
      // Context line (leading space) or a trailing blank from the split.
      const body = lead === " " ? raw.slice(1) : raw;
      out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: body });
    }
  }
  // Drop a single trailing empty context line produced by the final "\n".
  if (out.length > 0) {
    const last = out[out.length - 1];
    if (last.kind === "ctx" && last.text === "") out.pop();
  }
  return out;
}

// Exact GitHub diff washes (shared with the Monaco theme) so this fallback
// renderer matches the side-by-side editor pixel-for-pixel.
function rowStyle(
  kind: Kind,
  wash: { addLine: string; delLine: string },
): CSSProperties | undefined {
  if (kind === "add") return { background: wash.addLine };
  if (kind === "del") return { background: wash.delLine };
  return undefined;
}

/** Soft cap so a single huge file can't blow up the DOM; the remainder is
 *  summarised rather than silently dropped. */
const MAX_LINES = 600;

export function UnifiedDiff({ diff }: { diff: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const isDark = useResolvedTheme() !== "light";
  const wash = isDark ? AURA_DIFF_CSS.dark : AURA_DIFF_CSS.light;
  const markFg = (kind: Kind): string | undefined =>
    kind === "add" ? wash.addFg : kind === "del" ? wash.delFg : undefined;

  if (lines.length === 0) {
    return null;
  }

  const shown = lines.slice(0, MAX_LINES);
  const hiddenCount = lines.length - shown.length;

  return (
    <div className="overflow-x-auto bg-bg-content font-mono text-[11.5px] leading-[1.55]">
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((ln, i) => {
            if (ln.kind === "hunk") {
              return (
                <tr key={i} className="bg-bg-2/60">
                  <td
                    colSpan={3}
                    className="select-none px-3 py-0.5 text-[10.5px] text-text-4"
                  >
                    {ln.text}
                  </td>
                </tr>
              );
            }
            if (ln.kind === "meta") {
              return (
                <tr key={i}>
                  <td colSpan={3} className="px-3 py-0.5 text-[10px] italic text-text-5">
                    {ln.text.replace(/^\\\s?/, "")}
                  </td>
                </tr>
              );
            }
            const glyph = ln.kind === "add" ? "+" : ln.kind === "del" ? "-" : " ";
            return (
              <tr key={i} style={rowStyle(ln.kind, wash)}>
                <td className="w-10 select-none border-r border-line-soft/40 px-1.5 text-right align-top text-[10px] text-text-5">
                  {ln.oldNo ?? ""}
                </td>
                <td className="w-10 select-none border-r border-line-soft/40 px-1.5 text-right align-top text-[10px] text-text-5">
                  {ln.newNo ?? ""}
                </td>
                <td className="whitespace-pre-wrap break-words px-2 align-top text-text-2">
                  <span
                    className="mr-1 select-none"
                    style={{ color: markFg(ln.kind) ?? "var(--color-text-5)" }}
                  >
                    {glyph}
                  </span>
                  {ln.text || " "}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hiddenCount > 0 ? (
        <div className="border-t border-line-soft px-3 py-1.5 text-[11px] text-text-4">
          +{hiddenCount} more line{hiddenCount === 1 ? "" : "s"} — open the file
          to see the rest.
        </div>
      ) : null}
    </div>
  );
}
