"use strict";
// A read-only `vscode.TextDocument` over a shipped text snapshot.
//
// When the host runs a DIRECT provider (an extension that called
// `vscode.languages.registerCompletionItemProvider` by hand, rather than through
// a LanguageClient), that provider expects a real TextDocument: getText, lineAt,
// offsetAt/positionAt, getWordRangeAtPosition. This builds one over `doc.text`,
// exactly like the web worker's host does, so a direct provider behaves the same
// in the Node host as it would in a browser.
//
// (LanguageClient-backed extensions never reach this: their documents are synced
// to the language server as plain LSP text, not VS Code TextDocuments.)

const { Position, Range, Uri } = require("./vscode-shim");

const DEFAULT_WORD_RE = /[A-Za-z0-9_$]+/g;

/** Build a read-only TextDocument over `doc.text`. `doc` is a WireDoc:
 *  { uri, languageId, version, text }. */
function makeTextDocument(doc) {
  const text = doc.text;
  // Offsets where each line starts, so position↔offset math is exact regardless
  // of CRLF/LF mixing.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */) {
      lineStarts.push(i + 1);
    } else if (ch === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i++; // CRLF counts as one break
      lineStarts.push(i + 1);
    }
  }
  const lineCount = lineStarts.length;

  const lineText = (line) => {
    if (line < 0 || line >= lineCount) return "";
    const start = lineStarts[line];
    const end = line + 1 < lineCount ? lineStarts[line + 1] : text.length;
    return text.slice(start, end).replace(/\r?\n$/, "");
  };

  const offsetAt = (p) => {
    const line = Math.max(0, Math.min(p.line, lineCount - 1));
    const lineLen = lineText(line).length;
    const character = Math.max(0, Math.min(p.character, lineLen));
    return lineStarts[line] + character;
  };

  const positionAt = (offset) => {
    const off = Math.max(0, Math.min(offset, text.length));
    let lo = 0;
    let hi = lineCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return new Position(lo, off - lineStarts[lo]);
  };

  const uri = Uri.parse(doc.uri);

  return {
    uri,
    fileName: uri.fsPath,
    languageId: doc.languageId,
    version: doc.version,
    lineCount,
    isUntitled: uri.scheme === "untitled",
    isClosed: false,
    isDirty: false,
    eol: text.includes("\r\n") ? 2 : 1,
    getText(range) {
      if (range instanceof Range) return text.slice(offsetAt(range.start), offsetAt(range.end));
      return text;
    },
    lineAt(lineOrPos) {
      const line = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line;
      const raw = lineText(line);
      const firstNonWs = raw.search(/\S/);
      return {
        lineNumber: line,
        text: raw,
        range: new Range(line, 0, line, raw.length),
        rangeIncludingLineBreak: new Range(
          line,
          0,
          line + 1 < lineCount ? line + 1 : line,
          line + 1 < lineCount ? 0 : raw.length,
        ),
        firstNonWhitespaceCharacterIndex: firstNonWs < 0 ? raw.length : firstNonWs,
        isEmptyOrWhitespace: raw.trim().length === 0,
      };
    },
    offsetAt,
    positionAt,
    getWordRangeAtPosition(pos, regex) {
      const raw = lineText(pos.line);
      const re = new RegExp(regex ? regex.source : DEFAULT_WORD_RE.source, "g");
      let m;
      while ((m = re.exec(raw)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (pos.character >= start && pos.character <= end) return new Range(pos.line, start, pos.line, end);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      return undefined;
    },
    validatePosition(p) {
      const line = Math.max(0, Math.min(p.line, lineCount - 1));
      return new Position(line, Math.max(0, Math.min(p.character, lineText(line).length)));
    },
    validateRange(r) {
      return r;
    },
  };
}

module.exports = { makeTextDocument };
