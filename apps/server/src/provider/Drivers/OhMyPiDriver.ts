import { OhMyPiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOhMyPiTextGeneration } from "../../textGeneration/OhMyPiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOhMyPiAdapter } from "../Layers/OhMyPiAdapter.ts";
import {
  buildInitialOhMyPiProviderSnapshot,
  checkOhMyPiProviderStatus,
  enrichOhMyPiSnapshot,
} from "../Layers/OhMyPiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeOhMyPiSettings = Schema.decodeSync(OhMyPiSettings);
const DRIVER_KIND = ProviderDriverKind.make("ohMyPi");

const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: "@oh-my-pi/pi-coding-agent",
  }),
);

export type OhMyPiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

function resolveAgentDir(input: {
  readonly settings: OhMyPiSettings;
  readonly cwd: string;
  readonly path: Path.Path;
}): string | undefined {
  const configured = input.settings.agentDir.trim();
  if (configured) {
    return input.path.resolve(input.cwd, expandHomePath(configured));
  }

  // Preserve Oh My Pi's native agent directory when no override is configured.
  // That is where its credentials, model catalog, and provider configuration
  // live. An explicit agentDir still gives each instance an isolated setup.
  return undefined;
}

export const OhMyPiDriver: ProviderDriver<OhMyPiSettings, OhMyPiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Oh My Pi",
    supportsMultipleInstances: true,
  },
  configSchema: OhMyPiSettings,
  defaultConfig: (): OhMyPiSettings => decodeOhMyPiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies OhMyPiSettings;
      const agentDir = resolveAgentDir({
        settings: effectiveConfig,
        cwd: serverConfig.cwd,
        path,
      });

      if (agentDir) {
        yield* fileSystem.makeDirectory(agentDir, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to prepare Oh My Pi agent directory: ${cause.message}`,
                cause,
              }),
          ),
        );
      }

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeOhMyPiAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        ...(agentDir ? { agentDir } : {}),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOhMyPiTextGeneration(effectiveConfig, {
        environment: processEnv,
        ...(agentDir ? { agentDir } : {}),
      });

      const checkProvider = checkOhMyPiProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnv,
        agentDir,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OhMyPiSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOhMyPiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichOhMyPiSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Oh My Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
