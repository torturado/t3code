import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { SkillEntry, SkillSearchInput, SkillSearchResult } from "./skill";

const decodeSkillSearchInput = Schema.decodeUnknownEffect(SkillSearchInput);
const decodeSkillEntry = Schema.decodeUnknownEffect(SkillEntry);
const decodeSkillSearchResult = Schema.decodeUnknownEffect(SkillSearchResult);

it.effect("accepts empty skill queries so the $ menu can open immediately", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeSkillSearchInput({
      query: "   ",
      limit: 20,
    });
    assert.strictEqual(parsed.query, "");
    assert.strictEqual(parsed.limit, 20);
  }),
);

it.effect("rejects invalid skill sources", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSkillEntry({
        name: "brainstorming",
        description: "Creative planning",
        skillPath: "/tmp/brainstorming/SKILL.md",
        source: "other",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes skill search results", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeSkillSearchResult({
      entries: [
        {
          name: "brainstorming",
          description: "Creative planning",
          skillPath: "/tmp/brainstorming/SKILL.md",
          source: "agents",
        },
      ],
      truncated: false,
    });
    assert.strictEqual(parsed.entries[0]?.name, "brainstorming");
    assert.strictEqual(parsed.truncated, false);
  }),
);
