import { describe, expect, test } from "bun:test";

import type { BrainChoice, ModelCatalog } from "./api";
import {
  catalogFor,
  familyOf,
  modelBrandId,
  modelBrandName,
} from "./modelCatalog";

// An ACP agent is the one brain family whose models Aura does not know in
// advance — the agent publishes them at session time and the backend probe
// forwards that list. These pin the two ways that goes wrong in the picker:
// the section falling back to a bare "Default" row, and the rows wearing the
// engine's mark instead of the mark of whoever makes each model.

function brain(over: Partial<BrainChoice> = {}): BrainChoice {
  return {
    id: "acp:opencode",
    label: "OpenCode",
    kind: "acp",
    active: false,
    requires_api_key: false,
    has_api_key: false,
    ...over,
  };
}

describe("an ACP agent in the model picker", () => {
  test("gets a section of its own, not a vendor's", () => {
    expect(familyOf(brain())).toBe("opencode");
  });

  test("an agent we have no models for is still grouped, not mislabeled", () => {
    // A future `acp:<something>` must not silently borrow OpenCode's list.
    expect(familyOf(brain({ id: "acp:someone-else", label: "Someone Else" }))).toBe("generic");
  });

  test("the CLI wrapper of the same engine gets the same list", () => {
    // `cli_wrapper:opencode` and `acp:opencode` run the same binary against
    // the same models, and the CLI takes `-m provider/model` in the exact
    // spelling the published catalog uses (aura-agents/src/opencode.rs). They
    // sit next to each other in the picker, so the CLI entry falling through
    // to generic would show a lone "Default" beside the real catalog.
    expect(
      familyOf(brain({ id: "cli_wrapper:opencode", kind: "cli_wrapper" })),
    ).toBe("opencode");
  });

  test("shows what the agent published, with each row branded by its maker", () => {
    const live: ModelCatalog = {
      fetched_at: 0,
      cached: false,
      errors: {},
      families: {
        opencode: [
          {
            id: "opencode/big-pickle",
            label: "Big Pickle",
            key: "opencode-big-pickle",
            brand: "opencode",
            brandName: "OpenCode",
          },
          {
            id: "anthropic/claude-sonnet-4-6",
            label: "Claude Sonnet 4.6",
            key: "opencode-claude-sonnet-4-6",
            brand: "claude",
            brandName: "Claude",
          },
        ],
      },
    };
    const rows = catalogFor(brain(), live);
    expect(rows.map((r) => r.id)).toEqual([
      "opencode/big-pickle",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(modelBrandId("opencode", "acp:opencode", rows[0])).toBe("opencode");
    expect(modelBrandId("opencode", "acp:opencode", rows[1])).toBe("claude");
  });

  test("falls back to the agent's own default when nothing was published", () => {
    // Agent not installed, not signed in, or the probe timed out. One honest
    // row that runs on whatever the engine is already configured for beats an
    // invented model list.
    const rows = catalogFor(brain(), null);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeNull();
    expect(rows[0].label).toBe("Default");
    // Even that row wears the agent's mark rather than falling through to a
    // raw provider id.
    expect(modelBrandId("opencode", "acp:opencode", rows[0])).toBe("opencode");
    expect(modelBrandName("opencode", rows[0])).toBe("OpenCode");
  });

  test("the real backend payload renders as rows, not as one Default", () => {
    // Not a hand-written fixture: this is `~/.aura/model_catalog_cache.json`
    // as the app wrote it after probing a real `opencode acp` — the same
    // bytes `agentModelsList()` hands the picker. It is pinned here because
    // "the composer only shows Default" is a claim about this exact hop, and
    // the two entries in the picker (the ACP brain and the CLI wrapper) both
    // read the same family.
    const live: ModelCatalog = {
      fetched_at: 1785771897,
      cached: false,
      errors: { anthropic: "no API key configured" },
      families: {
        opencode: [
          "opencode/big-pickle:Big Pickle",
          "opencode/deepseek-v4-flash-free:DeepSeek V4 Flash Free (New)",
          "opencode/laguna-s-2.1-free:Laguna S 2.1 Free",
          "opencode/ling-3.0-flash-free:Ling-3.0-flash Free",
          "opencode/mimo-v2.5-free:MiMo V2.5 Free",
          "opencode/nemotron-3-ultra-free:Nemotron 3 Ultra Free",
          "opencode/north-mini-code-free:North Mini Code Free",
        ].map((row) => {
          const [id, label] = row.split(":");
          return {
            id,
            label,
            key: id.replace("/", "-"),
            vendor: "OpenCode",
            brand: "opencode",
            brandName: "OpenCode",
          };
        }),
      },
    };

    for (const entry of [
      brain(),
      brain({ id: "cli_wrapper:opencode", kind: "cli_wrapper" }),
    ]) {
      const rows = catalogFor(entry, live);
      expect(rows).toHaveLength(7);
      expect(rows.map((r) => r.label)).not.toContain("Default");
      // The engine's current selection leads — the backend floats it there
      // and the picker must not re-sort it away.
      expect(rows[0].id).toBe("opencode/big-pickle");
      expect(rows.every((r) => r.id != null)).toBe(true);
    }
  });
});

function piBrain(over: Partial<BrainChoice> = {}): BrainChoice {
  return {
    id: "pi",
    label: "pi",
    kind: "pi",
    active: false,
    requires_api_key: false,
    has_api_key: false,
    ...over,
  };
}

describe("pi in the model picker", () => {
  test("gets a section of its own, like any engine that publishes its list", () => {
    // pi doesn't speak ACP — it has its own RPC — so it arrives with its own
    // `kind`. The picker treatment has to be the same anyway: the engine
    // publishes, we show.
    expect(familyOf(piBrain())).toBe("pi");
  });

  test("the CLI wrapper of the same binary gets the same list", () => {
    // `cli_wrapper:pi` is the older text-on-stdout path, but it runs the same
    // engine against the same models and it *can* be told which one:
    // `pi --model <provider/id>`, in exactly the `provider/id` spelling the
    // published catalog uses (aura-agents/src/pi.rs). Falling through to
    // generic would show a lone "Default" beside the native brain's real
    // catalog and lose a choice the CLI would have honoured.
    expect(familyOf(piBrain({ id: "cli_wrapper:pi", kind: "cli_wrapper" }))).toBe("pi");
  });

  test("shows what pi published, each row branded by its maker", () => {
    const live: ModelCatalog = {
      fetched_at: 0,
      cached: false,
      errors: {},
      families: {
        pi: [
          {
            id: "anthropic/claude-opus-4-6",
            label: "Claude Opus 4.6",
            key: "pi-claude-opus-4-6",
            brand: "claude",
            brandName: "Claude",
          },
          {
            id: "openai/gpt-5",
            label: "GPT-5",
            key: "pi-gpt-5",
            brand: "codex",
            brandName: "GPT",
          },
        ],
      },
    };
    const rows = catalogFor(piBrain(), live);
    // The wire id keeps its `provider/modelId` shape — pi's `set_model`
    // needs both halves, so the picker must not helpfully strip the prefix.
    expect(rows.map((r) => r.id)).toEqual([
      "anthropic/claude-opus-4-6",
      "openai/gpt-5",
    ]);
    expect(modelBrandId("pi", "pi", rows[0])).toBe("claude");
    expect(modelBrandId("pi", "pi", rows[1])).toBe("codex");
  });

  test("a pi that is signed in to nothing shows one honest default", () => {
    // pi answers `get_available_models` with an empty list until a provider
    // is configured. That is a truthful answer, and the picker's job is to
    // pass it on — not to fill the gap with models pi cannot run.
    const rows = catalogFor(piBrain(), null);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeNull();
    expect(rows[0].label).toBe("Default");
    expect(modelBrandId("pi", "pi", rows[0])).toBe("pi");
    expect(modelBrandName("pi", rows[0])).toBe("pi");
  });
});
