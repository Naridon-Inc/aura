// Which text files have a rendered preview beside their source, and which of
// the two they open on. A document — markdown, a page, a drawing, a table —
// opens on its preview; a data file opens on its text, with the tree a click
// away.

export type PreviewFormat = "markdown" | "html" | "svg" | "csv" | "json" | "jsonl";

export function previewFormatOf(path: string): PreviewFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx")) {
    return "markdown";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".svg")) return "svg";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  return null;
}

export function isPreviewablePath(path: string): boolean {
  return previewFormatOf(path) !== null;
}

/** The view a file opens on before anyone picks one. */
export function defaultFileMode(path: string): "preview" | "edit" {
  const format = previewFormatOf(path);
  return format === null || format === "json" || format === "jsonl" ? "edit" : "preview";
}
