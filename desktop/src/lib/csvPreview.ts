// A CSV file read into rows for its table preview: quoted fields, doubled
// quotes, CRLF or LF line ends and a leading byte-order mark. A big file is
// refused rather than parsed, and a long or wide one is cut to what a table
// can show, saying so.

export const CSV_PREVIEW_MAX_BYTES = 1024 * 1024;
export const CSV_PREVIEW_MAX_ROWS = 200;
export const CSV_PREVIEW_MAX_COLUMNS = 50;

export type CsvPreview =
  | { status: "too-large" }
  | { status: "invalid" }
  | { status: "ready"; rows: string[][]; rowsTruncated: boolean; columnsTruncated: boolean };

export function parseCsvPreview(text: string): CsvPreview {
  if (
    text.length > CSV_PREVIEW_MAX_BYTES ||
    new TextEncoder().encode(text).length > CSV_PREVIEW_MAX_BYTES
  ) {
    return { status: "too-large" };
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: "unquoted" | "quoted" | "closed" = "unquoted";
  let columnsTruncated = false;
  const endField = () => {
    if (row.length < CSV_PREVIEW_MAX_COLUMNS) row.push(field);
    else columnsTruncated = true;
    field = "";
    state = "unquoted";
  };
  // The header plus the rows shown: one more row means the file goes on.
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    if (rows.length === CSV_PREVIEW_MAX_ROWS + 1) {
      return { status: "ready", rows, rowsTruncated: true, columnsTruncated };
    }
    const ch = text[i];
    if (state === "quoted") {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          state = "closed";
        }
      } else {
        field += ch;
      }
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      endField();
      rows.push(row);
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else if (ch === '"' && field.length === 0 && state !== "closed") {
      state = "quoted";
    } else {
      // A quote inside a bare field, or text after a closing quote.
      if (ch === '"' || state === "closed") return { status: "invalid" };
      field += ch;
    }
  }
  if (state === "quoted") return { status: "invalid" };
  if (field.length > 0 || row.length > 0 || state === "closed") {
    endField();
    rows.push(row);
  }
  return { status: "ready", rows, rowsTruncated: false, columnsTruncated };
}
