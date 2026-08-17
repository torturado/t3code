import {
  ApprovalRequestId,
  EventId,
  type OhMyPiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInteractionMode,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  parsePermissionRequest,
  type AcpSessionModeState,
  type AcpParsedSessionEvent,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  makeOhMyPiAcpRuntime,
  currentOhMyPiModelId,
  resolveOhMyPiModelId,
} from "../acp/OhMyPiAcpSupport.ts";
import { runOhMyPiNativeBranch } from "../acp/OhMyPiRpcControl.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("ohMyPi");
const RESUME_SCHEMA_VERSION = 1 as const;
const OMP_PLAN_MODE_ALIASES = new Set(["plan", "architect"]);
const OMP_IMPLEMENT_MODE_ALIASES = new Set(["default", "code", "agent", "chat", "implement"]);
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export interface OhMyPiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly agentDir?: string;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface OhMyPiSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  interruptedTurnIds: Set<TurnId>;
  currentModelId: string | undefined;
  lastPlanFingerprint: string | undefined;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResumeCursor(raw: unknown): string | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== RESUME_SCHEMA_VERSION) {
    return undefined;
  }
  return typeof raw.sessionId === "string" && raw.sessionId.trim()
    ? raw.sessionId.trim()
    : undefined;
}

function encodeJsonForDiagnostics(value: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(value);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function detailFromUnknown(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : decision === "decline"
          ? "reject_once"
          : undefined;
  if (kind === undefined) return undefined;
  return request.options.find((option) => option.kind === kind)?.optionId.trim() || undefined;
}

function autoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    request.options.find((option) => option.kind === "allow_always")?.optionId.trim() ||
    request.options.find((option) => option.kind === "allow_once")?.optionId.trim() ||
    undefined
  );
}

function questionOptions(property: unknown): ReadonlyArray<{ label: string; description: string }> {
  if (!isRecord(property)) return [];
  const values = Array.isArray(property.enum)
    ? property.enum
    : Array.isArray(property.oneOf)
      ? property.oneOf.flatMap((entry) =>
          isRecord(entry) && typeof entry.const === "string" ? [entry.const] : [],
        )
      : [];
  return values.flatMap((value) =>
    typeof value === "string" && value.trim()
      ? [{ label: value.trim(), description: "Oh My Pi option" }]
      : [],
  );
}

function questionsFromElicitation(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  if (request.mode === "url") {
    return [
      {
        id: request.elicitationId.trim() || "elicitation",
        header: "Open link",
        question: request.message.trim() + "\n\n" + request.url.trim(),
        options: [],
        multiSelect: false,
      },
    ];
  }

  const properties = Object.entries(request.requestedSchema.properties ?? {});
  if (properties.length === 0) {
    return [
      {
        id: "answer",
        header: request.requestedSchema.title?.trim() || "Input",
        question: request.message.trim() || "Oh My Pi is asking for input.",
        options: [],
        multiSelect: false,
      },
    ];
  }

  return properties.map(([id, property]) => {
    const propertyRecord: Record<string, unknown> = isRecord(property) ? property : {};
    const title =
      typeof propertyRecord.title === "string" && propertyRecord.title.trim()
        ? propertyRecord.title.trim()
        : id;
    const description =
      typeof propertyRecord.description === "string" && propertyRecord.description.trim()
        ? "\n\n" + propertyRecord.description.trim()
        : "";
    return {
      id,
      header: title,
      question: (request.message.trim() || "Oh My Pi is asking for input.") + description,
      options: questionOptions(property),
      multiSelect: propertyRecord.type === "array",
    };
  });
}

function toElicitationContent(
  answers: ProviderUserInputAnswers,
): Record<string, EffectAcpSchema.ElicitationContentValue> {
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      content[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((entry): entry is string => typeof entry === "string")
    ) {
      content[key] = value;
    }
  }
  return content;
}

function appendPromptResult(
  ctx: OhMyPiSessionContext,
  turnId: TurnId,
  prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existing = ctx.turns.find((turn) => turn.id === turnId);
  if (existing) {
    existing.items.push({ prompt, result });
  } else {
    ctx.turns.push({ id: turnId, items: [{ prompt, result }] });
  }
}

function stopReasonState(stopReason: EffectAcpSchema.StopReason): "completed" | "cancelled" {
  return stopReason === "cancelled" ? "cancelled" : "completed";
}

function resolveOhMyPiModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) return undefined;
  if (input.interactionMode === "plan") {
    return modeState.availableModes.find((mode) => OMP_PLAN_MODE_ALIASES.has(mode.id.toLowerCase()))
      ?.id;
  }
  return (
    modeState.availableModes.find((mode) => OMP_IMPLEMENT_MODE_ALIASES.has(mode.id.toLowerCase()))
      ?.id ??
    modeState.availableModes.find((mode) => !OMP_PLAN_MODE_ALIASES.has(mode.id.toLowerCase()))?.id
  );
}

export function makeOhMyPiAdapter(
  ohMyPiSettings: OhMyPiSettings,
  options?: OhMyPiAdapterLiveOptions,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig
  | Scope.Scope
> {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("ohMyPi");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const adapterScope = yield* Scope.Scope;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();
    const sessions = new Map<ThreadId, OhMyPiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Oh My Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Oh My Pi ACP callback.",
              cause,
            }),
        ),
      );

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Oh My Pi notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const completeTurn = (
      ctx: OhMyPiSessionContext,
      turnId: TurnId,
      input: {
        readonly state: "completed" | "cancelled" | "failed";
        readonly stopReason?: EffectAcpSchema.StopReason | null;
        readonly usage?: EffectAcpSchema.Usage | null;
        readonly errorMessage?: string;
      },
    ) =>
      Effect.gen(function* () {
        if (ctx.activeTurnId !== turnId) return;
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.activeTurnId = undefined;
        ctx.promptsInFlight = 0;
        ctx.session = { ...readySession, status: "ready", updatedAt };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: input.state,
            ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
            ...(input.usage ? { usage: input.usage } : {}),
            ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
          },
        });
      });

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const stopSessionInternal = (ctx: OhMyPiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        for (const pending of ctx.pendingApprovals.values()) {
          yield* Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore);
        }
        for (const pending of ctx.pendingUserInputs.values()) {
          yield* Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore);
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const handleAcpEvent = (ctx: OhMyPiSessionContext, event: AcpParsedSessionEvent) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurnId;
        if (turnId === undefined || ctx.interruptedTurnIds.has(turnId)) return;
        const stamp = yield* makeEventStamp();
        switch (event._tag) {
          case "ModeChanged":
            return;
          case "AssistantItemStarted":
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                itemId: event.itemId,
                lifecycle: "item.started",
              }),
            );
            return;
          case "AssistantItemCompleted":
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                itemId: event.itemId,
                lifecycle: "item.completed",
              }),
            );
            return;
          case "ContentDelta":
            yield* logNative(ctx.threadId, "session/update", event.rawPayload);
            yield* offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                ...(event.itemId ? { itemId: event.itemId } : {}),
                text: event.text,
                streamKind: event.streamKind,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "PlanUpdated": {
            yield* logNative(ctx.threadId, "session/update", event.rawPayload);
            const fingerprint = encodeJsonForDiagnostics(event.payload);
            if (fingerprint && ctx.lastPlanFingerprint === fingerprint) return;
            ctx.lastPlanFingerprint = fingerprint;
            yield* offerRuntimeEvent(
              makeAcpPlanUpdatedEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: event.payload,
                source: "acp.jsonrpc",
                method: "session/update",
                rawPayload: event.rawPayload,
              }),
            );
            return;
          }
          case "ToolCallUpdated":
            yield* logNative(ctx.threadId, "session/update", event.rawPayload);
            yield* offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;
        }
      });

    const startSessionUnsafe: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (
      input,
    ) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The requested provider does not match Oh My Pi.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const cwd = path.resolve(input.cwd.trim());
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopSessionInternal(existing);
        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred ? Effect.void : Scope.close(sessionScope, Exit.void).pipe(Effect.ignore),
        );
        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const resumeSessionId = parseResumeCursor(input.resumeCursor);
        const acpNativeLoggers = makeAcpNativeLoggers({
          nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
        });
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const acp = yield* makeOhMyPiAcpRuntime({
          ohMyPiSettings,
          environment: options?.environment ?? process.env,
          ...(options?.agentDir ? { agentDir: options.agentDir } : {}),
          childProcessSpawner,
          cwd,
          clientInfo: { name: "t3-code", version: "0.0.0" },
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...(mcpSession
            ? {
                mcpServers: [
                  {
                    type: "http" as const,
                    name: "t3-code",
                    url: mcpSession.endpoint,
                    headers: [{ name: "Authorization", value: mcpSession.authorizationHeader }],
                  },
                ],
              }
            : {}),
          ...acpNativeLoggers,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        yield* acp.handleRequestPermission((params) =>
          mapAcpCallbackFailure(
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/request_permission", params);
              if (input.runtimeMode === "full-access") {
                const optionId = autoApprovedPermissionOption(params);
                if (optionId) {
                  return { outcome: { outcome: "selected" as const, optionId } };
                }
              }
              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              pendingApprovals.set(requestId, { decision });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: sessions.get(input.threadId)?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail:
                    permissionRequest.detail ??
                    encodeJsonForDiagnostics(params)?.slice(0, 2_000) ??
                    "Oh My Pi requested permission.",
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision);
              pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: sessions.get(input.threadId)?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              const optionId = selectPermissionOptionId(params, resolved);
              return {
                outcome: optionId
                  ? { outcome: "selected" as const, optionId }
                  : ({ outcome: "cancelled" } as const),
              };
            }),
          ),
        );

        yield* acp.handleElicitation((params) =>
          mapAcpCallbackFailure(
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/elicitation", params);
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const resolution = yield* Deferred.make<PendingUserInputResolution>();
              pendingUserInputs.set(requestId, { resolution });
              yield* offerRuntimeEvent({
                type: "user-input.requested",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: sessions.get(input.threadId)?.activeTurnId,
                requestId: runtimeRequestId,
                payload: { questions: questionsFromElicitation(params) },
                raw: {
                  source: "acp.jsonrpc",
                  method: "session/elicitation",
                  payload: params,
                },
              });
              const resolved = yield* Deferred.await(resolution);
              pendingUserInputs.delete(requestId);
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: sessions.get(input.threadId)?.activeTurnId,
                requestId: runtimeRequestId,
                payload: {
                  answers: resolved._tag === "answered" ? resolved.answers : {},
                },
                raw: {
                  source: "acp.jsonrpc",
                  method: "session/elicitation",
                  payload: params,
                },
              });
              return resolved._tag === "answered"
                ? {
                    action: {
                      action: "accept" as const,
                      content: toElicitationContent(resolved.answers),
                    },
                  }
                : { action: { action: "cancel" as const } };
            }),
          ),
        );

        const started = yield* acp
          .start()
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );
        const requestedSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const currentModelId = currentOhMyPiModelId(started.sessionSetupResult);
        const requestedModelId = resolveOhMyPiModelId(requestedSelection?.model);
        if (requestedModelId && requestedModelId !== currentModelId) {
          yield* acp
            .setModel(requestedModelId)
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
              ),
            );
        }
        for (const option of requestedSelection?.options ?? []) {
          if (option.id === "model") continue;
          const configOption = (yield* acp.getConfigOptions).find(
            (candidate) => candidate.id === option.id,
          );
          if (configOption) {
            yield* acp
              .setConfigOption(option.id, option.value)
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    "session/set_config_option",
                    cause,
                  ),
                ),
              );
          }
        }
        const selectedModel = requestedModelId ?? currentModelId;
        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(selectedModel ? { model: selectedModel } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: RESUME_SCHEMA_VERSION,
            sessionId: started.sessionId,
          },
          createdAt: now,
          updatedAt: now,
        };
        const ctx: OhMyPiSessionContext = {
          threadId: input.threadId,
          acpSessionId: started.sessionId,
          session,
          scope: sessionScope,
          acp,
          notificationFiber: undefined,
          pendingApprovals,
          pendingUserInputs,
          turns: [],
          activeTurnId: undefined,
          promptsInFlight: 0,
          interruptedTurnIds: new Set(),
          currentModelId: selectedModel,
          lastPlanFingerprint: undefined,
          stopped: false,
        };
        sessions.set(input.threadId, ctx);
        ctx.notificationFiber = yield* Stream.runForEach(acp.getEvents(), (event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined)
            : handleAcpEvent(ctx, event),
        ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(sessionScope));
        transferred = true;
        yield* offerRuntimeEvent({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: resumeSessionId !== undefined },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Oh My Pi ACP session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });
        return session;
      }).pipe(Effect.provideService(Scope.Scope, adapterScope));

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      withThreadLock(input.threadId, startSessionUnsafe(input));

    const applyModelSelection = (
      ctx: OhMyPiSessionContext,
      selection: NonNullable<ProviderSendTurnInput["modelSelection"]> | undefined,
      interactionMode: ProviderInteractionMode | undefined,
    ) =>
      Effect.gen(function* () {
        if (selection?.instanceId === boundInstanceId) {
          const requestedModelId = resolveOhMyPiModelId(selection.model);
          if (requestedModelId && requestedModelId !== ctx.currentModelId) {
            yield* ctx.acp
              .setModel(requestedModelId)
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_config_option", cause),
                ),
              );
            ctx.currentModelId = requestedModelId;
            ctx.session = { ...ctx.session, model: requestedModelId, updatedAt: yield* nowIso };
          }
          for (const option of selection.options ?? []) {
            if (option.id === "model") continue;
            const configOption = (yield* ctx.acp.getConfigOptions).find(
              (candidate) => candidate.id === option.id,
            );
            if (configOption) {
              yield* ctx.acp
                .setConfigOption(option.id, option.value)
                .pipe(
                  Effect.mapError((cause) =>
                    mapAcpToAdapterError(
                      PROVIDER,
                      ctx.threadId,
                      "session/set_config_option",
                      cause,
                    ),
                  ),
                );
            }
          }
        }
        if (interactionMode === "plan") {
          const modeId = resolveOhMyPiModeId({
            interactionMode,
            modeState: yield* ctx.acp.getModeState,
          });
          if (!modeId) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/set_mode",
              detail: "Oh My Pi did not advertise a plan interaction mode over ACP.",
            });
          }
          yield* ctx.acp
            .setMode(modeId)
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_mode", cause),
              ),
            );
        } else if (interactionMode === "default") {
          const modeId = resolveOhMyPiModeId({
            interactionMode,
            modeState: yield* ctx.acp.getModeState,
          });
          if (modeId) {
            yield* ctx.acp
              .setMode(modeId)
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_mode", cause),
                ),
              );
          }
        }
      });

    const sendTurn = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            yield* applyModelSelection(ctx, input.modelSelection, input.interactionMode);
            const text = input.input?.trim();
            const imageParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
              Effect.gen(function* () {
                const attachmentPath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                if (!attachmentPath) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: "Invalid attachment id: " + attachment.id,
                  });
                }
                const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: cause.message,
                        cause,
                      }),
                  ),
                );
                return {
                  type: "image",
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                } satisfies EffectAcpSchema.ContentBlock;
              }),
            );
            const promptParts: Array<EffectAcpSchema.ContentBlock> = [
              ...(text ? [{ type: "text" as const, text }] : []),
              ...imageParts,
            ];
            if (promptParts.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }
            const turnId = ctx.activeTurnId ?? TurnId.make(yield* randomUUIDv4);
            if (ctx.activeTurnId === undefined) {
              ctx.activeTurnId = turnId;
              ctx.promptsInFlight = 0;
              ctx.lastPlanFingerprint = undefined;
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
              };
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: ctx.currentModelId ? { model: ctx.currentModelId } : {},
              });
            }
            ctx.promptsInFlight += 1;
            return { ctx, turnId, promptParts, acp: ctx.acp, sessionId: ctx.acpSessionId };
          }),
        );
        const result = yield* prepared.acp.prompt({ prompt: prepared.promptParts }).pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause),
          ),
          Effect.tapError((error) =>
            withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                const ctx = sessions.get(input.threadId);
                if (ctx?.acpSessionId === prepared.sessionId) {
                  yield* completeTurn(ctx, prepared.turnId, {
                    state: "failed",
                    errorMessage: error.message,
                  });
                }
              }),
            ),
          ),
        );
        yield* prepared.acp.drainEvents;
        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = sessions.get(input.threadId);
            if (!ctx || ctx.acpSessionId !== prepared.sessionId || ctx.stopped) return;
            if (ctx.interruptedTurnIds.has(prepared.turnId)) return;
            ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            appendPromptResult(ctx, prepared.turnId, prepared.promptParts, result);
            if (ctx.promptsInFlight === 0) {
              yield* completeTurn(ctx, prepared.turnId, {
                state: stopReasonState(result.stopReason),
                stopReason: result.stopReason,
                usage: result.usage ?? null,
              });
              ctx.interruptedTurnIds.delete(prepared.turnId);
            }
          }),
        );
        return {
          threadId: input.threadId,
          turnId: prepared.turnId,
          resumeCursor: prepared.ctx.session.resumeCursor,
        };
      });

    const interruptTurn = (threadId: ThreadId, turnId?: TurnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const activeTurnId = ctx.activeTurnId;
          if (turnId && activeTurnId && turnId !== activeTurnId) return;
          if (activeTurnId) ctx.interruptedTurnIds.add(activeTurnId);
          for (const pending of ctx.pendingApprovals.values()) {
            yield* Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore);
          }
          for (const pending of ctx.pendingUserInputs.values()) {
            yield* Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore);
          }
          yield* ctx.acp.cancel.pipe(Effect.ignore);
          if (activeTurnId) {
            yield* completeTurn(ctx, activeTurnId, {
              state: "cancelled",
              stopReason: "cancelled",
            });
          }
        }),
      );

    const respondToRequest = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: "Unknown pending approval request: " + requestId,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: "Unknown pending user-input request: " + requestId,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const stopSession = (threadId: ThreadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });
    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });
    const rollbackThread = (threadId: ThreadId, numTurns: number) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }
          if (
            ctx.activeTurnId !== undefined ||
            ctx.promptsInFlight > 0 ||
            ctx.pendingApprovals.size > 0 ||
            ctx.pendingUserInputs.size > 0
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "The Oh My Pi session must be idle before native rollback.",
            });
          }
          const cwd = ctx.session.cwd?.trim();
          if (!cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "The Oh My Pi session has no working directory to resume.",
            });
          }

          const previousSession = ctx.session;
          const previousResumeCursor = {
            schemaVersion: RESUME_SCHEMA_VERSION,
            sessionId: ctx.acpSessionId,
          };
          const restart = (resumeCursor: unknown) =>
            startSessionUnsafe({
              threadId,
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              cwd,
              runtimeMode: previousSession.runtimeMode,
              resumeCursor,
            }).pipe(Effect.exit);
          const recover = (method: string, detail: string, cause?: unknown) =>
            Effect.gen(function* () {
              const recoveryExit = yield* restart(previousResumeCursor);
              if (Exit.isFailure(recoveryExit)) {
                return yield* new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: `${detail} Recovery of the original Oh My Pi session also failed: ${detailFromUnknown(Cause.squash(recoveryExit.cause))}`,
                  cause: cause ?? Cause.squash(recoveryExit.cause),
                });
              }
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method,
                detail,
                ...(cause !== undefined ? { cause } : {}),
              });
            });

          yield* stopSessionInternal(ctx);
          const branchExit = yield* runOhMyPiNativeBranch({
            ohMyPiSettings,
            cwd,
            resumeSessionId: ctx.acpSessionId,
            environment: options?.environment ?? process.env,
            ...(options?.agentDir ? { agentDir: options.agentDir } : {}),
            childProcessSpawner,
            numTurns,
          }).pipe(Effect.timeoutOption("20 seconds"), Effect.exit);
          if (Exit.isFailure(branchExit)) {
            return yield* recover(
              "session/rollback",
              `Oh My Pi native rollback failed: ${detailFromUnknown(Cause.squash(branchExit.cause))}`,
              Cause.squash(branchExit.cause),
            );
          }
          if (Option.isNone(branchExit.value)) {
            return yield* recover(
              "session/rollback",
              "Oh My Pi native rollback timed out after 20 seconds.",
            );
          }

          const branched = branchExit.value.value;
          const restartedExit = yield* restart({
            schemaVersion: RESUME_SCHEMA_VERSION,
            sessionId: branched.sessionId,
          });
          if (Exit.isFailure(restartedExit)) {
            return yield* recover(
              "session/rollback",
              `Oh My Pi created a native branch but ACP could not resume it: ${detailFromUnknown(Cause.squash(restartedExit.cause))}`,
              Cause.squash(restartedExit.cause),
            );
          }
          const session = restartedExit.value;
          const nextContext = sessions.get(threadId);
          if (nextContext) {
            nextContext.turns = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
          }
          return {
            threadId,
            turns: nextContext?.turns ?? [],
            session,
          };
        }),
      );
    const stopAll = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
