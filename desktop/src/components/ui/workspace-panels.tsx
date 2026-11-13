import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Play, Square, Terminal } from "lucide-react";
import { Button } from "./button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tab-panels";
export interface WorkspacePanel {
  id: string;
  label: string;
  content: ReactNode;
  available?: boolean;
}
export function WorkspacePanels({
  panels,
  value,
  onChange,
  fallback = "changes",
}: {
  panels: WorkspacePanel[];
  value: string;
  onChange: (id: string) => void;
  fallback?: string;
}) {
  const enabled = panels.filter((panel) => panel.available !== false);
  const active = enabled.some((panel) => panel.id === value)
    ? value
    : (enabled.find((panel) => panel.id === fallback)?.id ?? enabled[0]?.id ?? "");
  useEffect(() => {
    if (active && active !== value) onChange(active);
  }, [active, value, onChange]);
  return (
    <Tabs value={active} onValueChange={onChange} className="ui-workspace-panels">
      <TabsList aria-label="Workspace panels">
        {enabled.map((panel) => (
          <TabsTrigger key={panel.id} value={panel.id}>
            {panel.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {enabled.map((panel) => (
        <TabsContent key={panel.id} value={panel.id}>
          {panel.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
export function TerminalPanel({
  sessions,
  value,
  onChange,
  onRun,
  onStop,
}: {
  sessions: { id: string; label: string; output: string; running?: boolean; empty?: string }[];
  value: string;
  onChange: (id: string) => void;
  onRun?: (id: string) => void;
  onStop?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const selected = sessions.find((session) => session.id === value);
  return (
    <section className="ui-terminal-panel">
      <Tabs value={value} onValueChange={onChange}>
        <header>
          <Button
            variant="ghost"
            size="iconXs"
            aria-label={expanded ? "Collapse terminal" : "Expand terminal"}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDown style={{ transform: expanded ? undefined : "rotate(-90deg)" }} />
          </Button>
          <Terminal size={14} />
          <TabsList aria-label="Terminal sessions">
            {sessions.map((session) => (
              <TabsTrigger key={session.id} value={session.id}>
                {session.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {selected?.running
            ? onStop && (
                <Button
                  size="iconXs"
                  variant="ghost"
                  aria-label="Stop command"
                  onClick={() => onStop(value)}
                >
                  <Square />
                </Button>
              )
            : onRun && (
                <Button
                  size="iconXs"
                  variant="ghost"
                  aria-label="Run command"
                  onClick={() => onRun(value)}
                >
                  <Play />
                </Button>
              )}
        </header>
        {expanded &&
          sessions.map((session) => (
            <TabsContent value={session.id} key={session.id}>
              <pre aria-label={`${session.label} output`}>
                {session.output || session.empty || "No output"}
              </pre>
            </TabsContent>
          ))}
      </Tabs>
    </section>
  );
}
