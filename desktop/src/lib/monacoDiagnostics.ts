// Monaco ships a TypeScript/JavaScript language service that, out of the box,
// runs full semantic + syntax validation against an empty in-memory project.
// On a real file that imports anything, references DOM/Node globals, or uses a
// path alias, that service has no tsconfig, no node_modules, and no lib graph —
// so it flags perfectly good code with red squiggles ("Cannot find module …",
// "Cannot find name 'process'", etc.). Those are false errors: the file is fine,
// the in-browser service just can't see the project.
//
// We turn that built-in validation OFF. Real, project-aware diagnostics arrive
// through the Node extension-host → LSP → Monaco bridge (AURA-86) when a
// language extension is installed; until then we show clean syntax highlighting
// without lying about errors. Highlighting is tokenization (Monarch grammars)
// and is unaffected by disabling the language-service validation.

// monaco-editor's bundled type defs mark `languages.typescript` as a deprecated
// stub (`{ deprecated: true }`) in favour of a top-level namespace that isn't
// surfaced on the runtime module object. The runtime members still live under
// `languages.typescript`, so we reach them through a structural cast.
type LanguageServiceDefaults = {
  setDiagnosticsOptions(options: {
    noSemanticValidation?: boolean;
    noSyntaxValidation?: boolean;
    noSuggestionDiagnostics?: boolean;
  }): void;
  setCompilerOptions(options: Record<string, unknown>): void;
};

type TypescriptNamespace = {
  typescriptDefaults: LanguageServiceDefaults;
  javascriptDefaults: LanguageServiceDefaults;
  JsxEmit: { React: number };
  ModuleKind: { ESNext: number };
  ModuleResolutionKind: { NodeJs: number };
  ScriptTarget: { ESNext: number };
};

type MonacoModule = typeof import("monaco-editor");

// One monaco module instance per app, but guard anyway so repeated beforeMount
// calls across editor/diff surfaces are cheap and idempotent.
const configured = new WeakSet<object>();

export function configureMonacoDiagnostics(monaco: MonacoModule): void {
  const langs = monaco?.languages as unknown as
    | { typescript?: TypescriptNamespace }
    | undefined;
  const ts = langs?.typescript;
  if (!ts?.typescriptDefaults) return;
  if (configured.has(monaco)) return;
  configured.add(monaco);

  // Silence the unconfigured language service for both TS and JS. Suggestion
  // diagnostics (the faint "unused" hints) are off too — they're equally
  // project-blind here.
  const diagnostics = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  };
  ts.typescriptDefaults.setDiagnosticsOptions(diagnostics);
  ts.javascriptDefaults.setDiagnosticsOptions(diagnostics);

  // Lenient compiler options so the tokenizer/hover never trips on JSX or
  // non-.ts extensions, and never tries to type-check the standard libs.
  const compilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    jsx: ts.JsxEmit.React,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
    skipLibCheck: true,
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
}
