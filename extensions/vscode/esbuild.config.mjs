import { context, build } from "esbuild";

const watch = process.argv.includes("--watch");

const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["vscode"],
  format: "cjs",
  outfile: "dist/extension.js",
  sourcemap: true,
  logLevel: "info",
  // VS Code loads the bundle from disk; keep it readable in dev and minify in CI.
  minify: process.env.NODE_ENV === "production",
};

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[aura-vscode] esbuild watching…");
} else {
  await build(opts);
}
