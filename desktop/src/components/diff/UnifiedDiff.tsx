// UnifiedDiff moved to `@shared/ui/diff/UnifiedDiff` on 2026-08-27 — the web
// console renders the same unified patches (resolved at read time by the
// cloud's `commit_patch.rs`), and the renderer must be one code path in both
// apps. This wrapper keeps the desktop's import path and binds the live
// resolved theme, which the shared renderer reads off `SharedUiProvider`.

import { SharedUiProvider } from "@shared/ui/appContext";
import { UnifiedDiff as SharedUnifiedDiff } from "@shared/ui/diff/UnifiedDiff";
import { useResolvedTheme } from "../../lib/themeStore";
import type { DiffFocus } from "../../lib/diffSides";

export { diffMarkerColor } from "@shared/ui/diff/UnifiedDiff";

export function UnifiedDiff(props: { diff: string; focus?: DiffFocus | null }) {
  const theme = useResolvedTheme() === "light" ? "light" : "dark";
  return (
    <SharedUiProvider value={{ theme }}>
      <SharedUnifiedDiff {...props} />
    </SharedUiProvider>
  );
}
