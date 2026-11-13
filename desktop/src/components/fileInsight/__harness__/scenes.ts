// Scenes for the "What changed" harness. Every name, path and line here is
// made up; nothing is read from a real project.
//
//   team      a team file: people added, removed and reordered, fields dropped.
//             Its cached explanation is the CLI notice an older build stored
//             as the answer, so the block must lead with the rows instead.
//   code      a source file: a function added, one reworked, one removed, with
//             the author's recorded reason.
//   writing   the code scene before the plain-language lines have landed.

import type { ChangeExplanation, IntentEntry, OutlineNode, SymbolExplanation } from "../../../lib/api";

export const ROOT = "/Users/sam/acme";

const nowS = () => Math.floor(Date.now() / 1000);

export type Scene = {
  path: string;
  before: string;
  after: string;
  outline: OutlineNode[];
  intents: () => IntentEntry[];
  explanation: () => ChangeExplanation;
  symbols: Record<string, { now: string; before: string }>;
};

const TEAM_BEFORE = `{
  "repo_root": "/Users/sam/acme",
  "created_at": "2026-09-02T10:14:00Z",
  "members": [
    { "id": "sam", "name": "Sam", "commit_count": 214, "first_seen": "2026-09-02", "last_seen": "2026-11-10" },
    { "id": "rio", "name": "Rio", "commit_count": 88, "first_seen": "2026-09-14", "last_seen": "2026-11-09" },
    { "id": "kim", "name": "Kim", "commit_count": 31, "first_seen": "2026-10-01", "last_seen": "2026-11-08" },
    { "id": "lee", "name": "Lee", "commit_count": 12, "first_seen": "2026-10-20", "last_seen": "2026-11-02" },
    { "id": "helper", "name": "Helper Agent", "commit_count": 402, "first_seen": "2026-09-03", "last_seen": "2026-11-10" },
    { "id": "checkpointer", "name": "Checkpointer", "commit_count": 950, "first_seen": "2026-09-02", "last_seen": "2026-11-10" }
  ],
  "collaborators_synced_at": "2026-11-10T08:00:00Z"
}
`;

const TEAM_AFTER = `{
  "created_at": "2026-11-11T09:30:00Z",
  "members": [
    { "id": "helper", "name": "Helper Agent" },
    { "id": "rio", "name": "Rio" },
    { "id": "kim", "name": "Kim" },
    { "id": "lee", "name": "Lee" },
    { "id": "ana", "name": "Ana" },
    { "id": "sam", "name": "Sam" }
  ]
}
`;

const CODE_BEFORE = `import { mailer } from "./mailer";

export async function sendEmail(to: string, body: string) {
  return mailer.send(to, body);
}

export function legacySend(to: string, body: string) {
  return mailer.sendRaw(to, body, { retries: 0 });
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
`;

const CODE_AFTER = `import { mailer } from "./mailer";
import { queue } from "./queue";

export async function sendEmail(to: string, body: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await mailer.send(to, body);
    } catch (err) {
      if (attempt === 3) throw err;
      await wait(attempt * 500);
    }
  }
}

export function scheduleDigest(userId: string) {
  return queue.add("digest", { userId }, { repeat: "weekly" });
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
`;

const CODE_PATH = "src/email/dispatcher.ts";

const code: Scene = {
  path: CODE_PATH,
  before: CODE_BEFORE,
  after: CODE_AFTER,
  outline: [
    { kind: "fn", name: "sendEmail", line: 4 },
    { kind: "fn", name: "scheduleDigest", line: 15 },
    { kind: "fn", name: "wait", line: 19 },
  ],
  intents: () => [
    intent(nowS() - 40, "hook_auto", `Edited ${CODE_PATH}`, CODE_PATH),
    intent(nowS() - 2 * 3600, "claude", "Retry a failed send before giving up, and add the weekly summary email", CODE_PATH),
  ],
  explanation: () => ({
    before: "Sent each email once and gave up if the mail server failed.",
    what: "Tries each email up to three times, and sends a weekly summary.",
    why: "People were missing receipts whenever the mail server hiccupped.",
    why_source: "recorded",
    why_author: "Sam",
    why_stated_at: nowS() - 3 * 3600,
    source: "model",
    diff_hash: "harness-code",
  }),
  symbols: {
    sendEmail: {
      now: "Sends an email and tries again up to three times if the mail server fails.",
      before: "Sent an email once and gave up on the first failure.",
    },
    scheduleDigest: { now: "Queues a weekly summary email for each person.", before: "" },
    legacySend: { now: "", before: "Sent mail the old way, with no second try." },
  },
};

export const SCENES: Record<string, Scene> = {
  team: {
    path: ".aura/team/team.json",
    before: TEAM_BEFORE,
    after: TEAM_AFTER,
    outline: [],
    intents: () => [
      intent(nowS() - 120, "hook_auto", "Edited .aura/team/team.json", ".aura/team/team.json"),
      intent(
        nowS() - 26 * 60,
        "claude",
        "Stop saving per-person commit stats in the team file so it stops changing on every commit",
        ".aura/team/team.json",
      ),
    ],
    explanation: () => ({
      before: "",
      what: "UserPromptSubmit operation blocked by hook:",
      why: "",
      why_source: "none",
      source: "model",
      diff_hash: "harness-team",
    }),
    symbols: {},
  },
  code,
  writing: { ...code, symbols: {}, explanation: () => ({ ...code.explanation(), before: "", what: "", source: "fallback" }) },
};

function intent(timestamp: number, agent: string, text: string, path: string): IntentEntry {
  return {
    id: `${agent}-${timestamp}`,
    timestamp,
    agent,
    intent: text,
    branch: "main",
    commit: "",
    status: "logged",
    changeset: { files: [{ path }] },
  };
}

export function symbolAnswers(scene: Scene, asked: { identifier: string }[]): SymbolExplanation[] {
  return asked.map((s) => {
    const m = scene.symbols[s.identifier];
    return { identifier: s.identifier, now: m?.now ?? "", before: m?.before ?? "", source: m ? "cache" : "none" };
  });
}
