// Churn moved to `@shared/ui/diff/Churn` on 2026-08-27 — the console's session
// Landed pane draws the same "+N −M" badge, and two copies of the colour rule
// would drift. This file keeps the desktop's import path and the
// theme-reactive `useDiffWash` (the shared one reads `SharedUiProvider`, and
// most desktop diff bodies sit under no provider — they listen to the live
// theme store instead).

import { useResolvedTheme } from "../../lib/themeStore";
import { AURA_DIFF_CSS } from "../../lib/monacoTheme";

export { Churn, type ChurnTone } from "@shared/ui/diff/Churn";

/** Theme-resolved diff washes (`addLine` / `delLine` backgrounds and
 *  `addFg` / `delFg` markers) for the renderers that paint diff BODIES. */
export function useDiffWash() {
  const isDark = useResolvedTheme() !== "light";
  return isDark ? AURA_DIFF_CSS.dark : AURA_DIFF_CSS.light;
}
