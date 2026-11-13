import { describe, expect, test } from "bun:test";

import type { ConnectCandidate, ConnectStart, ConnectTicket } from "../../../lib/cloudGithub";
import { keptPhase, onlyConnectable, phaseToKeep, ticketUntil } from "./useConnectGithub";

const start: ConnectStart = {
  ticket: "t-1",
  install_url: "https://github.com/apps/aura/installations/new?state=s",
  authorize_url: "https://app.example/github/authorize?state=s",
  expires_in_minutes: 15,
};

const cand = (over: Partial<ConnectCandidate>): ConnectCandidate => ({
  id: 1,
  account_login: "acme",
  can_connect: true,
  connected_here: false,
  connected_elsewhere: false,
  ...over,
});

const ticket = (candidates: ConnectCandidate[], status: ConnectTicket["status"] = "answered"): ConnectTicket => ({
  status,
  candidates,
});

describe("a trip to GitHub survives a reload", () => {
  test("the ticket's own lifetime, or ten minutes", () => {
    expect(ticketUntil(start, 1000)).toBe(1000 + 15 * 60_000);
    expect(ticketUntil({ ...start, expires_in_minutes: null }, 0)).toBe(10 * 60_000);
  });

  test("installing and signing in are kept; an answer is kept as signing in", () => {
    expect(phaseToKeep({ at: "installing", start }, 9)).toEqual({ at: "installing", start, until: 9 });
    expect(phaseToKeep({ at: "signing_in", start }, 9)).toEqual({ at: "signing_in", start, until: 9 });
    expect(phaseToKeep({ at: "answered", start, ticket: ticket([cand({})]) }, 9)).toEqual({
      at: "signing_in",
      start,
      until: 9,
    });
  });

  test("nothing is kept when idle, starting, or when GitHub refused or ran out", () => {
    expect(phaseToKeep({ at: "idle" }, 9)).toBeNull();
    expect(phaseToKeep({ at: "starting" }, 9)).toBeNull();
    expect(phaseToKeep({ at: "answered", start, ticket: ticket([], "expired") }, 9)).toBeNull();
    expect(phaseToKeep({ at: "answered", start, ticket: ticket([], "refused") }, 9)).toBeNull();
  });

  test("a kept trip comes back until its ticket runs out, and junk is ignored", () => {
    const raw = JSON.stringify({ at: "installing", start, until: 5000 });
    expect(keptPhase(raw, 4999)).toEqual({ at: "installing", start, until: 5000 });
    expect(keptPhase(raw, 5000)).toBeNull();
    expect(keptPhase(null, 0)).toBeNull();
    expect(keptPhase("{nope", 0)).toBeNull();
    expect(keptPhase(JSON.stringify({ at: "answered", start, until: 9e15 }), 0)).toBeNull();
    expect(keptPhase(JSON.stringify({ at: "signing_in", start: { ticket: 1 }, until: 9e15 }), 0)).toBeNull();
  });
});

describe("the only account that can be connected is connected without asking", () => {
  test("one connectable among others that can't be", () => {
    const one = cand({ id: 7, account_login: "solo" });
    const t = ticket([cand({ id: 1, connected_here: true }), one, cand({ id: 3, can_connect: false })]);
    expect(onlyConnectable(t)).toBe(one);
  });

  test("two to choose from, none, or no answer: ask", () => {
    expect(onlyConnectable(ticket([cand({ id: 1 }), cand({ id: 2 })]))).toBeNull();
    expect(onlyConnectable(ticket([cand({ connected_elsewhere: true })]))).toBeNull();
    expect(onlyConnectable(ticket([cand({})], "expired"))).toBeNull();
  });
});
