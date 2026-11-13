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
// The screen is drawn from the shared parts (the state anatomy, an alert for
// what happened, the buttons, an accordion for the technical details), but its
// wrapper pins the library's own colour values (ui/crash-screen.css). A theme
// that wrote broken colours onto the page root is the usual cause, so the
// screen must not read its colours from there.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Check, Copy, RefreshCw } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import "./ui/state.css";
import "./ui/crash-screen.css";
import {
  isBenignRuntimeNoise,
  isCancellation,
  isEditorWorkerFailure,
} from "../lib/runtimeNoise";
import { errorKind, trackError } from "../lib/track";
import { isStaleModuleError, reloadForStaleModule } from "../lib/staleModule";

type Props = {
  children: ReactNode;
  /**
   * What to call the product in the recovery copy — "Aura" in the desktop app,
   * "the console" in a browser tab. The screen says "Reload {product}", and a
   * console that offered to reload Aura would be pointing at the wrong window.
   */
  product?: string;
  /**
   * The localStorage keys "Reset appearance" clears. The desktop's editor
   * themes and the console's single theme key are different sets, and a button
   * that clears keys the product does not use is a button that does nothing —
   * so each product names its own rather than inheriting the other's.
   */
  appearanceKeys?: readonly string[];
  /**
   * The sentence under the title. The desktop's names a colour theme as the
   * usual cause, because on the desktop it is; a browser tab that repeated
   * that would be guessing at the reader's expense. Defaults to the desktop's.
   */
  lede?: ReactNode;
  /**
   * Which of the two repairs is offered first. "reset" leads with clearing the
   * appearance, which is right where a theme is the likely cause; "reload"
   * leads with a plain reload, which is right where it is not.
   */
  primaryAction?: "reset" | "reload";
};
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

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, showDetails: false, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> | null {
    // Commit-phase throws land here, NOT in the global error/rejection handlers
    // below — so the benign-teardown guard has to run here too. A Monaco model
    // disposal race or a cancellation from an unmounting pane must not blank the
    // app; returning null leaves the boundary rendering its children untouched.
    if (isBenignRuntimeNoise(error?.message ?? "") || isCancellation(error)) {
      return null;
    }
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Same ignore as getDerivedStateFromError — a disposed-model / cancellation
    // race while a pane tears down. Nothing failed; don't paint the snag screen
    // and don't shout in the console (it's expected teardown noise).
    if (isBenignRuntimeNoise(error?.message ?? "") || isCancellation(error)) {
      return;
    }
    // A screen loaded on demand whose file was renamed under the page: a reload
    // draws it. Only when that already failed once does the screen below stay.
    if (this.reloadIfStale(error?.message ?? "")) return;
    this.setState({ info: info.componentStack ?? null });
    // A render crash blanks the whole app, so it is the single most valuable
    // error to know about. Class name only — never the message or the stack,
    // both of which carry paths and user content.
    trackError("render", errorKind(error));
    // Keep the raw error in the console for anyone who opens devtools.
    console.error("[AppErrorBoundary] caught a render error:", error, info);
  }

  componentDidMount() {
    // React error boundaries only catch render/lifecycle errors. Async throws
    // (event handlers, promises) bypass them — so we also listen globally and
    // surface a hard error the same way, rather than leaving a half-dead UI.
    window.addEventListener("error", this.onGlobalError);
    window.addEventListener("unhandledrejection", this.onRejection);
    // A shipped build announces a lazy screen it couldn't preload here first.
    window.addEventListener("vite:preloadError", this.onPreloadError);
  }

  componentWillUnmount() {
    window.removeEventListener("error", this.onGlobalError);
    window.removeEventListener("unhandledrejection", this.onRejection);
    window.removeEventListener("vite:preloadError", this.onPreloadError);
  }

  /** Reload once when `message` says an on-demand module is gone (see
   *  lib/staleModule.ts). True when the reload started. */
  private reloadIfStale(message: string): boolean {
    if (!isStaleModuleError(message)) return false;
    let store: Storage | null = null;
    try {
      store = window.sessionStorage;
    } catch {
      /* blocked storage: the reload still runs, once */
    }
    const started = reloadForStaleModule(store, Date.now(), () => window.location.reload());
    if (started) console.warn("[AppErrorBoundary] a module went stale under the page; reloading:", message);
    return started;
  }

  private onPreloadError = (e: Event) => {
    let store: Storage | null = null;
    try {
      store = window.sessionStorage;
    } catch {
      /* ignore */
    }
    if (reloadForStaleModule(store, Date.now(), () => window.location.reload())) e.preventDefault();
  };

  private onGlobalError = (e: ErrorEvent) => {
    // Ignore benign ResizeObserver noise + already-shown errors.
    if (this.state.error) return;
    const msg = e.message || "";
    if (isBenignRuntimeNoise(msg) || isCancellation(e.error)) return;
    if (this.editorWorkerFailed(e.error)) return;
    if (this.reloadIfStale(msg)) return;
    if (e.error instanceof Error) this.setState({ error: e.error });
  };

  /** A language worker that could not answer a hover or a completion broke
   *  that one feature; the editor and everything around it still work. Keep it
   *  in the console for devtools, and leave the app up. */
  private editorWorkerFailed(reason: unknown): boolean {
    if (!isEditorWorkerFailure(reason)) return false;
    console.warn("[AppErrorBoundary] an editor language worker failed:", reason);
    return true;
  }

  private onRejection = (e: PromiseRejectionEvent) => {
    if (this.state.error) return;
    const reason = e.reason;
    const msg = reason instanceof Error ? reason.message : String(reason ?? "");
    // A failed teardown-time unlisten, or a Monaco cancellation, must NEVER
    // blank the app — see isBenignRuntimeNoise / isCancellation. Tauri's async
    // `unlisten()` rejects (not throws), and Monaco rejects with a bare
    // CancellationError, so without these guards a harmless double-unlisten or
    // a file closed mid-highlight trips the snag screen.
    if (isBenignRuntimeNoise(msg) || isCancellation(reason)) return;
    if (this.editorWorkerFailed(reason)) return;
    if (this.reloadIfStale(msg)) return;
    if (reason instanceof Error) this.setState({ error: reason });
  };

  private reload = () => {
    window.location.reload();
  };

  private resetAppearanceAndReload = () => {
    try {
      for (const k of this.props.appearanceKeys ?? APPEARANCE_KEYS)
        localStorage.removeItem(k);
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

    const product = this.props.product ?? "Aura";
    const reload = (
      <Button
        key="reload"
        size="sm"
        variant={this.props.primaryAction === "reload" ? "default" : "outline"}
        onClick={this.reload}
      >
        Reload {product}
      </Button>
    );
    const reset = (
      <Button
        key="reset"
        size="sm"
        variant={this.props.primaryAction === "reload" ? "outline" : "default"}
        onClick={this.resetAppearanceAndReload}
      >
        Reset appearance &amp; reload
      </Button>
    );

    return (
      <div className="ui-crash-screen">
        <div className="ui-state" data-size="md" data-tone="error" role="alert">
          <AlertTriangle className="ui-state-icon" strokeWidth={1.25} aria-hidden />
          <div className="ui-state-copy">
            <strong>Something went wrong on screen</strong>
            <p>
              {this.props.lede ?? (
                <>
                  None of your work is lost. This is just the screen failing to draw. The most
                  common cause is a color theme that doesn’t fit. You can put the look back to
                  normal, or reload and carry on.
                </>
              )}
            </p>
          </div>

          <Alert variant="destructive" className="ui-crash-what">
            <AlertTitle>What happened</AlertTitle>
            <AlertDescription>
              <code>{message}</code>
            </AlertDescription>
          </Alert>

          <div className="ui-crash-actions">
            {this.props.primaryAction === "reload" ? [reload, reset] : [reset, reload]}
            <Button size="sm" variant="outline" onClick={this.tryAgain}>
              <RefreshCw aria-hidden />
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={this.copyDetails}>
              {this.state.copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {this.state.copied ? "Copied" : "Copy details"}
            </Button>
          </div>

          <Accordion
            type="single"
            collapsible
            className="ui-crash-details"
            value={this.state.showDetails ? "details" : ""}
            onValueChange={(v) => this.setState({ showDetails: v === "details" })}
          >
            <AccordionItem value="details">
              <AccordionTrigger>Technical details</AccordionTrigger>
              <AccordionContent>
                <pre>
                  {message}
                  {stack ? `\n\n${stack}` : ""}
                  {this.state.info ? `\n\nComponent stack:${this.state.info}` : ""}
                </pre>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </div>
    );
  }
}
