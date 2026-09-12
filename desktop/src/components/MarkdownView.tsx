// The Tauri-side face of the shared markdown renderer: the prose mapping
// moved to aura-shared/ui/markdownProse.tsx; this file binds the app's
// resolved theme and the external-anchor opener, so every existing importer
// keeps working and keeps its behavior.
import type { ComponentProps } from "react";
import { useResolvedTheme } from "../lib/themeStore";
import { onExternalAnchorClick } from "../lib/openExternal";
import { SharedUiProvider } from "@shared/ui/appContext";
import {
  MarkdownView as SharedMarkdownView,
  MarkdownInline as SharedMarkdownInline,
} from "@shared/ui/markdownProse";

function bind<P extends object>(Component: (p: P) => React.ReactNode) {
  return function Bound(props: P) {
    const theme = useResolvedTheme();
    return (
      <SharedUiProvider value={{ theme, onAnchorClick: onExternalAnchorClick }}>
        <Component {...props} />
      </SharedUiProvider>
    );
  };
}

export const MarkdownView: (
  p: ComponentProps<typeof SharedMarkdownView>,
) => React.ReactNode = bind(SharedMarkdownView);
export const MarkdownInline: (
  p: ComponentProps<typeof SharedMarkdownInline>,
) => React.ReactNode = bind(SharedMarkdownInline);
