import { assert, describe, it } from "@effect/vitest";

import { buildCodexProfileApplyScript, buildCodexProfileInspectScript } from "./codexProfile.ts";

describe("Codex profile SSH scripts", () => {
  it("keeps the remote destination allowlisted and writes backups atomically", () => {
    const script = buildCodexProfileApplyScript({
      files: [
        {
          path: "AGENTS.md",
          kind: "instructions",
          contentsBase64: Buffer.from("private instructions", "utf8").toString("base64"),
          mode: 0o600,
        },
      ],
    });

    assert.include(script, "Profile path escapes its destination root.");
    assert.include(script, "Profile destination contains a symlink.");
    assert.include(script, "backups");
    assert.include(script, "t3-profile-");
    assert.include(script, "fs.renameSync(temporaryPath, destination.target)");
    assert.include(script, 'file.path.split("/").includes("..")');
    assert.notInclude(script, "private instructions");
  });

  it("inspects only the supported Codex global profile locations", () => {
    const script = buildCodexProfileInspectScript();

    assert.include(script, "AGENTS.md");
    assert.include(script, "AGENTS.override.md");
    assert.include(script, "config.toml");
    assert.include(script, "skills/");
    assert.include(script, "entry.isSymbolicLink()");
    assert.notInclude(script, "auth.json");
  });
});
