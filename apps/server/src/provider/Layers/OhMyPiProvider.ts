import {
  type ModelCapabilities,
  type OhMyPiSettings,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { createModelCapabilities } from "@t3tools/shared/model";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeOhMyPiAcpRuntime } from "../acp/OhMyPiAcpSupport.ts";

const OH_MY_PI_PRESENTATION = {
  displayName: "Oh My Pi",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

type SelectConfigOption = Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>;

function isModelConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  return option.id.trim() === "model" || option.category === "model";
}

function selectConfigOptionValues(option: SelectConfigOption) {
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [entry]
      : entry.options.map((groupOption) => ({
          ...groupOption,
          name: entry.name + ": " + groupOption.name,
        })),
  );
}

function modelCapabilitiesFromConfigOptions(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  const optionDescriptors: Array<ProviderOptionDescriptor> = [];
  for (const option of options ?? []) {
    const id = option.id.trim();
    const label = option.name.trim() || id;
    if (!id || isModelConfigOption(option) || id === "mode") {
      continue;
    }
    if (option.type === "boolean") {
      const description = option.description?.trim();
      optionDescriptors.push(
        buildBooleanOptionDescriptor({
          id,
          label,
          currentValue: option.currentValue,
          ...(description ? { description } : {}),
        }),
      );
      continue;
    }
    const values = selectConfigOptionValues(option);
    const description = option.description?.trim();
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id,
        label,
        options: values.map((value) => {
          const valueDescription = value.description?.trim();
          return {
            value: value.value,
            label: value.name.trim() || value.value,
            ...(valueDescription ? { description: valueDescription } : {}),
            ...(value.value === option.currentValue ? { isDefault: true } : {}),
          };
        }),
        ...(description ? { description } : {}),
      }),
    );
  }
  return createModelCapabilities({ optionDescriptors });
}

function modelsFromConfigOption(
  option: EffectAcpSchema.SessionConfigOption | undefined,
  capabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  if (!option || option.type !== "select" || !isModelConfigOption(option)) {
    return [];
  }

  const currentModelId = option.currentValue.trim();
  const seen = new Set<string>();
  const models = selectConfigOptionValues(option).flatMap((value) => {
    const slug = value.value.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: value.name.trim() || slug,
        isCustom: false,
        ...(slug === currentModelId ? { isDefault: true } : {}),
        capabilities,
      },
    ];
  });

  return currentModelId && !seen.has(currentModelId)
    ? [
        ...models,
        {
          slug: currentModelId,
          name: currentModelId,
          isCustom: false,
          isDefault: true,
          capabilities,
        },
      ]
    : models;
}

export function buildOhMyPiModelsFromSessionSetup(
  setup:
    | {
        readonly models?: EffectAcpSchema.SessionModelState | null;
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
  customModels: ReadonlyArray<string> = [],
): ReadonlyArray<ServerProviderModel> {
  const models = setup?.models;
  const capabilities = modelCapabilitiesFromConfigOptions(setup?.configOptions);
  const modelsFromSessionState =
    models?.availableModels.flatMap((model) => {
      const slug = model.modelId.trim();
      if (!slug) return [];
      return [
        {
          slug,
          name: model.name.trim() || slug,
          isCustom: false,
          isDefault: slug === models.currentModelId.trim(),
          capabilities,
        },
      ];
    }) ?? [];
  const modelConfigOption = setup?.configOptions?.find(isModelConfigOption);
  const builtInModels =
    modelsFromSessionState.length > 0
      ? modelsFromSessionState
      : modelsFromConfigOption(modelConfigOption, capabilities);
  const currentModelId = models?.currentModelId.trim();
  const builtInModelsWithCurrent =
    builtInModels.length === 0 && currentModelId
      ? [
          {
            slug: currentModelId,
            name: currentModelId,
            isCustom: false,
            isDefault: true,
            capabilities,
          },
        ]
      : builtInModels;
  return providerModelsFromSettings(builtInModelsWithCurrent, customModels, capabilities);
}

export function buildInitialOhMyPiProviderSnapshot(
  settings: OhMyPiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: OH_MY_PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
      probe: settings.enabled
        ? {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Oh My Pi availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Oh My Pi is disabled in T3 Code settings.",
          },
    });
  });
}

function runOhMyPiVersionCommand(settings: OhMyPiSettings, environment: NodeJS.ProcessEnv) {
  return Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(
      settings.binaryPath,
      [...tokenizeCliArgs(settings.launchArgs), "--version"],
      {
        env: environment,
      },
    );
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });
}

function discoverOhMyPiModels(
  settings: OhMyPiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  agentDir: string | undefined,
) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeOhMyPiAcpRuntime({
      ohMyPiSettings: settings,
      environment,
      ...(agentDir ? { agentDir } : {}),
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    return { setup: started.sessionSetupResult };
  }).pipe(Effect.scoped);
}

export function checkOhMyPiProviderStatus(
  settings: OhMyPiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  agentDir: string | undefined,
): Effect.Effect<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | import("effect/Crypto").Crypto
> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) {
      return buildServerProvider({
        presentation: OH_MY_PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Oh My Pi is disabled in T3 Code settings.",
        },
      });
    }

    const versionExit = yield* runOhMyPiVersionCommand(settings, environment).pipe(
      Effect.timeoutOption(4_000),
      Effect.result,
    );
    if (Result.isFailure(versionExit)) {
      const cause = versionExit.failure;
      return buildServerProvider({
        presentation: OH_MY_PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
        probe: {
          installed: !isCommandMissingCause(cause),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(cause)
            ? "Oh My Pi executable (omp) is not installed or not on PATH."
            : "Failed to execute the Oh My Pi version check.",
        },
      });
    }
    if (versionExit.success._tag === "None") {
      return buildServerProvider({
        presentation: OH_MY_PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Oh My Pi is installed but the version check timed out.",
        },
      });
    }

    const versionResult = versionExit.success.value;
    const version = parseGenericCliVersion(versionResult.stdout + "\n" + versionResult.stderr);
    if (versionResult.code !== 0) {
      return buildServerProvider({
        presentation: OH_MY_PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Oh My Pi is installed but failed to run.",
        },
      });
    }

    const discoveryExit = yield* discoverOhMyPiModels(settings, cwd, environment, agentDir).pipe(
      Effect.timeoutOption(15_000),
      Effect.exit,
    );
    if (Exit.isFailure(discoveryExit)) {
      return buildServerProvider({
        presentation: OH_MY_PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Oh My Pi ACP startup failed. Check the server log for details.",
        },
      });
    }
    if (discoveryExit.value._tag === "None") {
      return buildServerProvider({
        presentation: OH_MY_PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Oh My Pi ACP startup timed out.",
        },
      });
    }

    const discovered = discoveryExit.value.value;
    const models = buildOhMyPiModelsFromSessionSetup(discovered.setup, settings.customModels);
    return buildServerProvider({
      presentation: OH_MY_PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated", type: "agent", label: "Oh My Pi" },
        ...(models.length === 0
          ? { message: "Oh My Pi is available but did not report any models." }
          : {}),
      },
    });
  });
}

export function enrichOhMyPiSnapshot(input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks: boolean | undefined;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> {
  return enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to enrich Oh My Pi provider snapshot.", { cause }),
    ),
  );
}
