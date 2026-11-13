// Run with: bun test src/components/commons/crew/AddComputer.test.tsx
//
// Adding a computer: the three ways, the pasted line and what became of it,
// and connecting this computer. These pin what each state says and offers.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { JoinReport, PairIssued, PairStatus } from "../../../lib/pairComputer";
import { Connected, OwnComputerView, ThisComputerView, Ways } from "./AddComputer";

const none = () => undefined;
const NOW = Date.parse("2026-11-13T10:00:00Z");

const issued: PairIssued = {
  id: "0b5c2f1e-1d2a-4c55-9d7e-3f1a2b3c4d5e",
  code: "AURA-K7QM-3XPT",
  scope: "personal",
  expires_at: "2026-11-13T10:10:00Z",
  install: "curl -fsSL https://auravcs.com/join | sh -s -- AURA-K7QM-3XPT",
  join: "aura join AURA-K7QM-3XPT",
};

const status = (over: Partial<PairStatus>): PairStatus => ({
  id: issued.id,
  scope: "personal",
  state: "waiting",
  expires_at: issued.expires_at,
  place_id: null,
  computer: null,
  ...over,
});

const own = (over: Partial<Parameters<typeof OwnComputerView>[0]> = {}) =>
  renderToStaticMarkup(
    <OwnComputerView
      issued={issued}
      status={status({})}
      failed=""
      copied={null}
      scope="personal"
      onCopy={none}
      onScope={none}
      onAgain={none}
      now={NOW}
      {...over}
    />,
  );

describe("the three ways", () => {
  test("are rows in plain words, with no title", () => {
    const html = renderToStaticMarkup(<Ways way={null} onPick={none} />);
    expect(html).toContain("Get one from Aura");
    expect(html).toContain("Use a computer you have");
    expect(html).toContain("Use this computer");
    expect(html).not.toContain("<h1");
    expect(html.match(/role="radio"/g)?.length).toBe(3);
  });
  test("mark the chosen one", () => {
    const html = renderToStaticMarkup(<Ways way="own" onPick={none} />);
    expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
  });
});

describe("a computer you have", () => {
  test("shows the one line with Copy, and waits for it", () => {
    const html = own();
    expect(html).toContain("curl -fsSL https://auravcs.com/join | sh -s -- AURA-K7QM-3XPT");
    expect(html).toContain(">Copy<");
    expect(html).toContain("Waiting for your computer…");
    expect(html).toContain("in the next 10 minutes");
    expect(html).toContain("Everyone in the team can use it");
  });
  test("says when it was copied, and when it couldn't be", () => {
    expect(own({ copied: "yes" })).toContain(">Copied<");
    expect(own({ copied: "no" })).toContain("Couldn&#x27;t copy");
  });
  test("says it is connecting once the code is spent", () => {
    expect(own({ status: status({ state: "joining" }) })).toContain("Your computer is connecting…");
  });
  test("turns into Connected with the computer's name, cores and memory", () => {
    const html = own({
      status: status({
        state: "connected",
        place_id: "p-1",
        computer: { name: "build-box", os: "linux", arch: "x86_64", cpus: 24, memory_gb: 188 },
      }),
    });
    expect(html).toContain("Connected");
    expect(html).toContain("build-box · 24 cores · 188 GB");
    expect(html).toContain("Nobody else in the team can.");
    expect(html).not.toContain("curl -fsSL");
  });
  test("a team computer says the team can use it", () => {
    const html = own({
      status: status({ state: "connected", scope: "team", computer: { name: "ci", os: null, arch: null, cpus: 8, memory_gb: 32 } }),
    });
    expect(html).toContain("Everyone in the team can use it now.");
  });
  test("a line that ran out offers a new one", () => {
    const html = own({ status: status({ state: "expired" }), now: Date.parse("2026-11-13T10:11:00Z") });
    expect(html).toContain("ran out");
    expect(html).toContain("Make a new line");
    expect(html).not.toContain("in the next");
  });
  test("a refusal is the server's sentence", () => {
    const html = own({ issued: null, status: null, failed: "Only a team admin can add a computer the whole team shares.", scope: "team" });
    expect(html).toContain("Only a team admin can add a computer the whole team shares.");
    expect(html).toContain("Everyone in the team can use it");
  });
});

describe("this computer", () => {
  const joined = (over: Partial<JoinReport>): JoinReport => ({
    ok: true,
    state: "connected",
    message: "Connected to Acme. You can close this window.",
    org: "Acme",
    name: "Mo's MacBook",
    pair_id: issued.id,
    agent_ready: true,
    ...over,
  });

  test("asks first, in plain words", () => {
    const html = renderToStaticMarkup(<ThisComputerView phase={{ at: "ask" }} status={null} slow={false} onGo={none} />);
    expect(html).toContain("nothing can connect in");
    expect(html).toContain("only you can use it");
    expect(html).toContain("Connect this computer");
  });
  test("waits for it to check in, then reads like any other computer", () => {
    const waiting = renderToStaticMarkup(
      <ThisComputerView phase={{ at: "joined", report: joined({}) }} status={status({ state: "joining" })} slow={false} onGo={none} />,
    );
    expect(waiting).toContain("Starting Aura here…");
    const done = renderToStaticMarkup(
      <ThisComputerView
        phase={{ at: "joined", report: joined({}) }}
        status={status({ state: "connected", computer: { name: "Mo's MacBook", os: "macos", arch: "aarch64", cpus: 12, memory_gb: 36 } })}
        slow={false}
        onGo={none}
      />,
    );
    expect(done).toContain("Mo&#x27;s MacBook · 12 cores · 36 GB");
    const other = renderToStaticMarkup(<Connected computer={{ name: "Mo's MacBook", cpus: 12, memory_gb: 36 }} />);
    expect(done).toContain(other);
  });
  test("says so when it is slow", () => {
    const html = renderToStaticMarkup(
      <ThisComputerView phase={{ at: "joined", report: joined({}) }} status={status({ state: "joining" })} slow onGo={none} />,
    );
    expect(html).toContain("taking longer than usual");
  });
  test("already connected is connected", () => {
    const html = renderToStaticMarkup(
      <ThisComputerView
        phase={{ at: "joined", report: joined({ state: "already_connected", message: "Already connected to Acme." }) }}
        status={null}
        slow={false}
        onGo={none}
      />,
    );
    expect(html).toContain("Mo&#x27;s MacBook");
    expect(html).toContain("Already connected to Acme.");
  });
  test("asks for Claude Code when it isn't here", () => {
    const html = renderToStaticMarkup(
      <ThisComputerView phase={{ at: "joined", report: joined({ agent_ready: false }) }} status={null} slow={false} onGo={none} />,
    );
    expect(html).toContain("Install Claude Code on this computer");
  });
  test("a failure says what aura join said and offers to try again", () => {
    const html = renderToStaticMarkup(
      <ThisComputerView phase={{ at: "failed", message: "This computer is already set up as an Aura computer, so nothing was changed." }} status={null} slow={false} onGo={none} />,
    );
    expect(html).toContain("already set up as an Aura computer");
  });
});
