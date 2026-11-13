// The rendered side of a text file that has one: a CSV as a table, JSON and
// JSON Lines as a tree, an HTML page in a sandboxed frame with nothing
// allowed to run, and an SVG drawn as a picture. Each one says plainly when
// the file is too big or doesn't parse, and points back at Edit.

import { useMemo } from "react";
import {
  CSV_PREVIEW_MAX_COLUMNS,
  CSV_PREVIEW_MAX_ROWS,
  parseCsvPreview,
} from "../../lib/csvPreview";
import { parseJsonPreview } from "../../lib/jsonPreview";
import { JsonTree } from "./json-tree";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import "./document-preview.css";

export function CsvPreview({ content }: { content: string }) {
  const parsed = useMemo(() => parseCsvPreview(content), [content]);
  if (parsed.status !== "ready") {
    return (
      <div className="ui-doc-preview-note">
        {parsed.status === "too-large"
          ? "CSV preview is limited to 1 MB. Open the file locally or switch to Edit."
          : "Could not preview this CSV. Open the file locally or switch to Edit to check its formatting."}
      </div>
    );
  }
  const [header, ...rows] = parsed.rows;
  if (header === undefined) return <div className="ui-doc-preview-note">Empty CSV</div>;
  const { rowsTruncated, columnsTruncated } = parsed;
  return (
    <div className="ui-doc-preview-scroll">
      {(rowsTruncated || columnsTruncated) && (
        <p className="ui-doc-preview-truncated">
          {rowsTruncated && columnsTruncated
            ? `Showing the first ${CSV_PREVIEW_MAX_ROWS} rows and ${CSV_PREVIEW_MAX_COLUMNS} columns.`
            : rowsTruncated
              ? `Showing the first ${CSV_PREVIEW_MAX_ROWS} rows.`
              : `Showing the first ${CSV_PREVIEW_MAX_COLUMNS} columns.`}
        </p>
      )}
      <Table className="ui-csv-table">
        <TableHeader>
          <TableRow>
            {header.map((cell, i) => (
              <TableHead key={i} scope="col">
                {cell}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell key={j}>{cell}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function JsonPreview({ content, format }: { content: string; format: "json" | "jsonl" }) {
  const parsed = useMemo(() => parseJsonPreview(content, format), [content, format]);
  if (parsed.status === "error") {
    return (
      <div className="ui-doc-preview-note" role="status">
        {parsed.message}
      </div>
    );
  }
  return (
    <div className="ui-doc-preview-scroll ui-json-preview">
      <JsonTree data={parsed.data} collectionLimit={50} />
    </div>
  );
}

/** An HTML page drawn from the open buffer. The empty sandbox lets nothing
 *  in it run, submit or navigate. */
export function HtmlPreview({ html, path }: { html: string; path: string }) {
  return (
    <div className="ui-doc-preview-frame">
      <iframe title={`HTML preview for ${path}`} srcDoc={html} sandbox="" />
    </div>
  );
}

export function SvgPreview({ content }: { content: string }) {
  return (
    <div className="ui-doc-preview-picture">
      <img src={`data:image/svg+xml,${encodeURIComponent(content)}`} alt="SVG preview" />
    </div>
  );
}
