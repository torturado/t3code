import { describe, expect, it } from "vite-plus/test";

import { buildOhMyPiAcpSpawnInput, buildOhMyPiRpcControlSpawnInput } from "./OhMyPiAcpSupport.ts";

describe("OhMyPiAcpSupport", () => {
  it("keeps configured global arguments before the ACP subcommand", () => {
    expect(
      buildOhMyPiAcpSpawnInput(
        { binaryPath: "/opt/omp", launchArgs: '--config "config with spaces.yml" --verbose' },
        "/workspace/project",
        { PATH: "/bin" },
        "/tmp/omp-agent",
      ),
    ).toEqual({
      command: "/opt/omp",
      args: ["--config", "config with spaces.yml", "--verbose", "acp"],
      cwd: "/workspace/project",
      env: { PATH: "/bin", PI_CODING_AGENT_DIR: "/tmp/omp-agent" },
    });
  });

  it("builds native rollback control arguments without changing the ACP command", () => {
    expect(
      buildOhMyPiRpcControlSpawnInput(
        { binaryPath: "omp", launchArgs: "--profile work" },
        "/workspace/project",
        "session-1",
        { PATH: "/bin" },
      ).args,
    ).toEqual(["--profile", "work", "--mode", "rpc", "--resume", "session-1"]);
  });
});
