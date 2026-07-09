// Shared language mapping for every Monaco surface (single-file editor +
// two-buffer diffs). Monaco bundles ~70 TextMate/Monarch grammars; the job
// here is to route a file to the right one so highlighting actually fires.
//
// Two entry points:
//   monacoLanguageForPath(path) — the PRIMARY source. Derives the Monaco
//     language id straight from the file's extension/basename, so coverage no
//     longer depends on whatever short slug the backend happened to resolve.
//   monacoLanguageId(slug)      — back-compat slug→id, used as a fallback when
//     a call site has only the backend slug and no path.

// Canonical Monaco language id per file extension. Values must match the ids
// Monaco registers (see monaco-editor/esm/vs/basic-languages/*). Anything not
// listed falls through to plaintext. The "top languages" the user cares about
// (TS/JS/Python/Go/Rust/C/C++/Java/C#/Ruby/PHP/SQL/…) are all covered.
const EXT_TO_MONACO: Record<string, string> = {
  // TypeScript / JavaScript (JSX + TSX highlight under these ids)
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  // Python
  py: "python",
  pyw: "python",
  pyi: "python",
  // Systems
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  "h++": "cpp",
  cs: "csharp",
  java: "java",
  groovy: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",
  scala: "scala",
  sc: "scala",
  dart: "dart",
  // Scripting
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  jl: "julia",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",
  coffee: "coffee",
  // Data / config / query
  sql: "sql",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  geojson: "json",
  webmanifest: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  xml: "xml",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  svg: "xml",
  plist: "xml",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
  // Web
  html: "html",
  htm: "html",
  xhtml: "html",
  vue: "html",
  svelte: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  pug: "pug",
  jade: "pug",
  hbs: "handlebars",
  handlebars: "handlebars",
  // Docs
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  rst: "restructuredtext",
  // Shell / ops
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "bat",
  dockerfile: "dockerfile",
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  bicep: "bicep",
  // .NET / misc
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  vb: "vb",
  pas: "pascal",
  pp: "pascal",
  sol: "solidity",
  tcl: "tcl",
  twig: "twig",
  wgsl: "wgsl",
  sv: "systemverilog",
  svh: "systemverilog",
};

// A few files carry their language in the basename, not an extension.
const BASENAME_TO_MONACO: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
};

/** Primary detection: Monaco language id from a file path, or null when the
 *  path is absent or the extension/basename isn't recognized (caller then
 *  falls back to the backend slug). */
export function monacoLanguageForPath(
  path: string | undefined | null,
): string | null {
  if (!path) return null;
  const file = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  const byName = BASENAME_TO_MONACO[file];
  if (byName) return byName;
  // Compound extension first (e.g. .d.ts) then the trailing extension.
  if (file.endsWith(".d.ts")) return "typescript";
  const dot = file.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = file.slice(dot + 1);
  return EXT_TO_MONACO[ext] ?? null;
}

// Back-compat slug → Monaco-language-id mapping. Used when only the backend's
// `language` slug is known (no path). Kept in sync with the backend's
// `language_for` field and with `languageSlugForPath`.
export function monacoLanguageId(slug: string): string {
  switch (slug) {
    case "rust":
      return "rust";
    case "typescript":
      return "typescript";
    case "javascript":
      return "javascript";
    case "json":
      return "json";
    case "markdown":
      return "markdown";
    case "css":
      return "css";
    case "html":
      return "html";
    case "python":
      return "python";
    case "go":
      return "go";
    case "toml":
      return "ini";
    case "yaml":
      return "yaml";
    case "shell":
      return "shell";
    // Extended slugs (the backend may grow into these).
    case "c":
    case "cpp":
    case "csharp":
    case "java":
    case "kotlin":
    case "swift":
    case "ruby":
    case "php":
    case "sql":
    case "xml":
    case "scss":
    case "less":
    case "objective-c":
    case "scala":
    case "dart":
    case "lua":
    case "perl":
    case "r":
    case "graphql":
    case "dockerfile":
      return slug;
    default:
      return "plaintext";
  }
}

// File path → Monaco language id. Used by the diff surfaces (which have a path
// but not a backend-resolved slug). Routes through the comprehensive path map
// so it covers the full grammar set, falling back to plaintext.
export function languageSlugForPath(path: string): string {
  return monacoLanguageForPath(path) ?? "plaintext";
}
