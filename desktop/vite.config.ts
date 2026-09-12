import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // CodeMirror ships extensions as classes; if Vite bundles two copies
  // of @codemirror/state or /view (transitive pin mismatch), themes and
  // language extensions registered against one class are silently ignored
  // by the other — and syntax highlighting disappears with no error.
  // Force a single instance for every CodeMirror core package.
  resolve: {
    // The words this app and the web console must agree on live outside both
    // of them, so `BugFix` cannot read as "Bug fix" here and as `BugFix`
    // there. Not a package — a folder, resolved by both bundlers.
    alias: {
      "@shared": path.resolve(__dirname, "../aura-shared"),
    },
    dedupe: [
      // The shared ui/ folder resolves react through a symlink into THIS app's
      // node_modules (see aura-shared/node_modules/README.md); dedupe pins the
      // bundle to one copy of each so a hook can never see two reacts.
      "react",
      "react-dom",
      "clsx",
      "tailwind-merge",
      "lucide-react",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/search",
      "@codemirror/autocomplete",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
