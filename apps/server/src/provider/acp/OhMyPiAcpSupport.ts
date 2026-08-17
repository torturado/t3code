import type { OhMyPiSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const OMP_AUTH_METHOD = "agent";
export const OH_MY_PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export interface OhMyPiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ohMyPiSettings: Pick<OhMyPiSettings, "binaryPath" | "launchArgs">;
  readonly environment: NodeJS.ProcessEnv;
  readonly agentDir?: string;
}

export function buildOhMyPiAcpSpawnInput(
  settings: Pick<OhMyPiSettings, "binaryPath" | "launchArgs">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  agentDir?: string,
): AcpSessionRuntime.AcpSpawnInput {
  const env: NodeJS.ProcessEnv = {
    ...(environment ?? process.env),
    ...(agentDir?.trim() ? { [OH_MY_PI_AGENT_DIR_ENV]: agentDir.trim() } : {}),
  };

  return {
    command: settings.binaryPath || "omp",
    args: [...tokenizeCliArgs(settings.launchArgs), "acp"],
    cwd,
    env,
  };
}

export function buildOhMyPiRpcControlSpawnInput(
  settings: Pick<OhMyPiSettings, "binaryPath" | "launchArgs">,
  cwd: string,
  resumeSessionId: string,
  environment?: NodeJS.ProcessEnv,
  agentDir?: string,
): AcpSessionRuntime.AcpSpawnInput {
  const env: NodeJS.ProcessEnv = {
    ...(environment ?? process.env),
    ...(agentDir?.trim() ? { [OH_MY_PI_AGENT_DIR_ENV]: agentDir.trim() } : {}),
  };

  return {
    command: settings.binaryPath || "omp",
    args: [...tokenizeCliArgs(settings.launchArgs), "--mode", "rpc", "--resume", resumeSessionId],
    cwd,
    env,
  };
}

export const makeOhMyPiAcpRuntime = (
  input: OhMyPiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  import("effect-acp/errors").AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOhMyPiAcpSpawnInput(
          input.ohMyPiSettings,
          input.cwd,
          input.environment,
          input.agentDir,
        ),
        authMethodId: OMP_AUTH_METHOD,
        clientCapabilities: {
          auth: { terminal: false },
          elicitation: { form: {}, url: {} },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function currentOhMyPiModelId(
  setup:
    | {
        readonly models?: {
          readonly currentModelId: string;
        } | null;
        readonly configOptions?: ReadonlyArray<{
          readonly id: string;
          readonly currentValue?: string | boolean | null;
        }> | null;
      }
    | undefined,
): string | undefined {
  const fromModelState = setup?.models?.currentModelId?.trim();
  if (fromModelState) return fromModelState;
  const modelOption = setup?.configOptions?.find(
    (option) => option.id.trim() === "model" && typeof option.currentValue === "string",
  );
  return typeof modelOption?.currentValue === "string" && modelOption.currentValue.trim()
    ? modelOption.currentValue.trim()
    : undefined;
}

export function resolveOhMyPiModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}
