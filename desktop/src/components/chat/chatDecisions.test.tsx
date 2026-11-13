import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionRequest, PlanReview } from "../ui/chat-decisions";
import { QuestionRecord, recordedAnswer } from "./QuestionRecord";
import { QuestionFlow } from "./QuestionFlow";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const noop = async () => {};

describe("a plan in the conversation is the shared plan review", () => {
  test("title and actions share the header, the plan sits under it", () => {
    const html = renderToStaticMarkup(
      <PlanReview className="chat-plan-review" title="Ship the importer" summary="Two steps." status="Ready for review" meta="2 tasks" onOpen={() => {}} actions={<button type="button">Build</button>}>
        <ol className="chat-plan-tasks"><li>Parse</li></ol>
      </PlanReview>,
    );
    expect(html).toMatch(/^<section class="ui-plan-review chat-plan-review"/);
    expect(html).toMatch(/<header>.*<strong>Ship the importer<\/strong>.*<div class="ui-pattern-actions">.*Build.*<\/header>/);
    expect(html).toContain('<div class="ui-plan-content"><p>Two steps.</p><ol class="chat-plan-tasks">');
    expect(html).toContain("Ready for review");
    expect(html).toContain('<small class="chat-plan-review-meta">2 tasks</small>');
  });

  test("opening the full plan is the title itself, not a second button beside Review plan", () => {
    const html = renderToStaticMarkup(<PlanReview className="chat-plan-review" title="Plan" onOpen={() => {}}><p>body</p></PlanReview>);
    expect(html).toContain('class="chat-plan-review-open"');
    expect(html).not.toContain("Show plan");
  });

  test("a plan with no page to open folds its document behind Show plan", () => {
    const html = renderToStaticMarkup(<PlanReview className="chat-plan-review" title="Plan" collapsible><p>secret body</p></PlanReview>);
    expect(html).toContain("Show plan");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("secret body");
  });

  test("the plan card's actions are the shared buttons", () => {
    const src = read("components/manager/chat/PlanCard.tsx");
    expect(src).not.toContain("chat-primary-action");
    expect(src).not.toContain('className="chat-plan-secondary"');
    expect(src).toMatch(/<Button\s+type="button"\s+size="xs"\s+disabled=\{submitting !== null\}\s+onClick=\{\(\) => void decide\("build"\)\}\s*>\s*<Play \/>/);
    expect(src).toMatch(/variant="outline"\s+size="xs"\s+onClick=\{openAsTab\}/);
    expect(src).toMatch(/size="iconXs"\s+aria-label="Plan options"/);
    expect(src).toContain('aria-label="Plan changes"');
  });
});

describe("a question is the shared question request", () => {
  const one = [{ id: "q1", prompt: "Which database?", options: [{ id: "pg", label: "Postgres", description: "Managed" }, { id: "sq", label: "SQLite" }], freeText: true }];

  test("a form with a legend, one option row per choice and a free-text answer", () => {
    const html = renderToStaticMarkup(<QuestionFlow questions={one} onSubmit={noop} />);
    expect(html).toMatch(/^<form class="ui-question-request chat-question-request"/);
    expect(html).toContain('<legend aria-live="polite">Which database?</legend>');
    expect(html.match(/<label class="ui-question-option">/g)?.length).toBe(2);
    expect(html).toContain('type="radio"');
    expect(html).toContain("<small>Managed</small>");
    expect(html).toContain('aria-label="Additional answer"');
    expect(html).toContain('placeholder="Something else…"');
    expect(html).toMatch(/<div class="ui-pattern-actions">.*Skip.*type="submit".*Continue/);
  });

  test("several choices take checkboxes, several questions take a counter and arrows", () => {
    const many = [
      { id: "a", prompt: "Pick tools", multiple: true, options: [{ id: "x", label: "Lint" }] },
      { id: "b", prompt: "Anything else?", options: [] },
    ];
    const html = renderToStaticMarkup(<QuestionFlow questions={many} onSubmit={noop} title="Setup" />);
    expect(html).toContain('role="checkbox"');
    expect(html).toContain("Choose one or more");
    expect(html).toContain("1 of 2");
    expect(html).toContain('aria-label="Previous question"');
    expect(html).toContain('aria-label="Next question"');
  });

  test("a docked request takes the composer's frame and opens onto it", () => {
    const html = renderToStaticMarkup(<QuestionFlow questions={one} onSubmit={noop} docked />);
    expect(html).toContain("chat-question-request is-docked");
    expect(read("components/ui/chat-decision.css")).toMatch(
      /\.chat-question-request\.is-docked,\s*\.chat-plan-review\.is-docked \{\s*border: 1px solid var\(--ui-border\);\s*border-radius: 12px 12px 0 0;\s*background: var\(--ui-composer\);/,
    );
  });

  test("a plan waiting for review docks as the shared plan review", () => {
    const view = read("components/manager/ManagerChatView.tsx");
    expect(view).toMatch(/<PlanReview\s+className=\{`chat-plan-review\$\{fusePlan \? " is-docked" : ""\}`\}/);
    expect(view).toContain('status="Review the plan before building"');
    expect(view).not.toContain("chat-plan-dock");
    const css = read("components/chat/ChatComposer.css");
    for (const sel of [".chat-plan-dock", ".unified-composer-options", ".composer-menu-heading"]) {
      expect(css).not.toContain(sel);
    }
    expect(read("components/manager/chat/PlanCard.tsx")).toContain("<DropdownMenuLabel>Plan options</DropdownMenuLabel>");
  });

  test("the old bespoke plan and question rules are gone", () => {
    const css = read("components/chat/ChatComposer.css");
    for (const sel of [".question-flow", ".chat-plan-preview", ".chat-plan-heading", ".chat-plan-footer", ".chat-primary-action", ".chat-plan-secondary"]) {
      expect(css).not.toContain(sel);
    }
    expect(read("components/agent/chatView.css")).not.toContain(".question-flow");
  });

  test("an agent's plan offers Review in Terminal as the shared outline button", () => {
    const src = read("components/agent/normalized/NormalizedTranscript.tsx");
    expect(src).not.toContain("chat-plan-secondary");
    expect(src).toMatch(/<Button\s+type="button"\s+variant="outline"\s+size="xs"\s+onClick=\{onRespondInTerminal\}\s*>\s*Review in Terminal/);
  });
});

describe("a question from a finished turn is the shared request, read-only", () => {
  const asked = [{ id: "q", prompt: "Which database?", options: [{ id: "pg", label: "Postgres" }, { id: "sq", label: "SQLite" }] }];

  test("the answer it got is picked and nothing is left to send", () => {
    const html = renderToStaticMarkup(<QuestionRecord questions={asked} answer={'"Which database?"="SQLite"'} />);
    expect(html).toMatch(/^<form class="ui-question-request chat-question-record"/);
    expect(html).toContain("<fieldset disabled=\"\">");
    expect(html).toMatch(/checked="" value="sq"/);
    expect(html).not.toMatch(/checked="" value="pg"/);
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain("Skip");
  });

  test("an answer that names no option is shown as written", () => {
    expect(recordedAnswer(asked[0], "Something custom")).toEqual({ selected: [], text: "Something custom" });
    const html = renderToStaticMarkup(<QuestionRecord questions={asked} answer="Something custom" />);
    expect(html).toContain("readOnly");
  });

  test("an open one keeps the way to answer it elsewhere", () => {
    const html = renderToStaticMarkup(<QuestionRecord questions={asked} actions={<button type="button">Answer in Terminal</button>} />);
    expect(html).toContain("Answer in Terminal");
  });
});

describe("a permission is the shared permission request", () => {
  test("the agent transcript's permission card offers its one way to answer", () => {
    const src = read("components/agent/normalized/NormalizedTranscript.tsx");
    expect(src).toMatch(/<PermissionRequest\s+title=\{ev\.title\}/);
    expect(src).toContain('[{ id: "terminal", label: "Answer in Terminal", primary: true }]');
    expect(src).not.toContain("chat-record");
  });

  test("the stream's permission answers with the same decision as before", () => {
    const src = read("components/agent/StreamChatView.tsx");
    expect(src).toMatch(/<PermissionRequest className=/);
    expect(src).toContain('await decidePrompt(prompt.prompt_id, option.kind.startsWith("allow") ? "allow" : "deny", nativeOptions ? { _acp_option_id: option.optionId } : undefined);');
    expect(src).toContain('await decidePrompt(prompt.prompt_id, "allow", { ...(prompt.input as object), answers });');
  });

  test("rendered, each option is an answer with its number key", () => {
    const html = renderToStaticMarkup(
      <PermissionRequest title="Bash" command="ls" choices={[{ id: "deny", label: "Deny" }, { id: "allow", label: "Allow once", primary: true }]} onChoose={() => {}} />,
    );
    expect(html).toMatch(/^<section class="ui-permission-request"/);
    expect(html).toContain("<pre>ls</pre>");
    expect(html.match(/<button/g)?.length).toBe(2);
    expect(html).toContain("<kbd");
  });
});

describe("a sent message takes only its bubble's height", () => {
  test("its hover actions float in the gap under it instead of pushing the reply down", () => {
    const css = read("components/ui/chat-surface.css");
    expect(css).toMatch(/\.ui-chat-user-stack \{\s*position: relative;/);
    expect(css).toMatch(/\.ui-chat-user-stack > \.ui-message-actions \{\s*position: absolute;\s*top: 100%;\s*right: 0;/);
  });
});

describe("questions and plans from a finished turn", () => {
  test("are drawn as the shared request and review, not bespoke cards", () => {
    const src = read("components/manager/chat/InteractiveBlocks.tsx");
    expect(src).toContain("<QuestionRecord");
    expect(src).toContain('<PlanReview className="chat-plan-review" title="Plan" text={markdown}>');
    expect(src).not.toContain("<section");
    expect(src).not.toContain("aura-ask-card");
    expect(read("styles.css")).not.toContain(".aura-ask-card");
  });
});
