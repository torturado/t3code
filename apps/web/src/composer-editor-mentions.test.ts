import { describe, expect, it } from "vitest";

import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

describe("splitPromptIntoComposerSegments", () => {
  it("splits @path tokens followed by whitespace into path segments", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md please")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "path", value: "AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing mention token", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md")).toEqual([
      { type: "text", text: "Inspect @AGENTS.md" },
    ]);
  });

  it("keeps newlines around path tokens", () => {
    expect(splitPromptIntoComposerSegments("one\n@src/index.ts \ntwo")).toEqual([
      { type: "text", text: "one\n" },
      { type: "path", value: "src/index.ts" },
      { type: "text", text: " \ntwo" },
    ]);
  });

  it("splits $skill tokens independently from @path tokens", () => {
    expect(splitPromptIntoComposerSegments("Use $brainstorming with @AGENTS.md today")).toEqual([
      { type: "text", text: "Use " },
      { type: "skill", value: "brainstorming" },
      { type: "text", text: " with " },
      { type: "path", value: "AGENTS.md" },
      { type: "text", text: " today" },
    ]);
  });
});
