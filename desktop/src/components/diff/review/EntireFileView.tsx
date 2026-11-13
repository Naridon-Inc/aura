// "Entire file": the file as it is now, whole, with no diff drawn over it.
// Comments go on its lines the way they do on the new side of a diff, and the
// ones already left there show under their lines.

import { useEffect, useMemo, useRef, useState } from "react";
import { Editor, type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

import { installMonacoEnvironment } from "../../../lib/monacoEnv";
import { languageSlugForPath } from "../../../lib/monacoLanguage";
import { configureMonacoDiagnostics } from "../../../lib/monacoDiagnostics";
import { useResolvedTheme, useThemeVariant } from "../../../lib/themeStore";
import { auraThemeName, ensureAuraThemes } from "../../../lib/monacoTheme";
import { getWrapLines, subscribeWrapLines } from "../../../lib/wrapLinesPref";
import { useMonacoReview, type ReviewHost } from "./useMonacoReview";

installMonacoEnvironment();

export function EntireFileView({
  text,
  path,
  review = null,
}: {
  text: string;
  path: string;
  review?: ReviewHost | null;
}) {
  const language = useMemo(() => languageSlugForPath(path), [path]);
  const isDark = useResolvedTheme() !== "light";
  const variant = useThemeVariant();
  const [wrap, setWrap] = useState(getWrapLines);
  useEffect(() => subscribeWrapLines(setWrap), []);
  const monacoRef = useRef<Monaco | null>(null);
  const [pane, setPane] = useState<editor.ICodeEditor | null>(null);
  const onMount: OnMount = (ed, monaco) => {
    monacoRef.current = monaco;
    setPane(ed);
  };
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    ensureAuraThemes(monaco);
    monaco.editor.setTheme(auraThemeName(isDark));
  }, [isDark, variant]);
  const zones = useMonacoReview(pane, monacoRef.current, "additions", review);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {zones}
      <div className="min-h-0 flex-1">
        <Editor
          value={text}
          path={`entire-file://${path}`}
          language={language}
          theme={auraThemeName(isDark)}
          beforeMount={(monaco) => {
            ensureAuraThemes(monaco);
            configureMonacoDiagnostics(monaco);
          }}
          onMount={onMount}
          options={{
            readOnly: true,
            domReadOnly: true,
            fontFamily: "var(--font-mono), Menlo, Monaco, monospace",
            fontSize: 12,
            lineHeight: 20,
            wordWrap: wrap ? "on" : "off",
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            minimap: { enabled: false },
            glyphMargin: !!review,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
