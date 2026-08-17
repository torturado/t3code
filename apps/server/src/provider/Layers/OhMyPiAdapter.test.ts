// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  OhMyPiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeOhMyPiAdapter } from "./OhMyPiAdapter.ts";

const decodeOhMyPiSettings = Schema.decodeSync(OhMyPiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const ohMyPiDriver = ProviderDriverKind.make("ohMyPi");
const ohMyPiInstance = ProviderInstanceId.make("ohMyPi");

async function makeMockOhMyPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oh-my-pi-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const ohMyPiTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-oh-my-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, extraEnv?: Record<string, string>) =>
  makeOhMyPiAdapter(decodeOhMyPiSettings({ binaryPath }), {
    instanceId: ohMyPiInstance,
    ...(extraEnv ? { environment: { ...process.env, ...extraEnv } } : {}),
  }).pipe(Effect.orDie);

it.layer(ohMyPiTestLayer)("OhMyPiAdapter", (it) => {
  it.effect("maps ACP streaming into canonical T3 runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("oh-my-pi-streaming-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockOhMyPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ohMyPiDriver,
        providerInstanceId: ohMyPiInstance,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, ohMyPiDriver);
      assert.equal(session.model, "grok-build");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello omp", attachments: [] });
      yield* Deferred.await(turnCompleted);

      const eventTypes = runtimeEvents.map((event) => event.type);
      assert.includeMembers(eventTypes, [
        "session.started",
        "session.state.changed",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const);
      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("routes non-full-access permission requests through T3", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("oh-my-pi-permission-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOhMyPiWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "request.opened"
              ? Deferred.succeed(requestOpened, event)
              : event.type === "turn.completed"
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ohMyPiDriver,
        providerInstanceId: ohMyPiInstance,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "check permission", attachments: [] })
        .pipe(Effect.forkChild);
      const request = yield* Deferred.await(requestOpened);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(request.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(turnCompleted);

      assert.isTrue(runtimeEvents.some((event) => event.type === "request.resolved"));
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
