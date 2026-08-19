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

  it("reads the model catalog from the ACP model config option", () => {
    const result = buildOhMyPiModelsFromSessionSetup({
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "openai-codex/gpt-5.6-luna",
          options: [
            { value: "openai-codex/gpt-5.4", name: "GPT-5.4" },
            { value: "openai-codex/gpt-5.4-mini", name: "GPT-5.4 Mini" },
            { value: "openai-codex/gpt-5.5", name: "GPT-5.5" },
            { value: "openai-codex/gpt-5.6-luna", name: "GPT-5.6 Luna" },
            { value: "openai-codex/gpt-5.6-sol", name: "GPT-5.6 Sol" },
            { value: "openai-codex/gpt-5.6-terra", name: "GPT-5.6 Terra" },
            {
              value: "openai-codex/gpt-daybreak-blue-latest",
              name: "Daybreak Blue",
            },
          ],
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "max",
          options: [{ value: "max", name: "Max" }],
        },
      ],
    });

    expect(result.map((model) => model.slug)).toEqual([
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.4-mini",
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-daybreak-blue-latest",
    ]);
    expect(result.find((model) => model.slug === "openai-codex/gpt-5.6-luna")?.isDefault).toBe(
      true,
    );
    expect(result[0]?.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual([
      "thinking",
    ]);
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
