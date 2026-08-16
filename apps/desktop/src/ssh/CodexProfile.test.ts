// @effect-diagnostics nodeBuiltinImport:off - The profile reader is tested against an isolated filesystem.
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { readLocalCodexProfile } from "./CodexProfile.ts";

describe("local Codex profile", () => {
  it("reads global instructions and complete skills without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-codex-profile-"));
    try {
      const codexHome = join(root, "codex");
      const skillsHome = join(root, ".agents", "skills");
      const skillHome = join(skillsHome, "reviewer");
      const ignoredSkillHome = join(skillsHome, "without-manifest");
      const outside = join(root, "outside.txt");
      await mkdir(codexHome, { recursive: true });
      await mkdir(skillHome, { recursive: true });
      await mkdir(ignoredSkillHome, { recursive: true });
      await writeFile(join(codexHome, "AGENTS.md"), "global instructions\n");
      await writeFile(join(codexHome, "AGENTS.override.md"), "override instructions\n");
      await writeFile(join(codexHome, "config.toml"), "model = 'gpt-5'\n");
      await writeFile(join(skillHome, "SKILL.md"), "# Reviewer\n");
      await writeFile(join(skillHome, "reference.md"), "reference\n");
      await writeFile(join(ignoredSkillHome, "notes.md"), "ignored\n");
      await writeFile(outside, "outside\n");
      await symlink(outside, join(skillHome, "outside-link.txt"));

      const profile = await readLocalCodexProfile({
        homeDirectory: root,
        codexHome: "codex",
      });
      const paths = profile.snapshot.files.map((file) => file.path);

      assert.deepEqual(paths, [
        "AGENTS.md",
        "AGENTS.override.md",
        "config.toml",
        "skills/reviewer/reference.md",
        "skills/reviewer/SKILL.md",
      ]);
      assert.equal(profile.snapshot.codexHomePath, codexHome);
      assert.equal(profile.snapshot.skillsPath, skillsHome);
      assert.ok(profile.snapshot.warnings.some((warning) => warning.includes("outside-link.txt")));
      assert.equal(
        Buffer.from(
          profile.files.find((file) => file.path === "AGENTS.md")?.contentsBase64 ?? "",
          "base64",
        ).toString("utf8"),
        "global instructions\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips files above the per-file limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-codex-profile-"));
    try {
      const codexHome = join(root, ".codex");
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "AGENTS.md"), Buffer.alloc(2_000_001));

      const profile = await readLocalCodexProfile({ homeDirectory: root });

      assert.equal(profile.snapshot.files.length, 0);
      assert.ok(profile.snapshot.warnings.some((warning) => warning.includes("oversized")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
