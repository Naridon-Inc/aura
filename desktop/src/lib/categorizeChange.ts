// Classify a repo-relative path into a coarse change "bucket" so the
// Source Control panel can club machine churn together and let the user
// focus on the files they actually edited.
//
// The motivating case: Aura tracks per-edit snapshots and logs under
// `.aura/`, and a single session can leave thousands of `.aura/snapshots/…`
// deletions in `git status`. Listed flat, those drown the handful of real
// source edits. `isNoisePath` is the binary the Changes panel uses to peel
// that churn out into one collapsed "Generated & ignored" group; the richer
// `categorizeChange` is here for any surface that wants finer buckets.

export type ChangeBucket =
  | "source" // real code the user edits
  | "config" // tsconfig, *.config.*, json/toml/yaml at the edges
  | "docs" // markdown / text / docs/**
  | "dependencies" // lockfiles
  | "generated"; // .aura/**, build output, editor cruft — pure machine churn

/** Anything under Aura's own working directory. Promoted from the inline
 *  copy that EditViewPanel used to carry so there's a single definition. */
export function isAuraInternalPath(path: string): boolean {
  return path === ".aura" || path.startsWith(".aura/");
}

/** Tool-metadata directories other tools drop into the repo root — never the
 *  user's code, so they should always stay out of the Changes view. `.entire/`
 *  is the Entire editor's per-edit metadata; it isn't gitignored, so it shows
 *  up as untracked churn until we peel it out here. Extend this set as other
 *  tools' scratch dirs surface. */
export function isToolMetadataPath(path: string): boolean {
  if (isAuraInternalPath(path)) return true;
  if (path === ".entire" || path.startsWith(".entire/")) return true;
  return false;
}

// Build-output / cache dirs that are pure machine churn when they show up
// tracked. Matched as a path segment so `src/distance.ts` is NOT caught by
// `dist`.
const GENERATED_DIR_RE =
  /(^|\/)(node_modules|dist|build|target|\.next|out|coverage|\.turbo|__pycache__|\.pytest_cache)(\/|$)/;

const LOCKFILES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "composer.lock",
  "go.sum",
  "poetry.lock",
  "Gemfile.lock",
]);

const DOC_EXTS = new Set(["md", "mdx", "markdown", "txt", "rst", "adoc"]);
const CONFIG_EXTS = new Set(["json", "toml", "yaml", "yml", "ini"]);

function baseName(path: string): string {
  return path.split("/").pop() || path;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** True for paths that are machine churn the user almost never acts on —
 *  Aura-internal files, build output, and editor cruft. This is what the
 *  Changes panel collapses into its "Generated & ignored" bucket. Lockfiles
 *  are deliberately NOT noise: a lockfile change is infrequent and usually
 *  worth seeing, so it stays in the normal list. */
export function isNoisePath(path: string): boolean {
  if (isToolMetadataPath(path)) return true;
  if (GENERATED_DIR_RE.test(path)) return true;
  const base = baseName(path);
  if (base === ".DS_Store" || base === "Thumbs.db") return true;
  if (base.endsWith(".orig") || base.endsWith(".rej")) return true;
  return false;
}

/** Finer-grained bucket. First match wins; `.aura/**` and build output beat
 *  the ext-based buckets so a tracked `.aura/intent_log.jsonl` lands in
 *  `generated`, not `config`. */
export function categorizeChange(path: string): ChangeBucket {
  if (isNoisePath(path)) return "generated";
  const base = baseName(path);
  if (LOCKFILES.has(base)) return "dependencies";
  const ext = extOf(base);
  if (DOC_EXTS.has(ext) || path.startsWith("docs/")) return "docs";
  if (
    CONFIG_EXTS.has(ext) ||
    base.startsWith(".") ||
    base.startsWith("tsconfig") ||
    /\.config\.[cm]?[jt]s$/.test(base)
  ) {
    return "config";
  }
  return "source";
}
