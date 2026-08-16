import { assert, describe, it } from "@effect/vitest";

import { diffCodexProfiles } from "./CodexProfileSyncDialog.logic";

const snapshot = (files: Array<{ path: string; sha256: string }>) => ({
  homePath: "/home/test",
  codexHomePath: "/home/test/.codex",
  skillsPath: "/home/test/.agents/skills",
  files: files.map((file) => ({ ...file, kind: "skill" as const, size: 1 })),
  warnings: [],
});

describe("Codex profile diff", () => {
  it("reports additions, changes, unchanged files, and remote-only files", () => {
    const diff = diffCodexProfiles(
      snapshot([
        { path: "AGENTS.md", sha256: "same" },
        { path: "skills/a/SKILL.md", sha256: "new" },
        { path: "skills/b/SKILL.md", sha256: "changed" },
      ]),
      snapshot([
        { path: "AGENTS.md", sha256: "same" },
        { path: "skills/b/SKILL.md", sha256: "old" },
        { path: "skills/remote-only/SKILL.md", sha256: "remote" },
      ]),
    );

    assert.deepEqual(diff, {
      added: 1,
      changed: 1,
      unchanged: 1,
      remoteOnly: 1,
    });
  });

  it("treats an unavailable remote profile as a first sync", () => {
    const diff = diffCodexProfiles(
      snapshot([
        { path: "AGENTS.md", sha256: "instructions" },
        { path: "skills/a/SKILL.md", sha256: "skill" },
      ]),
      null,
    );

    assert.deepEqual(diff, {
      added: 2,
      changed: 0,
      unchanged: 0,
      remoteOnly: 0,
    });
  });
});
