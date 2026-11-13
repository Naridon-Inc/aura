import { useRef, useState } from "react";
import { PermissionRequest, PlanReview, QuestionRequest } from "../chat-decisions";
import {
  ChatRecovery,
  SessionBanner,
  HistoryGap,
  CompactionSummary,
  ModelFallback,
  type ChatFailureKind,
} from "../chat-recovery";
import {
  ToolGroup,
  SubagentRun,
  TurnFooter,
  ResetChatDialog,
  TranscriptSearch,
} from "../transcript-patterns";
import { ToolCall } from "../message";
import { Select } from "../select";
import { Button } from "../button";
import { ConversationView, MessageMarkdown, UnsupportedMessage } from "../transcript-content";
const errors: ChatFailureKind[] = [
  "generic",
  "reconnecting",
  "interrupted",
  "authentication",
  "expired-login",
  "context-full",
  "usage-limit",
  "workspace-limit",
  "ineligible",
  "overloaded",
  "setup-required",
  "image-too-large",
  "unparseable",
];
export function TranscriptPatternPreview() {
  const [failure, setFailure] = useState<ChatFailureKind>("overloaded"),
    [notice, setNotice] = useState("");
  const [reset, setReset] = useState(false),
    [find, setFind] = useState(false),
    [history, setHistory] = useState(false);
  const [banner, setBanner] = useState<"archived" | "read-only" | "restarting" | "shutdown">(
    "archived",
  );
  const [compacting, setCompacting] = useState(false);
  const [conversation, setConversation] = useState<
    "ready" | "empty" | "loading" | "initializing" | "error"
  >("ready");
  const root = useRef<HTMLDivElement>(null);
  return (
    <div className="lab-pattern-stack" ref={root}>
      <Select
        aria-label="Conversation state"
        value={conversation}
        onChange={(value) => setConversation(value as typeof conversation)}
        options={["ready", "empty", "loading", "initializing", "error"].map((value) => ({
          value,
          label: value,
        }))}
      />
      <ConversationView state={conversation} onRetry={() => setConversation("ready")}>
        <MessageMarkdown
          content={
            "### Navigation is ready\n\nThe workspace supports **keyboard navigation**, [file links](https://example.com), and `Escape` dismissal.\n\n- [x] Search commands\n- [x] Restore focus\n- [ ] Review workspace changes\n\n```tsx\nexport function Workspace() {\n  return <CommandMenu />;\n}\n```\n\n| Control | Shortcut |\n| --- | --- |\n| Search | ⌘ K |\n| New chat | ⌘ N |\n\n> Changes are ready for review."
          }
        />
        <UnsupportedMessage type="future-block" raw='{"type":"future-block"}' />
      </ConversationView>
      <div className="lab-pattern-controls">
        <Button size="sm" variant="outline" onClick={() => setFind(true)}>
          Find in conversation
        </Button>
        <Select
          aria-label="Session state"
          value={banner}
          onChange={(value) => setBanner(value as typeof banner)}
          options={["archived", "read-only", "restarting", "shutdown"].map((value) => ({
            value,
            label: value,
          }))}
        />
      </div>
      {find && (
        <TranscriptSearch
          entries={[
            { id: "approval", text: "Run workspace checks permission" },
            { id: "plan", text: "Review keyboard navigation plan" },
            { id: "tools", text: "Review workspace files tools" },
          ]}
          onClose={() => setFind(false)}
          onNavigate={(id) => {
            root.current
              ?.querySelector(`[data-section="${id}"]`)
              ?.scrollIntoView({ block: "center", behavior: "smooth" });
            setNotice(`Found ${id}.`);
          }}
        />
      )}
      <SessionBanner
        state={banner}
        action={{
          label: banner === "archived" ? "Unarchive" : "Reconnect",
          onClick: () => setNotice("Recovery action selected."),
        }}
      />
      <HistoryGap
        loading={history}
        onLoad={() => {
          setHistory(true);
          window.setTimeout(() => {
            setHistory(false);
            setNotice("Earlier preview messages loaded.");
          }, 500);
        }}
      />
      <div data-section="approval">
        <PermissionRequest
          title="Run workspace checks?"
          agent="Review agent"
          description="The agent wants to run a command in this workspace."
          command="bun run typecheck"
          choices={[
            { id: "once", label: "Allow once", primary: true },
            { id: "session", label: "Allow for this session" },
            { id: "deny", label: "Deny" },
          ]}
          onChoose={(choice) => setNotice(`Permission decision: ${choice}`)}
        />
      </div>
      <QuestionRequest
        question="Which navigation should this workspace use?"
        options={[
          {
            id: "groups",
            label: "Group by repository",
            description: "Keep related workspaces together.",
          },
          {
            id: "recent",
            label: "Most recent first",
            description: "Order workspaces by activity.",
          },
        ]}
        onSubmit={(answer) => setNotice(`Answer: ${answer.selected.join(", ")} ${answer.text}`)}
      />
      <div data-section="plan">
        <PlanReview
          text="Review navigation. Implement shortcuts. Verify focus."
          onExecute={() => setNotice("Plan implementation selected.")}
          onNewChat={() => setNotice("Plan handoff selected.")}
          onRevise={() => setNotice("Plan revision selected.")}
        >
          <ol>
            <li>Review navigation and workspace tabs.</li>
            <li>Implement keyboard shortcuts.</li>
            <li>Verify focus restoration and nested menus.</li>
          </ol>
        </PlanReview>
      </div>
      <div data-section="tools">
        <ToolGroup count={3} messages={1}>
          <ToolCall title="Read src/App.tsx">
            <pre>export function App() {"{ … }"}</pre>
          </ToolCall>
          <ToolCall title="Edited keyboard handlers">
            <pre>+ Restore focus after dismissal</pre>
          </ToolCall>
          <SubagentRun
            name="Review agent"
            task="Check keyboard navigation"
            status="completed"
            onOpen={() => setNotice("Subagent chat selected.")}
          >
            Focus and keyboard checks completed.
          </SubagentRun>
        </ToolGroup>
      </div>
      <ModelFallback from="Opus 4.8" to="GPT-6 Astra" reason="Provider unavailable" />
      <TurnFooter
        duration="38s"
        timestamp="Today, 2:42 PM"
        text="Keyboard navigation is ready."
        usage={{ model: "GPT-6 Astra", input: 18400, output: 1420, cached: 12600, cost: "$0.08" }}
        onFork={() => setNotice("Fork requested.")}
        onReset={() => setReset(true)}
        onFeedback={(positive) =>
          setNotice(positive ? "Positive feedback recorded." : "Negative feedback recorded.")
        }
      />
      <div className="lab-pattern-controls">
        <Select
          aria-label="Chat error state"
          value={failure}
          onChange={(value) => setFailure(value as ChatFailureKind)}
          options={errors.map((value) => ({ value, label: value.replace(/-/g, " ") }))}
        />
        <Button size="sm" variant="outline" onClick={() => setCompacting(!compacting)}>
          {compacting ? "Finish compaction" : "Start compaction"}
        </Button>
      </div>
      <ChatRecovery
        kind={failure}
        onRetry={() => setNotice("Retry requested.")}
        action={{
          label: failure === "context-full" ? "Compact conversation" : "Open settings",
          onClick: () => setNotice("Recovery action selected."),
        }}
      />
      <CompactionSummary working={compacting}>
        The workspace uses named tabs, nested menus, and a compact composer.
      </CompactionSummary>
      <ResetChatDialog
        open={reset}
        onOpenChange={setReset}
        onReset={(files) => setNotice(`Chat reset requested${files ? " with file changes" : ""}.`)}
        runningTasks={2}
      />
      <output className="lab-pattern-output" aria-live="polite">
        {notice || "Choose a state or interact with the transcript."}
      </output>
    </div>
  );
}
