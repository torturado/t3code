import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function writeSkill(root: string, relativeDir: string, contents: string): void {
  const skillDir = path.join(root, relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), contents, "utf8");
}

async function importSkillEntriesWithHome(homeDir: string) {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return {
      ...actual,
      default: {
        ...actual,
        homedir: () => homeDir,
      },
      homedir: () => homeDir,
    };
  });
  return import("./skillEntries");
}

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("skillEntries", () => {
  it("deduplicates case-insensitively and prefers ~/.agents skills", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-skills-"));
    tempDirs.push(homeDir);

    writeSkill(
      path.join(homeDir, ".agents", "skills"),
      "Brainstorming",
      ["---", "name: Brainstorming", "description: Creative planning", "---", "", "# Skill"].join(
        "\n",
      ),
    );
    writeSkill(
      path.join(homeDir, ".codex", "skills"),
      "brainstorming",
      ["---", "name: brainstorming", "description: Lower priority copy", "---"].join("\n"),
    );
    writeSkill(
      path.join(homeDir, ".codex", "skills"),
      "Testing",
      ["---", "name: Testing", "description: Write tests", "---"].join("\n"),
    );

    const { searchSkillEntries } = await importSkillEntriesWithHome(homeDir);
    const result = await searchSkillEntries({ query: "brain", limit: 10 });

    expect(result.truncated).toBe(false);
    expect(result.entries.map((entry) => entry.name)).toEqual(["Brainstorming"]);
    expect(result.entries[0]?.source).toBe("agents");
    expect(result.entries[0]?.description).toBe("Creative planning");
  });

  it("falls back to the directory name when frontmatter is missing", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-skills-"));
    tempDirs.push(homeDir);

    writeSkill(
      path.join(homeDir, ".agents", "skills"),
      "NoFrontmatter",
      "# NoFrontmatter\n\nThis skill has no metadata.",
    );

    const { searchSkillEntries } = await importSkillEntriesWithHome(homeDir);
    const result = await searchSkillEntries({ query: "", limit: 10 });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      name: "NoFrontmatter",
      description: "NoFrontmatter skill",
      source: "agents",
    });
  });
});
