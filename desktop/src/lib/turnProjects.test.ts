import { describe, expect, test } from "bun:test";

import type { PersistedToolCall } from "./api";
import { projectsOfToolCall, projectsTouchedByTurn } from "./turnProjects";

function call(name: string, content: string, is_error = false): PersistedToolCall {
  return { tool_use_id: `${name}-1`, name, input: {}, result: { is_error, content } };
}

describe("what a tool result says it acted on", () => {
  test("a JSON result's `target` names the project", () => {
    const c = call(
      "aura_board_create",
      JSON.stringify({ id: "t1", target: { project: "api", root: "/r/api" } }),
    );
    expect(projectsOfToolCall(c)).toEqual([{ label: "api", root: "/r/api" }]);
  });

  test("a workspace in the target is carried", () => {
    const c = call(
      "aura_workspace_create",
      JSON.stringify({
        created: true,
        target: { project: "api", root: "/r/api", workspace: "/r/api-wt/fix-login" },
      }),
    );
    expect(projectsOfToolCall(c)).toEqual([
      { label: "api", root: "/r/api", workspace: "/r/api-wt/fix-login" },
    ]);
  });

  test("a plain-text result names it on its trailing marker line", () => {
    const c = call(
      "aura_ask",
      'Three callers.\naura-target: {"project":"web","root":"/r/web"}',
    );
    expect(projectsOfToolCall(c)).toEqual([{ label: "web", root: "/r/web" }]);
  });

  test("a fleet sweep names each project on its own row", () => {
    const c = call(
      "aura_project_status",
      JSON.stringify({
        projects: [
          { project: "api", root: "/r/api" },
          { project: "web", root: "/r/web" },
        ],
      }),
    );
    expect(projectsOfToolCall(c).map((p) => p.root)).toEqual(["/r/api", "/r/web"]);
  });

  test("a failed call acted on nothing", () => {
    const c = call(
      "aura_board_create",
      JSON.stringify({ target: { project: "api", root: "/r/api" } }),
      true,
    );
    expect(projectsOfToolCall(c)).toEqual([]);
  });

  test("a result with no marker and no target acted on nothing we can name", () => {
    expect(projectsOfToolCall(call("web_fetch", "<html>…</html>"))).toEqual([]);
    expect(projectsOfToolCall({ tool_use_id: "x", name: "bash", input: {}, result: null })).toEqual([]);
  });
});

describe("a turn's projects", () => {
  test("one chip per project, the later workspace kept", () => {
    const turn = {
      tool_calls: [
        call("aura_board_list", JSON.stringify({ target: { project: "api", root: "/r/api" } })),
        call(
          "aura_workspace_create",
          JSON.stringify({
            target: { project: "api", root: "/r/api", workspace: "/r/api-wt/fix" },
          }),
        ),
        call("aura_pages_list", JSON.stringify({ target: { project: "web", root: "/r/web" } })),
      ],
    };
    expect(projectsTouchedByTurn(turn)).toEqual([
      { label: "api", root: "/r/api", workspace: "/r/api-wt/fix" },
      { label: "web", root: "/r/web" },
    ]);
  });

  test("a turn without tools shows nothing", () => {
    expect(projectsTouchedByTurn({ tool_calls: undefined })).toEqual([]);
  });
});
