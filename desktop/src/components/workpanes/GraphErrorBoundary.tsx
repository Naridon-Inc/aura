// Localised error boundary for the SemanticGraph pane. A force-sim
// gone wrong, a malformed KG payload, or a render-time NaN shouldn't
// take down the whole shell — we catch here and offer Retry.
//
// Pairs with `crash.rs` panic hook on the Rust side: panics from
// native code still write a JSON crash dump; this boundary handles
// the JS-only blast radius.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../ui/button";

type Props = {
  children: ReactNode;
  onRetry?: () => void;
};

type State = {
  err: Error | null;
};

export class GraphErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error("[SemanticGraph] render crash", err, info.componentStack);
  }

  retry = () => {
    this.setState({ err: null });
    this.props.onRetry?.();
  };

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-bg-1 text-[12px] gap-3 p-6">
        <div className="text-amber-400 text-[13px] font-medium">
          Graph view crashed
        </div>
        <pre className="text-text-3 text-[11px] max-w-lg whitespace-pre-wrap text-center font-mono">
          {String(this.state.err.message || this.state.err)}
        </pre>
        <Button
          type="button"
          variant="subtle"
          size="sm"
          onClick={this.retry}
          className="text-[11px]"
        >
          Retry
        </Button>
        <div className="text-text-4 text-[10px]">
          Crash dumps: ~/.aura/aura-shell-crashes/
        </div>
      </div>
    );
  }
}
