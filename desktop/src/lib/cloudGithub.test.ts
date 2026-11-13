import { describe, expect, it } from "bun:test";
import {
  accessOf,
  candidateLine,
  candidateState,
  connectedLine,
  kindOf,
  ticketSettled,
  type ConnectCandidate,
  type ConnectedGithub,
} from "./cloudGithub";

const row = (over: Partial<ConnectedGithub>): ConnectedGithub => ({
  installation_id: 1,
  account_login: "uniskool",
  account_type: "Organization",
  repository_selection: "selected",
  status: "connected",
  repo_count: 2,
  ...over,
});

const candidate = (over: Partial<ConnectCandidate>): ConnectCandidate => ({
  id: 7,
  account_login: "uniskool",
  account_type: "Organization",
  repository_selection: "all",
  can_connect: true,
  why_not: null,
  connected_here: false,
  connected_elsewhere: false,
  ...over,
});

describe("connected GitHub rows", () => {
  it("say what the account is, what it opens and what it holds", () => {
    expect(connectedLine(row({}))).toBe("Organization · Selected repositories · 2 projects");
    expect(connectedLine(row({ account_type: "User", repository_selection: "all", repo_count: 1 }))).toBe(
      "Personal account · All repositories · 1 project",
    );
  });

  it("leave out what GitHub hasn't said yet", () => {
    expect(connectedLine(row({ account_type: null, repository_selection: null, repo_count: 0 }))).toBe("0 projects");
    expect(kindOf("Bot")).toBeNull();
    expect(accessOf(undefined)).toBeNull();
  });

  it("say so when the app was removed on GitHub", () => {
    expect(connectedLine(row({ status: "uninstalled" }))).toContain("removed from this account on GitHub");
  });
});

describe("accounts GitHub listed", () => {
  it("offer Connect only when nothing stands in the way", () => {
    expect(candidateState(candidate({}))).toEqual({ connectable: true, note: null });
    expect(candidateState(candidate({ connected_here: true })).note).toBe("Already connected");
    expect(candidateState(candidate({ connected_elsewhere: true })).note).toBe("Connected to another Aura organization");
    expect(candidateState(candidate({ can_connect: false, why_not: "Only an owner can." }))).toEqual({
      connectable: false,
      note: "Only an owner can.",
    });
    expect(candidateState(candidate({ can_connect: false })).note).toBe("You can’t connect this account.");
  });

  it("describe the account the same way a connected one is", () => {
    expect(candidateLine(candidate({ account_type: "User", repository_selection: "selected" }))).toBe(
      "Personal account · Selected repositories",
    );
  });

  it("stop asking once the ticket is settled", () => {
    expect(ticketSettled("waiting")).toBe(false);
    expect(ticketSettled("answered")).toBe(true);
    expect(ticketSettled("refused")).toBe(true);
    expect(ticketSettled("expired")).toBe(true);
  });
});
