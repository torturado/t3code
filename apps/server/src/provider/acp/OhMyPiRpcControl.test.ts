import { describe, expect, it } from "vite-plus/test";

import { OhMyPiRpcFrameDecoder, selectOhMyPiNativeBranchEntry } from "./OhMyPiRpcControl.ts";

describe("OhMyPiRpcFrameDecoder", () => {
  it("reassembles a valid v2 chunk sequence", () => {
    const frame = { type: "response", id: "1", data: { sessionId: "session-2" } };
    const bytes = Buffer.from(JSON.stringify(frame), "utf8");
    const splitAt = Math.ceil(bytes.byteLength / 2);
    const decoder = new OhMyPiRpcFrameDecoder();
    const chunk = (index: number, data: Uint8Array) => ({
      type: "rpc_chunk" as const,
      chunkId: "chunk-1",
      index,
      count: 2,
      byteLength: bytes.byteLength,
      data: Buffer.from(data).toString("base64"),
    });

    expect(decoder.push(chunk(0, bytes.subarray(0, splitAt)))).toBeUndefined();
    expect(decoder.push(chunk(1, bytes.subarray(splitAt)))).toEqual(frame);
  });

  it("rejects a chunk stream interrupted by another frame", () => {
    const decoder = new OhMyPiRpcFrameDecoder();
    expect(() =>
      decoder.push({
        type: "rpc_chunk",
        chunkId: "chunk-1",
        index: 0,
        count: 2,
        byteLength: 2,
        data: Buffer.from("{").toString("base64"),
      }),
    ).not.toThrow();
    expect(() => decoder.push({ type: "ready" })).toThrow(
      "Oh My Pi RPC chunk sequence was interrupted.",
    );
  });

  it("selects the user entry immediately before the turns being reverted", () => {
    const messages = [
      { entryId: "user-1", text: "one" },
      { entryId: "user-2", text: "two" },
      { entryId: "user-3", text: "three" },
    ];

    expect(selectOhMyPiNativeBranchEntry(messages, 1)).toBe("user-3");
    expect(selectOhMyPiNativeBranchEntry(messages, 2)).toBe("user-2");
    expect(selectOhMyPiNativeBranchEntry(messages, 3)).toBe("user-1");
  });
});
