import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";

const SKILL_SEARCH_MAX_LIMIT = 200;

export const SkillSource = Schema.Literals(["agents", "codex"]);
export type SkillSource = typeof SkillSource.Type;

export const SkillEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  skillPath: TrimmedNonEmptyString,
  source: SkillSource,
});
export type SkillEntry = typeof SkillEntry.Type;

export const SkillSearchInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(SKILL_SEARCH_MAX_LIMIT)),
});
export type SkillSearchInput = typeof SkillSearchInput.Type;

export const SkillSearchResult = Schema.Struct({
  entries: Schema.Array(SkillEntry),
  truncated: Schema.Boolean,
});
export type SkillSearchResult = typeof SkillSearchResult.Type;
