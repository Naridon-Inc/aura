// One turn of the transcript that throws while drawing must not take the rest
// of the conversation with it. The failed turn is replaced by a notice saying
// so, with a way to draw it again; every other turn stays where it was.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { errorKind, trackError } from "../../../lib/track";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import "../../ui/chat-turn-error.css";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class TurnErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("A chat turn failed to render", error, info.componentStack);
    trackError("chat-turn", errorKind(error));
  }

  private reset = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    return <TurnRenderFailed onRetry={this.reset} />;
  }
}

export function TurnRenderFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert className="ui-chat-turn-error">
      <TriangleAlert aria-hidden />
      <AlertTitle>This chat turn failed to render</AlertTitle>
      <AlertDescription>
        <div className="ui-chat-turn-error-row">
          <p>Other turns are still available.</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
