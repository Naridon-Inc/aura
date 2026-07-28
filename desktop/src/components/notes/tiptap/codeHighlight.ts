// Syntax highlighting for Tiptap code blocks — Prism tokens painted as
// ProseMirror inline decorations. This is *non-destructive*: the block's
// text is never rewritten, so the code stays fully editable while every
// token gets a `.token.<type>` class the theme (styles.css) colours.
//
// Language resolution has two paths:
//   1. an explicit fence language (```ts) → mapped to a Prism grammar
//   2. no fence → a light content heuristic picks a grammar so pasted code
//      still lights up. The heuristic only drives *highlighting*; it never
//      writes the `language` attr back, so the saved markdown fence is
//      untouched.
//
// Prism is loaded as a singleton (core bundles markup/css/clike/javascript);
// the side-effect imports below register the extra grammars on it.
import * as Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-go";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-php";
import "prismjs/components/prism-markdown";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

// fence label (any casing) → Prism grammar id
const ALIAS: Record<string, string> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  go: "go",
  golang: "go",
  css: "css",
  scss: "css",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  toml: "toml",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  rb: "ruby",
  ruby: "ruby",
  php: "php",
  md: "markdown",
  markdown: "markdown",
};

// Prism grammar id → friendly label shown in the block header + picker.
const LABEL: Record<string, string> = {
  javascript: "JavaScript",
  jsx: "JSX",
  typescript: "TypeScript",
  tsx: "TSX",
  python: "Python",
  rust: "Rust",
  json: "JSON",
  bash: "Shell",
  go: "Go",
  css: "CSS",
  markup: "HTML",
  yaml: "YAML",
  sql: "SQL",
  toml: "TOML",
  java: "Java",
  c: "C",
  cpp: "C++",
  ruby: "Ruby",
  php: "PHP",
  markdown: "Markdown",
};

// The picker menu — the fence value we write is the first alias that maps
// to each grammar (so it round-trips as a conventional ``` fence).
export const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Plain text" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "jsx", label: "JSX" },
  { value: "tsx", label: "TSX" },
  { value: "python", label: "Python" },
  { value: "rust", label: "Rust" },
  { value: "go", label: "Go" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "toml", label: "TOML" },
  { value: "bash", label: "Shell" },
  { value: "sql", label: "SQL" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "java", label: "Java" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "ruby", label: "Ruby" },
  { value: "php", label: "PHP" },
  { value: "markdown", label: "Markdown" },
];

function normalizeLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const key = lang.trim().toLowerCase();
  if (!key) return null;
  return ALIAS[key] ?? (LABEL[key] ? key : null);
}

// Conservative content sniff used only when the fence carries no language.
// Bias toward returning null (plain) rather than mislabelling.
function autodetect(code: string): string | null {
  const s = code.trim();
  if (s.length < 3) return null;
  if (/^[[{][\s\S]*[\]}]$/.test(s) && /"\s*:/.test(s)) return "json";
  if (/\b(?:def|class)\s+\w+|^\s*(?:from\s+\w+\s+)?import\s+\w+|print\(/m.test(s))
    return "python";
  if (/\bfn\s+\w+|\blet\s+mut\b|\bimpl\s+\w+|println!|->\s*\w+\s*\{/.test(s))
    return "rust";
  if (/^\s*(?:#!.*\b(?:bash|sh|zsh)\b|\$\s|npm\s|yarn\s|git\s|cd\s|sudo\s)/m.test(s))
    return "bash";
  if (/^\s*<[a-zA-Z!/]/.test(s) && /<\/?[a-zA-Z][\w-]*/.test(s)) return "markup";
  if (/\b(?:const|let|var|function|=>|export\s|import\s.+\bfrom\b)/.test(s))
    return "javascript";
  return null;
}

export interface ResolvedLanguage {
  /** Prism grammar id, or null when nothing usable was found. */
  id: string | null;
  /** Friendly label for the header ("TypeScript", "Shell", …). */
  label: string;
  /** True when the id came from the content sniff, not an explicit fence. */
  detected: boolean;
}

/** Resolve the grammar + display label for a block's fence + contents. */
export function resolvePrismLanguage(
  lang: string | null | undefined,
  code: string,
): ResolvedLanguage {
  const explicit = normalizeLang(lang);
  if (explicit) {
    return { id: explicit, label: LABEL[explicit] ?? explicit, detected: false };
  }
  const guessed = autodetect(code);
  if (guessed) {
    return { id: guessed, label: LABEL[guessed] ?? guessed, detected: true };
  }
  return { id: null, label: "Plain text", detected: false };
}

// ── Prism token stream → flat decoration ranges ──────────────────────────────

type PrismToken = Prism.Token;

function tokenLength(token: string | PrismToken): number {
  if (typeof token === "string") return token.length;
  if (Array.isArray(token.content)) {
    return (token.content as Array<string | PrismToken>).reduce(
      (sum, t) => sum + tokenLength(t),
      0,
    );
  }
  return tokenLength(token.content as string | PrismToken);
}

function aliasClasses(alias: string | string[] | undefined): string {
  if (!alias) return "";
  return " " + (Array.isArray(alias) ? alias.join(" ") : alias);
}

// Walk the (possibly nested) token stream, emitting one decoration per
// non-string token. Overlapping inline decorations are legal in ProseMirror,
// so nested tokens simply stack their classes.
function walk(
  tokens: Array<string | PrismToken>,
  start: number,
  decorations: Decoration[],
): number {
  let pos = start;
  for (const token of tokens) {
    const len = tokenLength(token);
    if (typeof token !== "string") {
      const cls = `token ${token.type}${aliasClasses(token.alias)}`;
      decorations.push(Decoration.inline(pos, pos + len, { class: cls }));
      if (typeof token.content !== "string") {
        const children = Array.isArray(token.content)
          ? (token.content as Array<string | PrismToken>)
          : [token.content as string | PrismToken];
        walk(children, pos, decorations);
      }
    }
    pos += len;
  }
  return pos;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    const code = node.textContent;
    if (!code) return false;
    const attrs = node.attrs as { language?: string | null };
    const resolved = resolvePrismLanguage(attrs.language, code);
    if (!resolved.id) return false;
    const grammar = Prism.languages[resolved.id];
    if (!grammar) return false;
    // +1 to step past the code_block's own boundary into its text content;
    // code blocks hold plain text (newlines included) so offsets map 1:1.
    walk(Prism.tokenize(code, grammar), pos + 1, decorations);
    return false; // never descend into a code block
  });
  return DecorationSet.create(doc, decorations);
}

const codeHighlightKey = new PluginKey<DecorationSet>("aura-code-highlight");

/**
 * Tiptap extension that paints Prism syntax tokens onto every code block as
 * inline decorations. Recomputes only when the document actually changes.
 */
export const CodeHighlight = Extension.create({
  name: "codeHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: codeHighlightKey,
        state: {
          init: (_config, { doc }) => buildDecorations(doc),
          apply: (tr, old) =>
            tr.docChanged ? buildDecorations(tr.doc) : old,
        },
        props: {
          decorations(state: EditorState) {
            return codeHighlightKey.getState(state);
          },
        },
      }),
    ];
  },
});
