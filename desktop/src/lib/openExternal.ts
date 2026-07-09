// Open an http(s)/mailto URL in the user's real browser (or mail client).
//
// Why this exists: inside a Tauri webview a plain `<a href target="_blank">`
// click is a NO-OP — there's no browser tab for the webview to spawn, so the
// navigation is silently dropped (the link shows a hand cursor and hover
// style, but clicking does nothing). Anchors that should leave the app must
// route through the opener plugin instead. Markdown renderers (chat, agent
// transcript, rendered .md) wire this to their anchor `onClick`.
//
// The opener capability is already granted (Onboarding + FileAttachment use
// it), so this needs no Rust/permission change. `window.open` is a last-ditch
// fallback for non-Tauri contexts (e.g. a popped-out OS window served plainly).

export async function openExternal(url: string | undefined | null): Promise<void> {
  const u = (url ?? "").trim();
  if (!u) return;
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(u);
  } catch (e) {
    console.error("openExternal: opener failed, falling back to window.open:", e);
    try {
      window.open(u, "_blank", "noopener,noreferrer");
    } catch {
      /* nothing more we can do */
    }
  }
}

/** Anchor `onClick` that cancels the dead in-webview navigation and opens the
 *  href in the real browser. Use as `onClick={onExternalAnchorClick}` on an
 *  `<a href>` whose href should leave the app. */
export function onExternalAnchorClick(
  e: React.MouseEvent<HTMLAnchorElement>,
): void {
  const href = e.currentTarget.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  void openExternal(href);
}
