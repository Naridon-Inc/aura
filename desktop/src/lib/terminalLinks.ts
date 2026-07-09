// VSCode-parity terminal file-path linking. Used by both the regular
// Terminal panes and the Agent PTY view. Matches `src/foo.ts`,
// `./foo.rs:42`, `/abs/foo.py:42:5`, drops `file://` prefixes, resolves
// relative paths against the latest cwd seen by the caller, then opens
// the file in the editor and scrolls to the matched line.

import type { Terminal as XTerm } from "@xterm/xterm";
import { openFileImperative } from "./editorStore";

// Known dev file extensions matched as clickable links. Conservative on
// purpose — adding ad-hoc 2–3 char suffixes would match version strings
// like `0.2.25` as `25` extensions.
const LINK_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "java", "kt", "kts", "swift",
  "c", "cc", "cpp", "h", "hpp",
  "rb", "php", "lua", "sh", "bash", "zsh",
  "md", "mdx", "txt",
  "json", "toml", "yml", "yaml", "xml",
  "html", "css", "scss", "sass",
  "sql", "lock", "env", "conf", "ini",
];
const LINK_EXT_PATTERN = LINK_EXTENSIONS.join("|");

//   1) optional ./ or ../ or / prefix
//   2) at least one path char before extension (no trailing dotted version)
//   3) extension from allow list
//   4) optional :line[:col]
//   5) word boundary after match
const LINK_REGEX_SRC = String.raw`(?:\.{1,2}/|/)?[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.(?:${LINK_EXT_PATTERN})(?::(\d+))?(?::(\d+))?\b`;

function freshRegex(): RegExp {
  return new RegExp(LINK_REGEX_SRC, "g");
}

function resolveClickedPath(matched: string, cwd: string | undefined): string {
  let p = matched;
  if (p.startsWith("file://")) {
    p = decodeURIComponent(p.slice("file://".length));
  }
  if (p.startsWith("/")) return p;
  if (!cwd) return p;
  const stripped = p.replace(/^\.\//, "");
  return cwd.endsWith("/") ? `${cwd}${stripped}` : `${cwd}/${stripped}`;
}

function activate(matched: string, lineNo: number | undefined, cwd: string | undefined): void {
  const abs = resolveClickedPath(matched, cwd);
  openFileImperative(abs)
    .then(() => {
      if (lineNo) {
        // Small delay so MonacoEditor finishes mounting newly-opened
        // files before the scroll event fires.
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("aura:scroll-to-line", {
              detail: { filePath: abs, line: lineNo },
            }),
          );
        }, 120);
      }
    })
    .catch(() => {
      /* file may not exist — silently no-op */
    });
}

/** Register an xterm link provider that turns `path/file.ext[:line[:col]]`
 *  patterns into clickable links. `getCwd` is called lazily on each click
 *  so re-resolves use the latest cwd (e.g. after the user `cd`'d). */
export function registerFilePathLinks(term: XTerm, getCwd: () => string | undefined): void {
  term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buf = term.buffer.active;
      const line = buf.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      if (!text) {
        callback(undefined);
        return;
      }
      const links: {
        range: {
          start: { x: number; y: number };
          end: { x: number; y: number };
        };
        text: string;
        activate: () => void;
      }[] = [];
      const re = freshRegex();
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const matched = m[0];
        const lineNo = m[1] ? parseInt(m[1], 10) : undefined;
        const startCol = m.index + 1;
        const endCol = m.index + matched.length;
        links.push({
          range: {
            start: { x: startCol, y: bufferLineNumber },
            end: { x: endCol, y: bufferLineNumber },
          },
          text: matched,
          activate: () => activate(matched, lineNo, getCwd()),
        });
      }
      callback(links);
    },
  });
}
