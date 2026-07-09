// Shared file-language detection. Maps a path's extension to a human
// display name ("TypeScript", "Rust"). Used by the PR diff surfaces'
// per-file headers (PrFilesSection overview cards + the Files-tab diff
// header) so the language chip reads identically across both — one
// table, not a per-component copy.

export const LANG_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  rs: "Rust",
  go: "Go",
  py: "Python",
  rb: "Ruby",
  php: "PHP",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  cpp: "C++",
  cc: "C++",
  c: "C",
  h: "C",
  hpp: "C++",
  cs: "C#",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  md: "Markdown",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  sh: "Shell",
  bash: "Shell",
  sql: "SQL",
  vue: "Vue",
  svelte: "Svelte",
};

/** Human-readable language name for a file path, or null when the
 *  extension isn't in the table (binary, dotfile, unknown). */
export function detectLanguage(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return LANG_BY_EXT[ext] ?? null;
}
