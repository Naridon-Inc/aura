// Monaco-based editor. Drop-in replacement for the CodeMirror Editor
// component — same prop shape so call sites swap without churn. We get
// VSCode-grade syntax highlighting (TextMate grammars), find/replace,
// multi-cursor, minimap, IntelliSense, and a real diff editor for free.
//
// Self-hosted: workers come from the local bundle via Vite's ?worker
// import. No CDN dependency — works offline inside Tauri.
//
// File-size tiering matches the CodeMirror predecessor:
//   small  (<100KB)  : full features
//   large  (>=100KB) : no minimap, no folding
//   huge   (>=400KB) : also drops semantic highlighting

import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount, type Monaco } from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";
import { initVimMode } from "monaco-vim";

import { installMonacoEnvironment } from "../lib/monacoEnv";
import { monacoLanguageForPath, monacoLanguageId } from "../lib/monacoLanguage";
import { configureMonacoDiagnostics } from "../lib/monacoDiagnostics";
import { useResolvedTheme, useThemeVariant } from "../lib/themeStore";
import { ensureAuraThemes } from "../lib/monacoTheme";
import {
  editorThemeName,
  registerEditorTheme,
  useActiveVsCodeTheme,
} from "../lib/vscodeThemesStore";
import { applyInstalledExtensions } from "../lib/vscodeExt/applyContributes";
import { setExtHostMonaco } from "../lib/vscodeExt/extHostMonacoLang";
import { setExtHostDiagMonaco } from "../lib/vscodeExt/extHostMonacoDiag";
import {
  nodeDocChanged,
  nodeDocClosed,
  nodeDocOpened,
  setNodeWorkspaceRoot,
} from "../lib/vscodeExt/extHostNodeRuntime";
import type { WireDoc } from "../lib/vscodeExt/langFeatures";
import { useInstalledExtensions } from "../lib/vscodeExt/vsixStore";
import { useEditorPrefs, useFontSize } from "../lib/settingsStore";
import { api, type BlameLine } from "../lib/api";
import {
  loadAtlasIndex,
  peekAtlasIndex,
  lookupEntry,
  renderHoverMarkdown,
} from "../lib/atlasHover";

installMonacoEnvironment();

// Languages whose symbols the Code Atlas indexes — the ones we attach the
// real-world-meaning hover to. Mirrors atlas.rs::SOURCE_EXTS, mapped through
// monacoLanguageId.
const ATLAS_HOVER_LANGUAGES = [
  "rust",
  "typescript",
  "javascript",
  "python",
  "go",
];

// The hover provider Monaco registers is GLOBAL per (monaco instance,
// language) — not per editor. So we register each language once and let the
// provider resolve the open file's repo via this module-level map (model URI →
// repoRoot), which every mounted MonacoEditor keeps current for its own file.
const registeredHoverLangs = new WeakMap<Monaco, Set<string>>();
const modelRepoRoot = new Map<string, string>();

function registerAtlasHover(monaco: Monaco) {
  let langs = registeredHoverLangs.get(monaco);
  if (!langs) {
    langs = new Set<string>();
    registeredHoverLangs.set(monaco, langs);
  }
  for (const lang of ATLAS_HOVER_LANGUAGES) {
    if (langs.has(lang)) continue;
    langs.add(lang);
    monaco.languages.registerHoverProvider(lang, {
      provideHover(model: editor.ITextModel, position: Position) {
        const uri = model.uri.toString();
        const repoRoot = modelRepoRoot.get(uri);
        if (!repoRoot) return null;
        const index = peekAtlasIndex(repoRoot);
        if (!index || !index.available) return null;
        const word = model.getWordAtPosition(position);
        if (!word || !word.word) return null;
        const entry = lookupEntry(index, word.word, model.uri.fsPath);
        if (!entry) return null;
        return {
          range: new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          ),
          contents: [{ value: renderHoverMarkdown(entry), isTrusted: false }],
        };
      },
    });
  }
}

export type PresenceMarker = {
  line: number;
  color: string;
  label: string;
};

type EditorProps = {
  value: string;
  language: string;
  onChange: (next: string) => void;
  onCursor?: (line: number) => void;
  presenceMarkers?: PresenceMarker[];
  filePath?: string;
  /** Repo root for the open file — required for inline git blame
   *  (GitLens-style "Author • 2 days ago • summary" after the active
   *  line). When absent, blame is silently disabled. */
  repoRoot?: string;
};

const LARGE_BYTES = 100_000;
const HUGE_BYTES = 400_000;

function tierFor(byteLen: number): "small" | "large" | "huge" {
  if (byteLen >= HUGE_BYTES) return "huge";
  if (byteLen >= LARGE_BYTES) return "large";
  return "small";
}

export function MonacoEditor({
  value,
  language,
  onChange,
  onCursor,
  presenceMarkers,
  filePath,
  repoRoot,
}: EditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const blameDecorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const vimRef = useRef<ReturnType<typeof initVimMode> | null>(null);
  const vimStatusRef = useRef<HTMLDivElement | null>(null);
  // Doc-sync to the Node extension host: the last document uri we told it about
  // (so a file switch closes the old one) + a debounce handle for edit pushes.
  const lastModelUriRef = useRef<string | null>(null);
  const docDebounceRef = useRef<number | null>(null);
  const resolvedTheme = useResolvedTheme();
  const variant = useThemeVariant();
  const activeVs = useActiveVsCodeTheme();
  const installedExts = useInstalledExtensions();
  const editorPrefs = useEditorPrefs();
  const fontSize = useFontSize();
  const isDark = resolvedTheme !== "light";
  const tier = tierFor(value.length);
  const [activeLine, setActiveLine] = useState<number>(1);
  const [blame, setBlame] = useState<BlameLine[] | null>(null);
  // Flips true once Monaco has mounted so the vim-mode effect (which needs
  // the live editor instance) can run without racing onMount.
  const [mounted, setMounted] = useState(false);

  const onMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;
    setMounted(true);

    // Real-world-meaning hover from the Code Atlas. Idempotent — registers each
    // language once per monaco instance regardless of how many panes mount.
    registerAtlasHover(monaco);

    editorInstance.onDidChangeCursorPosition((e) => {
      setActiveLine(e.position.lineNumber);
      onCursor?.(e.position.lineNumber);
    });

    // Cmd+Shift+S → "Share to chat…" with the current selection (or
    // the current line if there's no selection). Fires the global
    // event ShareCodeDialog listens for.
    editorInstance.addAction({
      id: "aura.share-to-chat",
      label: "Share to chat…",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS,
      ],
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 99,
      run: (ed) => {
        const model = ed.getModel();
        if (!model) return;
        const sel = ed.getSelection();
        let code: string;
        let lineStart: number;
        let lineEnd: number;
        if (sel && !sel.isEmpty()) {
          code = model.getValueInRange(sel);
          lineStart = sel.startLineNumber;
          lineEnd = sel.endLineNumber;
        } else {
          const lineNo = sel?.startLineNumber ?? 1;
          code = model.getLineContent(lineNo);
          lineStart = lineNo;
          lineEnd = lineNo;
        }
        window.dispatchEvent(
          new CustomEvent("aura:share-code-to-chat", {
            detail: {
              filePath,
              language: model.getLanguageId(),
              lineStart,
              lineEnd,
              code,
            },
          }),
        );
      },
    });

    // v0.2.28 — Cmd+Shift+. → "Find References" against the symbol at
    // the cursor. Opens SearchWorkpane prefilled with the identifier so
    // every textual reference (and the corresponding AST hits via the
    // semantic lane in CommandPalette) is visible in one place.
    editorInstance.addAction({
      id: "aura.find-references",
      label: "Find References",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Period,
      ],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 10,
      run: (ed) => {
        const model = ed.getModel();
        if (!model) return;
        const pos = ed.getPosition();
        if (!pos) return;
        const word = model.getWordAtPosition(pos);
        if (!word || !word.word) return;
        window.dispatchEvent(
          new CustomEvent("aura:open-search", { detail: { query: word.word } }),
        );
      },
    });

    // Listen for the "aura:scroll-to-line" custom event so OutlinePanel +
    // breadcrumb clicks can drive the viewport. Filter by filePath to
    // avoid two editors in a split fighting over the scroll target.
    const onScroll = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { filePath?: string; line?: number }
        | undefined;
      if (!detail || !detail.line) return;
      if (filePath && detail.filePath && detail.filePath !== filePath) return;
      editorInstance.revealLineInCenter(detail.line);
      editorInstance.setPosition({ lineNumber: detail.line, column: 1 });
      editorInstance.focus();
    };
    window.addEventListener("aura:scroll-to-line", onScroll);

    // ── Stream this editor's document to the Node extension host ──────────────
    // A language extension's server (Python/rust-analyzer/…) needs the live text
    // to offer completions/hover and to publish diagnostics as you type. The host
    // self-syncs on each request, but pushing proactively is what makes squiggles
    // appear live. The runtime no-ops cheaply when no Node extension is running.
    const pushDoc = (action: "open" | "change") => {
      const model = editorInstance.getModel();
      if (!model) return;
      const doc: WireDoc = {
        uri: model.uri.toString(),
        languageId: model.getLanguageId(),
        version: model.getVersionId(),
        text: model.getValue(),
      };
      if (action === "open") nodeDocOpened(doc);
      else nodeDocChanged(doc);
    };
    pushDoc("open");
    lastModelUriRef.current = editorInstance.getModel()?.uri.toString() ?? null;
    // The editor instance is REUSED across files (per-path models), so a file
    // switch is an internal setModel, not a remount — close the old doc, open new.
    editorInstance.onDidChangeModel(() => {
      const prev = lastModelUriRef.current;
      const nextUri = editorInstance.getModel()?.uri.toString() ?? null;
      if (prev && prev !== nextUri) nodeDocClosed(prev);
      pushDoc("open");
      lastModelUriRef.current = nextUri;
    });
    editorInstance.onDidChangeModelContent(() => {
      if (docDebounceRef.current != null) window.clearTimeout(docDebounceRef.current);
      docDebounceRef.current = window.setTimeout(() => pushDoc("change"), 250);
    });

    editorInstance.onDidDispose(() => {
      window.removeEventListener("aura:scroll-to-line", onScroll);
      if (docDebounceRef.current != null) window.clearTimeout(docDebounceRef.current);
      const prev = lastModelUriRef.current;
      if (prev) nodeDocClosed(prev);
    });
  };

  // GitLens-style inline blame — fetch once per (repoRoot, filePath)
  // and re-fetch on file content commit (debounced via `value` len
  // changes is too noisy; we let the user reopen for a re-fetch and
  // catch most edits via the cursor-line cache miss).
  useEffect(() => {
    if (!repoRoot || !filePath) {
      setBlame(null);
      return;
    }
    let cancelled = false;
    api
      .gitBlameLines(repoRoot, filePath)
      .then((rows) => {
        if (!cancelled) setBlame(rows);
      })
      .catch(() => {
        if (!cancelled) setBlame([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, filePath]);

  // Real-world-meaning hover: warm the Code Atlas index for this repo (one IPC
  // read per repo, shared across panes) and tell the global hover provider
  // which repo this file's model belongs to. The provider is registered once
  // per language; it resolves the open file's repo via the modelRepoRoot map.
  useEffect(() => {
    if (!mounted || !repoRoot) return;
    const ed = editorRef.current;
    const uri = ed?.getModel()?.uri.toString();
    if (uri) modelRepoRoot.set(uri, repoRoot);
    // Kick the load; the provider reads the cached index synchronously once it
    // resolves. A failure resolves to an unavailable index (no hover).
    void loadAtlasIndex(repoRoot);
    return () => {
      if (uri) modelRepoRoot.delete(uri);
    };
  }, [mounted, repoRoot, filePath]);

  // Force a repaint when the open file changes. The editor instance is
  // REUSED across files (no key/path remount — that's deliberate, it keeps
  // file switches instant), so `onMount` never refires; only the `value`
  // prop swaps. Under WKWebView Monaco sometimes leaves its viewport
  // unpainted after that swap — the container still has height, so you get
  // a tall blank pane instead of the file (the "why isn't the file
  // visible?" report, hit most on larger files like lockfiles). A forced
  // layout + full re-render on the next frame settles it. Runs on first
  // mount too (mounted flips false→true).
  useEffect(() => {
    if (!mounted) return;
    const ed = editorRef.current;
    if (!ed) return;
    const raf = requestAnimationFrame(() => {
      ed.layout();
      ed.render(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [filePath, value, mounted]);

  // Render a single after-line decoration on the active line with the
  // author + relative time + commit summary. Mirrors GitLens' default.
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    if (!blameDecorationsRef.current) {
      blameDecorationsRef.current = ed.createDecorationsCollection([]);
    }
    if (!blame || blame.length === 0) {
      blameDecorationsRef.current.set([]);
      return;
    }
    const row = blame.find((b) => b.line === activeLine);
    if (!row) {
      blameDecorationsRef.current.set([]);
      return;
    }
    // Uncommitted lines come back from git blame with a zeroed SHA.
    const isUncommitted = /^0+$/.test(row.sha);
    const label = isUncommitted
      ? "You · uncommitted"
      : `${row.author} · ${relativeTime(row.ts)} · ${row.summary}`;
    blameDecorationsRef.current.set([
      {
        range: new monaco.Range(activeLine, 1, activeLine, 1),
        options: {
          isWholeLine: false,
          after: {
            content: `    ${label}`,
            inlineClassName: "aura-blame-inline",
          },
        },
      },
    ]);
  }, [blame, activeLine]);

  // Re-read design tokens + reapply the Aura theme when the app theme or
  // variant flips at runtime, so the editor chrome stays in sync.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    ensureAuraThemes(monaco);
    if (activeVs) registerEditorTheme(monaco, activeVs);
    monaco.editor.setTheme(editorThemeName(isDark, activeVs));
  }, [isDark, variant, activeVs]);

  // Apply enabled VS Code extensions' declarative contributes (themes /
  // language-configuration / snippets) to Monaco. Re-runs when the installed
  // set changes; the router's signature guard makes redundant calls cheap and
  // never executes any extension code.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!mounted || !monaco) return;
    // Hand the extension host this Monaco so contributed completion/hover
    // providers (Tier 1, W2) and diagnostics (W3) can attach; idempotent.
    setExtHostMonaco(monaco);
    setExtHostDiagMonaco(monaco);
    void applyInstalledExtensions(monaco);
  }, [mounted, installedExts]);

  // Tell the Node extension host which folder a language server should treat as
  // its workspace root. Idempotent; only re-inits the host when the folder
  // actually changes (e.g. switching workspaces).
  useEffect(() => {
    if (repoRoot) setNodeWorkspaceRoot(repoRoot);
  }, [repoRoot]);

  // Vim mode (monaco-vim). Attach when the Behavior setting is on, detach
  // when off. The status-bar node (rendered below when vim is on) hosts
  // the `:` command line + mode indicator. Re-runs on the `mounted` flip
  // so toggling vim on an already-open editor takes effect immediately.
  useEffect(() => {
    if (!mounted || !editorPrefs.vim) return;
    const ed = editorRef.current;
    if (!ed) return;
    const vim = initVimMode(ed, vimStatusRef.current);
    vimRef.current = vim;
    return () => {
      vim.dispose();
      vimRef.current = null;
    };
  }, [mounted, editorPrefs.vim]);

  // Apply presence decorations whenever the markers change. Monaco's
  // decorations collection diffs internally so this is cheap.
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    if (!decorationsRef.current) {
      decorationsRef.current = ed.createDecorationsCollection([]);
    }
    const list = (presenceMarkers ?? []).map((m) => ({
      range: new monaco.Range(m.line, 1, m.line, 1),
      options: {
        isWholeLine: false,
        linesDecorationsClassName: "aura-presence-pip",
        hoverMessage: { value: m.label },
        glyphMarginHoverMessage: { value: m.label },
        // Encode the color in a CSS var on the line; styles.css picks it up.
        linesDecorationsTooltip: m.label,
      },
    }));
    decorationsRef.current.set(list);
  }, [presenceMarkers]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0">
        <Editor
          value={value}
          // Per-file model identity. Without `path`, @monaco-editor/react
          // keeps ONE model and pushes each new file's text via setValue —
          // a content swap with no model switch. Under WKWebView a setValue
          // on a heavy buffer (lockfiles, generated files) often paints
          // nothing: the container has height but the viewport stays blank
          // (the "why isn't the file visible?" report). Giving each path its
          // own model makes a file switch a real editor.setModel(), which
          // forces Monaco to relayout+repaint the new content — and it
          // preserves per-file cursor/scroll/undo as a bonus. Switches stay
          // instant (no React remount; cached models skip re-tokenizing).
          path={filePath}
          // Don't dispose the model on unmount. With per-path models the
          // same file can be open in two panes (main + a split) sharing one
          // model by URI; the default dispose-on-unmount would blank the
          // surviving pane. Keeping models also preserves each file's undo
          // and view state when it's reopened.
          keepCurrentModel
          // Prefer path-derived language (full grammar coverage); fall back to
          // the backend slug only when the path doesn't resolve.
          language={monacoLanguageForPath(filePath) ?? monacoLanguageId(language)}
          theme={editorThemeName(isDark, activeVs)}
          beforeMount={(monaco) => {
            ensureAuraThemes(monaco);
            // Disable the project-blind TS/JS validation that flags false
            // errors on good files; real diagnostics come via the LSP bridge.
            configureMonacoDiagnostics(monaco);
            if (activeVs) registerEditorTheme(monaco, activeVs);
          }}
          onMount={onMount}
          onChange={(next) => onChange(next ?? "")}
          options={{
            // Visual + UX defaults that match what the CodeMirror editor gave.
            fontFamily: "var(--font-mono), Menlo, Monaco, monospace",
            fontSize,
            lineHeight: 20,
            renderWhitespace: "selection",
            tabSize: 2,
            wordWrap: "on",
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: "smooth",
            renderLineHighlight: "all",
            // User prefs (settingsStore), still tier-gated: minimap +
            // indent guides are force-dropped on 'huge' files regardless.
            minimap: { enabled: editorPrefs.minimap && tier !== "huge" },
            stickyScroll: { enabled: editorPrefs.sticky_scroll },
            folding: tier !== "huge",
            bracketPairColorization: { enabled: tier === "small" },
            guides: {
              indentation: editorPrefs.indent_guides && tier !== "huge",
              highlightActiveIndentation:
                editorPrefs.indent_guides && tier === "small",
            },
            // Quiet UI: hide the noisy command palette hint
            padding: { top: 8, bottom: 8 },
            automaticLayout: true,
          }}
        />
      </div>
      {editorPrefs.vim && (
        <div
          ref={vimStatusRef}
          className="shrink-0 h-5 px-2 flex items-center gap-2 text-[11px] font-mono text-text-3 bg-bg-1 border-t border-line-soft"
        />
      )}
    </div>
  );
}

// "2 days ago" style label off a unix timestamp (seconds).
function relativeTime(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - ts);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 7) return `${Math.floor(delta / 86400)}d ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / (86400 * 7))}w ago`;
  if (delta < 86400 * 365) return `${Math.floor(delta / (86400 * 30))}mo ago`;
  return `${Math.floor(delta / (86400 * 365))}y ago`;
}
