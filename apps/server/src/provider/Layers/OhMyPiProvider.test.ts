import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import { buildOhMyPiModelsFromSessionSetup } from "./OhMyPiProvider.ts";

describe("buildOhMyPiModelsFromSessionSetup", () => {
  it("uses the provider-reported catalog and preserves custom models", () => {
    const models: EffectAcpSchema.SessionModelState = {
      currentModelId: "anthropic/claude-sonnet",
      availableModels: [
        { modelId: "anthropic/claude-sonnet", name: "Claude Sonnet" },
        { modelId: "openai/gpt-5", name: "GPT-5" },
      ],
    };

    const result = buildOhMyPiModelsFromSessionSetup({ models }, ["local/qwen"]);

    expect(result.map((model) => model.slug)).toEqual([
      "anthropic/claude-sonnet",
      "openai/gpt-5",
      "local/qwen",
    ]);
    expect(result[0]?.isDefault).toBe(true);
    expect(result[2]?.isCustom).toBe(true);
  });

  it("does not expose the ACP interaction mode as a model option", () => {
    const result = buildOhMyPiModelsFromSessionSetup({
      models: {
        currentModelId: "model-a",
        availableModels: [{ modelId: "model-a", name: "Model A" }],
      },
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "plan",
          options: [{ value: "plan", name: "Plan" }],
        },
      ],
    });

    expect(result[0]?.capabilities?.optionDescriptors ?? []).toEqual([]);
  });

  it("falls back to the provider current model when availability is not enumerated", () => {
    const result = buildOhMyPiModelsFromSessionSetup({
      models: {
        currentModelId: "gateway/current",
        availableModels: [],
      },
    });

    expect(result.map((model) => model.slug)).toEqual(["gateway/current"]);
    expect(result[0]?.isDefault).toBe(true);
  });
});
