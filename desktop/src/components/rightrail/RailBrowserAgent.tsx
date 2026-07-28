// The agentic "browse for me" panel — the Arc-Search-style strip that drops
// below the browser viewport. The user types a goal; `runBrowserAgent` drives
// the active tab through navigate/search steps and streams a step trace here,
// ending in a grounded answer. It renders BELOW the native webview hole so the
// column layout shrinks the webview above it instead of the native layer
// painting over the panel.

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Globe,
  Search,
  Sparkles,
  Square,
  X,
} from "lucide-react";

import { runBrowserAgent, type AgentStep } from "../../lib/browserAgent";

function StepIcon({ kind }: { kind: AgentStep["kind"] }) {
  const cls = "h-3.5 w-3.5 flex-shrink-0";
  if (kind === "navigate") return <Globe className={`${cls} text-text-3`} />;
  if (kind === "search") return <Search className={`${cls} text-text-3`} />;
  if (kind === "answer") return <Sparkles className={`${cls} text-accent`} />;
  return <AlertTriangle className={`${cls} text-text-3`} />;
}

export function RailBrowserAgent({
  tabId,
  initialGoal,
  onClose,
}: {
  tabId: string | null;
  /** When set, the goal is pre-filled and the agent runs automatically on mount
   *  — used when "Browse for me" is launched from a search suggestion. The
   *  parent keys this component by the goal, so a new goal remounts and re-runs. */
  initialGoal?: string | null;
  onClose: () => void;
}) {
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const run = async (override?: string) => {
    const g = (override ?? goal).trim();
    if (!tabId || !g || running) return;
    setGoal(g);
    setSteps([]);
    setAnswer(null);
    setError(null);
    setRunning(true);
    const controller = new AbortController();
    ctrl.current = controller;
    try {
      const ans = await runBrowserAgent({
        tabId,
        goal: g,
        signal: controller.signal,
        onStep: (s) => setSteps((prev) => [...prev, s]),
      });
      if (!controller.signal.aborted) setAnswer(ans);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunning(false);
      ctrl.current = null;
    }
  };

  // Auto-run once when launched with a goal from a suggestion.
  const autoRan = useRef(false);
  useEffect(() => {
    if (initialGoal && initialGoal.trim() && !autoRan.current) {
      autoRan.current = true;
      void run(initialGoal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (running) stop();
    else void run();
  };

  return (
    <div className="flex flex-col border-t border-line-soft bg-bg-1 flex-shrink-0 max-h-[55%] min-h-0">
      <div className="flex items-center gap-1.5 h-8 px-2 flex-shrink-0">
        <Sparkles className="h-3.5 w-3.5 text-accent" />
        <span className="text-[11px] font-medium text-text-2">Browse for me</span>
        <button
          type="button"
          onClick={onClose}
          title="Close agent"
          aria-label="Close agent"
          className="ml-auto flex items-center justify-center w-5 h-5 rounded text-text-4 hover:text-text-1 hover:bg-bg-3 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {(steps.length > 0 || answer || error) && (
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1.5">
          {steps.map((s) => (
            <div key={s.index} className="flex items-start gap-2">
              <div className="mt-0.5">
                <StepIcon kind={s.kind} />
              </div>
              <div className="min-w-0 flex-1">
                {s.thought && (
                  <div className="text-[11px] text-text-2 leading-snug">{s.thought}</div>
                )}
                <div className="text-[11px] text-text-4 truncate">{s.detail}</div>
              </div>
            </div>
          ))}
          {answer && (
            <div className="rounded-md bg-bg-2 border border-line-soft p-2 text-[12px] text-text-1 leading-relaxed whitespace-pre-wrap">
              {answer}
            </div>
          )}
          {error && (
            <div className="flex items-center gap-1.5 text-[11px] text-text-3">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{error}</span>
            </div>
          )}
        </div>
      )}

      <form onSubmit={onSubmit} className="flex items-center gap-1.5 p-2 flex-shrink-0">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="What should I find or do?"
          spellCheck={false}
          disabled={running}
          className="flex-1 min-w-0 h-7 px-2.5 rounded-full bg-bg-2 text-[12px] text-text-1 placeholder:text-text-4 outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!tabId || (!running && !goal.trim())}
          title={running ? "Stop" : "Run"}
          aria-label={running ? "Stop" : "Run"}
          className="flex items-center justify-center w-7 h-7 flex-shrink-0 rounded-full bg-accent text-[color:var(--color-accent-foreground)] disabled:opacity-40 disabled:pointer-events-none transition-opacity"
        >
          {running ? <Square className="h-3 w-3" /> : <ArrowRight className="h-3.5 w-3.5" />}
        </button>
      </form>
    </div>
  );
}
