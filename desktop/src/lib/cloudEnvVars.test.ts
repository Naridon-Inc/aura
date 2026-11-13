import { describe, expect, test } from "bun:test";

import { entriesProblem, envVarsRead, joinNames, keyRefusal, looksLikeEnvText, parseEnvText } from "./cloudEnvVars";

describe("cloud env vars", () => {
  test("a pasted block or file reads as its variables, last line winning", () => {
    const text = [
      "# comment",
      "export DATABASE_URL=postgres://x",
      "API_TOKEN=\"fake-one\"",
      "QUOTED='a b'",
      "TRAILING=v # note",
      "1BAD=x",
      "noequals",
      "API_TOKEN=fake-two",
    ].join("\n");
    expect(parseEnvText(text)).toEqual([
      { key: "DATABASE_URL", value: "postgres://x" },
      { key: "API_TOKEN", value: "fake-two" },
      { key: "QUOTED", value: "a b" },
      { key: "TRAILING", value: "v" },
    ]);
    expect(looksLikeEnvText("A=1\nB=2")).toBe(true);
    expect(looksLikeEnvText("DATABASE_URL")).toBe(false);
  });

  test("what stops a save is said in the order it is fixed", () => {
    const none = new Set<string>();
    expect(entriesProblem([{ key: "", value: "x" }], none)).toBe("Key is required.");
    expect(entriesProblem([{ key: "A-B", value: "x" }], none)).toContain("Invalid variable name: A-B");
    expect(entriesProblem([{ key: "ANTHROPIC_API_KEY", value: "x" }], none)).toContain("agent's sign-in");
    expect(keyRefusal("PATH")).toContain("install script");
    expect(entriesProblem([{ key: "A", value: "x" }], new Set(["A"]))).toBe("A already exists. Edit it instead.");
    expect(
      entriesProblem(
        [
          { key: "A", value: "x" },
          { key: "B", value: "y" },
        ],
        new Set(["A", "B"]),
      ),
    ).toContain("These variables already exist: A, B");
    expect(entriesProblem([{ key: "FINE", value: "x" }], none)).toBeUndefined();
  });

  test("a server without env vars is a quiet not-yet, anything else an error", () => {
    expect(envVarsRead("HTTP 404 Not Found: ").status).toBe("unavailable");
    expect(envVarsRead("command cloud_env_vars_list not found").status).toBe("unavailable");
    expect(envVarsRead("no cloud_api_token").status).toBe("unavailable");
    expect(envVarsRead("HTTP 500 Internal Server Error: boom")).toEqual({
      status: "failed",
      message: "HTTP 500 Internal Server Error: boom",
    });
  });

  test("names join the way a sentence does", () => {
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B, and C");
  });
});
