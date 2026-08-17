import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { buildOhMyPiRpcControlSpawnInput, type OhMyPiAcpRuntimeInput } from "./OhMyPiAcpSupport.ts";

const MAX_RPC_FRAME_BYTES = 1024 * 1024;
const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

class OhMyPiRpcDecodeError extends Schema.TaggedErrorClass<OhMyPiRpcDecodeError>()(
  "OhMyPiRpcDecodeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

interface RpcChunkFrame {
  readonly type: "rpc_chunk";
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  readonly data: string;
}

interface PendingRpcChunks {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  readonly nextIndex: number;
  readonly chunks: ReadonlyArray<Buffer>;
  readonly receivedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcChunkFrame(value: unknown): value is RpcChunkFrame {
  return isRecord(value) && value.type === "rpc_chunk";
}

function decodeBase64(data: unknown): Buffer {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    throw new Error("Invalid Oh My Pi RPC chunk data.");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) {
    throw new Error("Invalid Oh My Pi RPC chunk data.");
  }
  return bytes;
}

/** Validates and reassembles the lossless RPC v2 transport one JSONL frame at a time. */
export class OhMyPiRpcFrameDecoder {
  private pending: PendingRpcChunks | undefined;

  push(value: unknown): Record<string, unknown> | undefined {
    if (!isRpcChunkFrame(value)) {
      if (this.pending) {
        throw new Error("Oh My Pi RPC chunk sequence was interrupted.");
      }
      if (!isRecord(value)) {
        throw new Error("Oh My Pi RPC frame must be an object.");
      }
      return value;
    }

    if (
      typeof value.chunkId !== "string" ||
      value.chunkId.length === 0 ||
      value.chunkId.length > 128 ||
      !Number.isSafeInteger(value.index) ||
      !Number.isSafeInteger(value.count) ||
      !Number.isSafeInteger(value.byteLength) ||
      value.index < 0 ||
      value.count < 2 ||
      value.count > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
      value.index >= value.count ||
      value.byteLength <= 0 ||
      value.byteLength > MAX_RPC_REASSEMBLED_BYTES
    ) {
      throw new Error("Invalid Oh My Pi RPC chunk metadata.");
    }

    const bytes = decodeBase64(value.data);
    if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new Error("Oh My Pi RPC chunk exceeds the transport limit.");
    }

    const pending = this.pending;
    if (!pending) {
      if (value.index !== 0) {
        throw new Error("Oh My Pi RPC chunk sequence must start at index 0.");
      }
      this.pending = {
        chunkId: value.chunkId,
        count: value.count,
        byteLength: value.byteLength,
        nextIndex: 1,
        chunks: [bytes],
        receivedBytes: bytes.byteLength,
      };
      return undefined;
    }

    if (
      pending.chunkId !== value.chunkId ||
      pending.count !== value.count ||
      pending.byteLength !== value.byteLength ||
      pending.nextIndex !== value.index
    ) {
      throw new Error("Oh My Pi RPC chunk sequence mismatch.");
    }

    const receivedBytes = pending.receivedBytes + bytes.byteLength;
    if (receivedBytes > pending.byteLength) {
      throw new Error("Oh My Pi RPC chunk sequence exceeds its declared length.");
    }

    const chunks = [...pending.chunks, bytes];
    const nextIndex = pending.nextIndex + 1;
    if (nextIndex < pending.count) {
      this.pending = { ...pending, chunks, nextIndex, receivedBytes };
      return undefined;
    }
    if (receivedBytes !== pending.byteLength) {
      throw new Error("Oh My Pi RPC chunk sequence length mismatch.");
    }

    this.pending = undefined;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const frame: unknown = decodeJson(decoded);
    if (!isRecord(frame)) {
      throw new Error("Reassembled Oh My Pi RPC frame must be an object.");
    }
    return frame;
  }
}

type RpcControlQueueValue =
  | { readonly _tag: "frame"; readonly value: Record<string, unknown> }
  | { readonly _tag: "error"; readonly detail: string }
  | { readonly _tag: "exit"; readonly code: number };

export interface OhMyPiNativeBranchInput {
  readonly ohMyPiSettings: OhMyPiAcpRuntimeInput["ohMyPiSettings"];
  readonly cwd: string;
  readonly resumeSessionId: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly agentDir?: string;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly numTurns: number;
}

export interface OhMyPiNativeBranchResult {
  readonly sessionId: string;
  readonly selectedEntryId: string;
  readonly availableEntryCount: number;
}

function detailFromUnknown(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function responseData(frame: Record<string, unknown>, command: string): Record<string, unknown> {
  if (frame.type !== "response" || frame.command !== command || frame.success !== true) {
    const detail = typeof frame.error === "string" ? frame.error : "Unknown RPC command failure.";
    throw new Error(`Oh My Pi RPC ${command} failed: ${detail}`);
  }
  return isRecord(frame.data) ? frame.data : {};
}

export function selectOhMyPiNativeBranchEntry(
  branchMessages: ReadonlyArray<{ readonly entryId: string; readonly text: string }>,
  numTurns: number,
): string {
  if (!Number.isInteger(numTurns) || numTurns < 1) {
    throw new Error("Oh My Pi native rollback requires at least one turn.");
  }
  if (numTurns > branchMessages.length) {
    throw new Error(
      `Cannot roll back ${numTurns} turns; Oh My Pi exposes only ${branchMessages.length} branchable user entries.`,
    );
  }
  return branchMessages[Math.max(0, branchMessages.length - numTurns)]!.entryId;
}

export function runOhMyPiNativeBranch(input: OhMyPiNativeBranchInput) {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawnInput = buildOhMyPiRpcControlSpawnInput(
        input.ohMyPiSettings,
        input.cwd,
        input.resumeSessionId,
        input.environment,
        input.agentDir,
      );
      const spawnCommand = yield* resolveSpawnCommand(spawnInput.command, spawnInput.args, {
        env: spawnInput.env ?? process.env,
      });
      const child = yield* input.childProcessSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: spawnInput.cwd,
          env: spawnInput.env,
          shell: spawnCommand.shell,
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

      const outputQueue = yield* Queue.unbounded<RpcControlQueueValue>();
      const inputQueue = yield* Queue.unbounded<Uint8Array>();
      const decoder = new OhMyPiRpcFrameDecoder();
      const stderrRef = yield* Ref.make("");
      const textEncoder = new TextEncoder();

      yield* Stream.fromQueue(inputQueue).pipe(Stream.run(child.stdin), Effect.forkScoped);
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (current) => current + chunk)),
        Effect.forkScoped,
      );
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.gen(function* () {
            const trimmed = line.trim();
            if (!trimmed) return;
            if (Buffer.byteLength(trimmed, "utf8") > MAX_RPC_FRAME_BYTES) {
              return yield* new OhMyPiRpcDecodeError({
                detail: "Oh My Pi RPC frame exceeds the 1 MiB physical limit.",
              });
            }
            const frame = yield* Effect.try({
              try: () => decoder.push(decodeJson(trimmed)),
              catch: (cause) =>
                new OhMyPiRpcDecodeError({
                  detail: detailFromUnknown(cause),
                  cause,
                }),
            });
            if (frame) {
              yield* Queue.offer(outputQueue, { _tag: "frame", value: frame });
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Queue.offer(outputQueue, { _tag: "error", detail: detailFromUnknown(cause) }).pipe(
            Effect.ignore,
          ),
        ),
        Effect.forkScoped,
      );
      yield* child.exitCode.pipe(
        Effect.flatMap((code) => Queue.offer(outputQueue, { _tag: "exit", code: Number(code) })),
        Effect.catchCause((cause) =>
          Queue.offer(outputQueue, { _tag: "error", detail: detailFromUnknown(cause) }).pipe(
            Effect.ignore,
          ),
        ),
        Effect.forkScoped,
      );

      const takeFrame = Effect.gen(function* () {
        const value = yield* Queue.take(outputQueue);
        if (value._tag === "frame") return value.value;
        if (value._tag === "exit") {
          const stderr = (yield* Ref.get(stderrRef)).trim();
          throw new Error(
            `Oh My Pi RPC process exited before completing the control operation (code ${value.code}).${
              stderr ? `\n${stderr}` : ""
            }`,
          );
        }
        throw new Error(value.detail);
      });

      const send = (command: Record<string, unknown>) =>
        Queue.offer(inputQueue, textEncoder.encode(JSON.stringify(command) + "\n"));

      const awaitResponse = (id: string, command: string) =>
        Effect.gen(function* () {
          while (true) {
            const frame = yield* takeFrame;
            if (frame.type === "response" && frame.id === id) {
              return responseData(frame, command);
            }
          }
        });

      const ready = yield* takeFrame;
      if (
        ready.type !== "ready" ||
        !Array.isArray(ready.supportedProtocolVersions) ||
        !ready.supportedProtocolVersions.includes(2)
      ) {
        throw new Error("Oh My Pi RPC control requires protocol v2 support.");
      }

      yield* send({ id: "t3-rpc-protocol", type: "negotiate_protocol", protocolVersion: 2 });
      yield* awaitResponse("t3-rpc-protocol", "negotiate_protocol");

      yield* send({ id: "t3-rpc-branch-messages", type: "get_branch_messages" });
      const branchData = yield* awaitResponse("t3-rpc-branch-messages", "get_branch_messages");
      if (!Array.isArray(branchData.messages)) {
        throw new Error("Oh My Pi RPC did not return branchable user entries.");
      }
      const branchMessages = branchData.messages.map((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.entryId !== "string" ||
          typeof entry.text !== "string" ||
          !entry.entryId.trim()
        ) {
          throw new Error("Oh My Pi RPC returned a malformed branchable user entry.");
        }
        return { entryId: entry.entryId.trim(), text: entry.text };
      });
      if (branchMessages.length === 0) {
        throw new Error("Oh My Pi has no user entries available for native rollback.");
      }
      const selectedEntryId = selectOhMyPiNativeBranchEntry(branchMessages, input.numTurns);
      yield* send({ id: "t3-rpc-branch", type: "branch", entryId: selectedEntryId });
      const branchResult = yield* awaitResponse("t3-rpc-branch", "branch");
      if (branchResult.cancelled === true) {
        throw new Error("Oh My Pi cancelled the native branch operation.");
      }

      yield* send({ id: "t3-rpc-state", type: "get_state" });
      const state = yield* awaitResponse("t3-rpc-state", "get_state");
      if (typeof state.sessionId !== "string" || !state.sessionId.trim()) {
        throw new Error("Oh My Pi RPC did not return the branched session id.");
      }

      return {
        sessionId: state.sessionId.trim(),
        selectedEntryId,
        availableEntryCount: branchMessages.length,
      };
    }),
  );
}
