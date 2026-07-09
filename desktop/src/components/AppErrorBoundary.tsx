// AppErrorBoundary — the app's last line of defence against a blank screen.
//
// Before this existed, any render-time crash (a bad theme, a malformed cached
// blob, an unguarded null) unmounted the whole React tree and left the user
// staring at a blank black window with no idea what happened or how to get out.
// The user's words: "whenever such errors happen, always show what happened."
//
// So: this boundary catches render errors AND global runtime errors, and paints
// a calm, plain-language recovery screen that explains what broke and offers a
// way back — including a one-click "reset appearance" for the most common cause
// (a color theme that blacked the app out).
//
// Everything here is styled with INLINE styles and hard-coded colors on purpose.
// The fallback must render correctly even when the app's theme tokens are the
// very thing that's broken — so it can't lean on `--color-*` / Tailwind classes.

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = {
  error: Error | null;
  info: string | null;
  showDetails: boolean;
  copied: boolean;
};

// localStorage keys that drive the app's look. Clearing these + wiping inline
// root styles undoes a theme that made the app unreadable. Kept as literals so
// this file has no import coupling to the theme stores (which could themselves
// be part of what crashed).
const APPEARANCE_KEYS = [
  "aura.editor.activeTheme",
  "aura.editor.applyChrome",
  "aura.theme.variant",
];

// Some runtime errors are pure noise and must NOT blank the app:
//  • "ResizeObserver loop …" — a benign layout-thrash warning every browser
//    emits; it is not an actual failure.
//  • Tauri's event teardown race — `unlisten()` is async and its internal
//    `unregisterListener` reads `listeners[eventId].handlerId` with no guard.
//    When a listener is torn down twice (fast unmount, an effect re-running on
//    boot), the already-removed entry is `undefined` and it throws. The
//    listener is *already gone*, so this is harmless — but as an unhandled
//    rejection it would otherwise trip the snag screen on launch. Swallow it.
function isBenignRuntimeNoise(message: string): boolean {
  if (!message) return false;
  if (message.includes("ResizeObserver loop")) return true;
  if (message.includes("handlerId") || message.includes("unregisterListener"))
    return true;
  return false;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, showDetails: false, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? null });
    // Keep the raw error in the console for anyone who opens devtools.
    console.error("[AppErrorBoundary] caught a render error:", error, info);
  }

  componentDidMount() {
    // React error boundaries only catch render/lifecycle errors. Async throws
    // (event handlers, promises) bypass them — so we also listen globally and
    // surface a hard error the same way, rather than leaving a half-dead UI.
    window.addEventListener("error", this.onGlobalError);
    window.addEventListener("unhandledrejection", this.onRejection);
  }

  componentWillUnmount() {
    window.removeEventListener("error", this.onGlobalError);
    window.removeEventListener("unhandledrejection", this.onRejection);
  }

  private onGlobalError = (e: ErrorEvent) => {
    // Ignore benign ResizeObserver noise + already-shown errors.
    if (this.state.error) return;
    const msg = e.message || "";
    if (isBenignRuntimeNoise(msg)) return;
    if (e.error instanceof Error) this.setState({ error: e.error });
  };

  private onRejection = (e: PromiseRejectionEvent) => {
    if (this.state.error) return;
    const reason = e.reason;
    const msg = reason instanceof Error ? reason.message : String(reason ?? "");
    // A failed teardown-time unlisten must NEVER blank the app — see
    // isBenignRuntimeNoise. Tauri's async `unlisten()` rejects (not throws),
    // so without this guard a harmless double-unlisten trips the snag screen.
    if (isBenignRuntimeNoise(msg)) return;
    if (reason instanceof Error) this.setState({ error: reason });
  };

  private reload = () => {
    window.location.reload();
  };

  private resetAppearanceAndReload = () => {
    try {
      for (const k of APPEARANCE_KEYS) localStorage.removeItem(k);
    } catch {
      /* private mode — best-effort */
    }
    try {
      // Wipe every inline CSS variable override the theme reskin may have left
      // on <html>, restoring Aura's own readable token cascade.
      document.documentElement.removeAttribute("style");
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  private tryAgain = () => {
    this.setState({ error: null, info: null, showDetails: false, copied: false });
  };

  private copyDetails = () => {
    const { error, info } = this.state;
    const text = [
      error?.name ? `${error.name}: ${error.message}` : String(error),
      "",
      error?.stack ?? "",
      info ? `\nComponent stack:${info}` : "",
    ].join("\n");
    try {
      void navigator.clipboard?.writeText(text);
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 1500);
    } catch {
      /* clipboard blocked — the details are still on screen to copy by hand */
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = error.message || String(error);
    const stack = error.stack || "";

    return (
      <div style={S.backdrop}>
        <div style={S.card}>
          <div style={S.iconRow}>
            <span style={S.iconDot} aria-hidden />
            <span style={S.kicker}>Aura hit a snag</span>
          </div>

          <h1 style={S.title}>Something went wrong on screen</h1>
          <p style={S.lede}>
            None of your work is lost — this is just the screen failing to draw.
            The most common cause is a color theme that doesn’t fit. You can put
            the look back to normal, or reload and carry on.
          </p>

          <div style={S.whatBox}>
            <div style={S.whatLabel}>What happened</div>
            <div style={S.whatMsg}>{message}</div>
          </div>

          <div style={S.actions}>
            <button style={S.primaryBtn} onClick={this.resetAppearanceAndReload}>
              Reset appearance &amp; reload
            </button>
            <button style={S.btn} onClick={this.reload}>
              Reload Aura
            </button>
            <button style={S.btn} onClick={this.tryAgain}>
              Try again
            </button>
            <button style={S.ghostBtn} onClick={this.copyDetails}>
              {this.state.copied ? "Copied" : "Copy details"}
            </button>
          </div>

          <button
            style={S.detailsToggle}
            onClick={() => this.setState((s) => ({ showDetails: !s.showDetails }))}
          >
            {this.state.showDetails ? "Hide technical details" : "Show technical details"}
          </button>
          {this.state.showDetails && (
            <pre style={S.stack}>
              {message}
              {stack ? `\n\n${stack}` : ""}
              {this.state.info ? `\n\nComponent stack:${this.state.info}` : ""}
            </pre>
          )}
        </div>
      </div>
    );
  }
}

// Aura's real palette, hard-coded here on purpose. These MIRROR the app's
// `--color-*` tokens (the ember surface the app ships with) so the card looks
// native — but as literals, not `var(--color-*)`, so it stays correct even when
// a broken theme is the very thing that blanked the screen. Keep in sync with
// the ember block in styles.css if those tokens ever move.
//
// Aura's accent is GREEN (#7ef0a0) — that's the look the app ships with, not
// the blue of the default `:root` block. The radii here are deliberately small
// (4–6px) to match the app's tight corners, not the soft rounding of a
// generic dialog.
const ACCENT = "#7ef0a0"; // --color-accent (ember green) — primary affordance
const ACCENT_INK = "#05140b"; // dark ink that stays legible ON the green accent
const BG_CANVAS = "#0a0a0a"; // --color-bg-0 (content canvas)
const BG_DEEP = "#050505"; // --color-bg-1 (chrome / inset wells)
const BG_HOVER = "#161616"; // --color-bg-2 (hover / secondary fill)
const LINE = "#1f1f1f"; // --color-line (hairline)
const TEXT_1 = "#f3f3f3";
const TEXT_2 = "#b8b8b8";
const TEXT_3 = "#7a7a7a";
const TEXT_4 = "#4d4d4d";

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 2147483000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: BG_CANVAS,
    color: TEXT_1,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    overflow: "auto",
  },
  card: {
    width: "100%",
    maxWidth: 540,
    background: BG_CANVAS,
    // --shadow-modal: hairline ring + two soft drop shadows (verbatim values).
    boxShadow:
      `0 0 0 1px ${LINE}, 0 8px 24px 0 rgba(0,0,0,0.40), 0 24px 48px 0 rgba(0,0,0,0.46)`,
    borderRadius: 6,
    padding: "26px 26px 22px",
  },
  iconRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 16 },
  iconDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: ACCENT,
    boxShadow: `0 0 0 4px rgba(126,240,160,0.16)`,
  },
  kicker: {
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: TEXT_3,
    fontWeight: 600,
  },
  title: { margin: "0 0 8px", fontSize: 19, fontWeight: 600, color: TEXT_1, letterSpacing: -0.2 },
  lede: { margin: "0 0 18px", fontSize: 13, lineHeight: 1.65, color: TEXT_2 },
  whatBox: {
    background: BG_DEEP,
    border: `1px solid ${LINE}`,
    borderRadius: 4,
    padding: "11px 13px",
    marginBottom: 18,
  },
  whatLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: TEXT_3,
    marginBottom: 5,
    fontWeight: 600,
  },
  whatMsg: {
    fontSize: 12.5,
    lineHeight: 1.5,
    color: TEXT_1,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    wordBreak: "break-word",
  },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 6 },
  // Primary = solid ember-green with dark ink, matching Aura's accent-foreground
  // convention (dark text on the green accent). The clear, on-brand affordance.
  primaryBtn: {
    appearance: "none",
    border: "1px solid transparent",
    background: ACCENT,
    color: ACCENT_INK,
    fontSize: 12,
    fontWeight: 600,
    height: 30,
    padding: "0 14px",
    borderRadius: 6,
    cursor: "pointer",
  },
  // Secondary = bg-2 fill + hairline raise (the app's flat secondary button).
  btn: {
    appearance: "none",
    border: `1px solid ${LINE}`,
    background: BG_HOVER,
    color: TEXT_1,
    fontSize: 12,
    fontWeight: 500,
    height: 30,
    padding: "0 13px",
    borderRadius: 6,
    cursor: "pointer",
  },
  ghostBtn: {
    appearance: "none",
    border: "1px solid transparent",
    background: "transparent",
    color: TEXT_3,
    fontSize: 12,
    fontWeight: 500,
    height: 30,
    padding: "0 8px",
    borderRadius: 6,
    cursor: "pointer",
  },
  detailsToggle: {
    appearance: "none",
    border: "none",
    background: "transparent",
    color: TEXT_4,
    fontSize: 11.5,
    padding: "10px 0 0",
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: 2,
  },
  stack: {
    marginTop: 10,
    padding: 12,
    background: BG_DEEP,
    border: `1px solid ${LINE}`,
    borderRadius: 4,
    fontSize: 11,
    lineHeight: 1.5,
    color: TEXT_3,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    maxHeight: 220,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
};
