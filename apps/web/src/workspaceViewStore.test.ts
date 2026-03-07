import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { getPersistStorage } from "./persistStorage";
import {
  MAX_WORKSPACE_PANES,
  countWorkspacePanes,
  createDefaultWorkspaceLayout,
  findFirstWorkspacePane,
  splitWorkspacePane,
  useWorkspaceViewStore,
  type WorkspaceLayoutNode,
} from "./workspaceViewStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const SECOND_THREAD_ID = ThreadId.makeUnsafe("thread-2");

describe("workspaceViewStore", () => {
  beforeEach(() => {
    getPersistStorage().clear();
    useWorkspaceViewStore.getState().setMode("single");
    useWorkspaceViewStore.getState().resetSplitLayout(null);
  });

  it("syncs the current route thread into the active pane", () => {
    const store = useWorkspaceViewStore.getState();

    store.setMode("split");
    store.syncRouteThread(THREAD_ID);

    const next = useWorkspaceViewStore.getState();
    const pane = findFirstWorkspacePane(next.splitLayout);

    expect(next.activePaneId).toBe(pane.paneId);
    expect(pane.threadId).toBe(THREAD_ID);
  });

  it("caps pane splitting at the configured maximum", () => {
    let layout: WorkspaceLayoutNode = createDefaultWorkspaceLayout(THREAD_ID);
    let currentPaneId = layout.paneId;

    for (let index = 1; index < MAX_WORKSPACE_PANES; index += 1) {
      const result = splitWorkspacePane(layout, currentPaneId, "row");
      layout = result.layout;
      currentPaneId = result.createdPaneId ?? currentPaneId;
    }

    expect(countWorkspacePanes(layout)).toBe(MAX_WORKSPACE_PANES);

    useWorkspaceViewStore.getState().resetSplitLayout(THREAD_ID);
    useWorkspaceViewStore.getState().setMode("split");
    for (let index = 1; index < MAX_WORKSPACE_PANES; index += 1) {
      const paneId = findFirstWorkspacePane(useWorkspaceViewStore.getState().splitLayout).paneId;
      useWorkspaceViewStore.getState().splitPane(paneId, "row");
    }

    const paneId = findFirstWorkspacePane(useWorkspaceViewStore.getState().splitLayout).paneId;
    expect(useWorkspaceViewStore.getState().splitPane(paneId, "row")).toBeNull();
  });

  it("promotes a sibling pane when closing the active pane", () => {
    const store = useWorkspaceViewStore.getState();
    store.setMode("split");
    store.syncRouteThread(THREAD_ID);

    const initialPaneId = findFirstWorkspacePane(useWorkspaceViewStore.getState().splitLayout).paneId;
    const secondPaneId = store.splitPane(initialPaneId, "row");
    expect(secondPaneId).toBeTruthy();

    if (secondPaneId) {
      store.assignPaneThread(secondPaneId, SECOND_THREAD_ID);
      store.setActivePane(secondPaneId);
      const result = store.closePane(secondPaneId);
      expect(result.nextThreadId).toBe(THREAD_ID);
      expect(useWorkspaceViewStore.getState().activePaneId).toBe(initialPaneId);
    }
  });
});
