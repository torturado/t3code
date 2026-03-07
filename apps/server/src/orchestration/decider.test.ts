import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeReadModel() {
  return {
    ...createEmptyReadModel("2026-02-24T00:00:00.000Z"),
    projects: [
      {
        id: PROJECT_ID,
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModel: "gpt-5-codex",
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread 1",
        model: "gpt-5-codex",
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
        deletedAt: null,
        archivedAt: null,
        boardColumn: "inbox" as const,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: null,
      },
    ],
  };
}

describe("decideOrchestrationCommand", () => {
  it("emits thread.archived and thread.restored events", async () => {
    const readModel = makeReadModel();

    const archived = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-archive"),
          threadId: THREAD_ID,
          createdAt: "2026-02-24T00:01:00.000Z",
        },
      }),
    );

    const restored = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.restore",
          commandId: CommandId.makeUnsafe("cmd-restore"),
          threadId: THREAD_ID,
          createdAt: "2026-02-24T00:02:00.000Z",
        },
      }),
    );

    expect(archived).toMatchObject({
      type: "thread.archived",
      payload: {
        threadId: THREAD_ID,
        archivedAt: "2026-02-24T00:01:00.000Z",
      },
    });
    expect(restored).toMatchObject({
      type: "thread.restored",
      payload: {
        threadId: THREAD_ID,
        archivedAt: null,
        updatedAt: "2026-02-24T00:02:00.000Z",
      },
    });
  });

  it("emits thread.board-column-set events", async () => {
    const readModel = makeReadModel();

    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.board-column.set",
          commandId: CommandId.makeUnsafe("cmd-board-column"),
          threadId: THREAD_ID,
          boardColumn: "waiting",
          createdAt: "2026-02-24T00:03:00.000Z",
        },
      }),
    );

    expect(event).toMatchObject({
      type: "thread.board-column-set",
      payload: {
        threadId: THREAD_ID,
        boardColumn: "waiting",
        updatedAt: "2026-02-24T00:03:00.000Z",
      },
    });
  });
});
