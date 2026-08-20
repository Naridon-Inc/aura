// Agentic "navigate-by-prompt" loop for the in-app browser (Arc-Search-style
// "browse for me"). Given a goal, it drives the active browser tab through a
// read→think→act cycle: read the current page (browserExtract), ask the active
// Aura brain for ONE structured action, execute it (navigate / search /
// answer), and repeat until the model answers or the step budget runs out.
//
// It reuses the native brain via `brain_chat_turn` on a dedicated ephemeral
// session id — `persist_turn` is a no-op when no session file exists, so the
// loop never pollutes real chat history and needs no new API keys.

import { listen } from "@tauri-apps/api/event";

import { api, type BrainChatChunk } from "./api";
import { browserExtract, onBrowserState, type PageSnapshot } from "./browserEngine";
import { go } from "./browserStore";

const AGENT_SESSION = "__browser_agent__";
const MAX_STEPS = 6;
const PAGE_TEXT_LIMIT = 6000;
const LOAD_TIMEOUT_MS = 9000;
/** Settle delay after a page finishes loading so SPA content paints before we
 *  read its text. */
const SETTLE_MS = 450;

export type AgentStepKind = "navigate" | "search" | "answer" | "error";

export type AgentStep = {
  index: number;
  thought: string;
  kind: AgentStepKind;
  /** url / query / answer / error message, depending on kind. */
  detail: string;
};

type ParsedAction =
  | { action: "navigate"; url: string; thought: string }
  | { action: "search"; query: string; thought: string }
  | { action: "answer"; answer: string; thought: string };

const SYSTEM_PROMPT = `You are an agent that browses the web inside a desktop app to accomplish the user's goal.

Each turn you receive the GOAL, a short HISTORY of what you've already done, and the CURRENT PAGE (title, url, and visible text). Decide the single best next step.

Reply with EXACTLY ONE JSON object and nothing else. No prose, no markdown, no code fences. It must be one of:
{"thought": "<one short sentence>", "action": "navigate", "url": "https://..."}
{"thought": "<one short sentence>", "action": "search", "query": "<web search terms>"}
{"thought": "<one short sentence>", "action": "answer", "answer": "<final answer>"}

Rules:
- Use "navigate" only for URLs you are confident exist; otherwise use "search".
- Use "answer" as soon as the current page already contains enough to fully satisfy the goal.
- Ground "answer" ONLY in what you actually saw on the pages. Be concise. Never fabricate facts or URLs.
- Output the JSON object only.`;

/** Run one brain turn on the ephemeral agent session and resolve with the full
 *  accumulated assistant text. Cancellable via the abort signal. */
function runTurn(userMessage: string, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    let acc = "";
    let un: (() => void) | undefined;
    let settled = false;

    const cleanup = () => {
      un?.();
      un = undefined;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void api.brainChatCancel(AGENT_SESSION);
      reject(new Error("aborted"));
    };

    void listen<BrainChatChunk>(`manager-chat-chunk:${AGENT_SESSION}`, (e) => {
      if (settled) return;
      const c = e.payload;
      if (c.kind === "text") {
        acc += c.text;
      } else if (c.kind === "end") {
        settled = true;
        cleanup();
        resolve(acc);
      } else if (c.kind === "error") {
        settled = true;
        cleanup();
        reject(new Error(c.message));
      }
    })
      .then((f) => {
        un = f;
        if (settled) {
          un?.();
          return;
        }
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort);
        void api
          .brainChatTurn(AGENT_SESSION, userMessage, { system: SYSTEM_PROMPT, messages: [] }, null)
          .catch((err: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/** Navigate the active tab and resolve once the page settles (or a hard
 *  timeout fires). Drives through `go()` so the address bar + tab state stay
 *  in sync; the rail's reconcile performs the actual native navigation. */
function navigateAndWait(tabId: string, input: string, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let un: (() => void) | undefined;
    let done = false;
    let hardTimer: number | undefined;
    let settleTimer: number | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      un?.();
      if (hardTimer) window.clearTimeout(hardTimer);
      if (settleTimer) window.clearTimeout(settleTimer);
      resolve();
    };

    hardTimer = window.setTimeout(finish, LOAD_TIMEOUT_MS);

    void onBrowserState((ev) => {
      if (done) return;
      if (ev.tabId === tabId && !ev.loading) {
        // Debounce on the settle delay — a page that fires multiple
        // load events resolves only after the last one goes quiet.
        if (settleTimer) window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(finish, SETTLE_MS);
      }
    }).then((f) => {
      un = f;
      if (signal?.aborted || done) finish();
    });

    go(tabId, input);
  });
}

function buildPrompt(
  goal: string,
  history: string[],
  page: PageSnapshot | null,
  forceAnswer: boolean,
): string {
  const hist = history.length
    ? history.map((h, i) => `${i + 1}. ${h}`).join("\n")
    : "(nothing yet)";
  const pageBlock = page
    ? `title: ${page.title}\nurl: ${page.url}\ntext:\n${page.text.slice(0, PAGE_TEXT_LIMIT)}`
    : "(blank tab. Navigate or search to begin)";
  const closing = forceAnswer
    ? `\n\nYou are out of browsing steps. Respond with an "answer" action now, grounded in what you have seen.`
    : "";
  return `GOAL: ${goal}\n\nHISTORY:\n${hist}\n\nCURRENT PAGE:\n${pageBlock}${closing}`;
}

function extractJson(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

function parseAction(raw: string): ParsedAction | null {
  const json = extractJson(raw);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const thought = typeof obj.thought === "string" ? obj.thought : "";
  if (obj.action === "navigate" && typeof obj.url === "string") {
    return { action: "navigate", url: obj.url, thought };
  }
  if (obj.action === "search" && typeof obj.query === "string") {
    return { action: "search", query: obj.query, thought };
  }
  if (obj.action === "answer" && typeof obj.answer === "string") {
    return { action: "answer", answer: obj.answer, thought };
  }
  return null;
}

/** Run the agent to completion. Emits each step via `onStep` and resolves with
 *  the final answer. Throws on abort or an unparseable model reply. */
export async function runBrowserAgent(opts: {
  tabId: string;
  goal: string;
  signal?: AbortSignal;
  onStep: (step: AgentStep) => void;
}): Promise<string> {
  const { tabId, goal, signal, onStep } = opts;
  const history: string[] = [];

  for (let i = 0; i < MAX_STEPS; i++) {
    if (signal?.aborted) throw new Error("aborted");

    let page: PageSnapshot | null = null;
    try {
      page = await browserExtract(tabId);
    } catch {
      // No live page yet (fresh tab) — the model will navigate or search.
    }

    const raw = await runTurn(buildPrompt(goal, history, page, false), signal);
    const act = parseAction(raw);
    if (!act) {
      onStep({ index: i, thought: "", kind: "error", detail: "Model returned an unparseable action." });
      throw new Error("unparseable action");
    }

    if (act.action === "answer") {
      onStep({ index: i, thought: act.thought, kind: "answer", detail: act.answer });
      return act.answer;
    }
    if (act.action === "navigate") {
      onStep({ index: i, thought: act.thought, kind: "navigate", detail: act.url });
      await navigateAndWait(tabId, act.url, signal);
      history.push(`Visited ${act.url}`);
    } else {
      onStep({ index: i, thought: act.thought, kind: "search", detail: act.query });
      await navigateAndWait(tabId, act.query, signal);
      history.push(`Searched "${act.query}"`);
    }
  }

  // Step budget exhausted — force a final answer from the current page.
  if (signal?.aborted) throw new Error("aborted");
  let page: PageSnapshot | null = null;
  try {
    page = await browserExtract(tabId);
  } catch {
    /* best-effort */
  }
  const raw = await runTurn(buildPrompt(goal, history, page, true), signal);
  const act = parseAction(raw);
  const answer = act && act.action === "answer" ? act.answer : raw.trim();
  onStep({ index: MAX_STEPS, thought: act?.thought ?? "", kind: "answer", detail: answer });
  return answer;
}
