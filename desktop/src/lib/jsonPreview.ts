// A JSON or JSON Lines file read for its tree preview. A file too big to
// draw, or one that doesn't parse, comes back as the sentence the preview
// shows instead — naming the line, for JSON Lines.

export const JSON_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
export const JSONL_PREVIEW_MAX_LINES = 100_000;

export type JsonPreview =
  | { status: "ready"; data: unknown }
  | { status: "error"; message: string };

export function parseJsonPreview(text: string, format: "json" | "jsonl"): JsonPreview {
  if (
    text.length > JSON_PREVIEW_MAX_BYTES ||
    new TextEncoder().encode(text).length > JSON_PREVIEW_MAX_BYTES
  ) {
    return {
      status: "error",
      message: "JSON preview is limited to 5 MB. Open the file as text to view it.",
    };
  }
  let line: number | undefined;
  try {
    if (format === "json") return { status: "ready", data: JSON.parse(text) };
    const lines = text.trimEnd().split("\n", JSONL_PREVIEW_MAX_LINES + 1);
    if (lines.length > JSONL_PREVIEW_MAX_LINES) {
      return {
        status: "error",
        message:
          "JSON Lines preview is limited to 100,000 lines. Open the file as text to view it.",
      };
    }
    const records: unknown[] = [];
    for (const [index, text] of lines.entries()) {
      if (text.trim() === "") continue;
      line = index + 1;
      records.push(JSON.parse(text));
    }
    return { status: "ready", data: records };
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return {
      status: "error",
      message:
        line === undefined
          ? "Invalid JSON. Open the file as text to check its formatting."
          : `Invalid JSON on line ${line}. Open the file as text to check its formatting.`,
    };
  }
}
