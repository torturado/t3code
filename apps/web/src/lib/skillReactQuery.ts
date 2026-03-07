import type { SkillSearchResult } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const skillQueryKeys = {
  all: ["skills"] as const,
  search: (query: string, limit: number) => ["skills", "search", query, limit] as const,
};

const DEFAULT_SKILL_LIMIT = 40;
const DEFAULT_SKILL_STALE_TIME = 15_000;
const EMPTY_SKILL_SEARCH_RESULT: SkillSearchResult = {
  entries: [],
  truncated: false,
};

export function skillSearchQueryOptions(input: {
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SKILL_LIMIT;
  return queryOptions({
    queryKey: skillQueryKeys.search(input.query, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.skills.search({
        query: input.query,
        limit,
      });
    },
    enabled: input.enabled ?? true,
    staleTime: input.staleTime ?? DEFAULT_SKILL_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SKILL_SEARCH_RESULT,
  });
}
