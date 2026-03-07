import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getPersistStorage } from "./persistStorage";

export type WorkspaceViewMode = "single" | "kanban" | "split";
export type WorkspaceSplitDirection = "row" | "column";

export interface WorkspacePaneNode {
  type: "pane";
  paneId: string;
  threadId: ThreadId | null;
}

export interface WorkspaceSplitNode {
  type: "split";
  splitId: string;
  direction: WorkspaceSplitDirection;
  children: [WorkspaceLayoutNode, WorkspaceLayoutNode];
}

export type WorkspaceLayoutNode = WorkspacePaneNode | WorkspaceSplitNode;

interface WorkspaceViewState {
  mode: WorkspaceViewMode;
  splitLayout: WorkspaceLayoutNode;
  activePaneId: string | null;
  setMode: (mode: WorkspaceViewMode) => void;
  setActivePane: (paneId: string) => void;
  syncRouteThread: (threadId: ThreadId) => void;
  assignPaneThread: (paneId: string, threadId: ThreadId | null) => void;
  splitPane: (paneId: string, direction: WorkspaceSplitDirection) => string | null;
  closePane: (paneId: string) => { nextActivePaneId: string | null; nextThreadId: ThreadId | null };
  resetSplitLayout: (threadId: ThreadId | null) => void;
}

const WORKSPACE_VIEW_STORAGE_KEY = "t3code:workspace-view:v1";
const MAX_WORKSPACE_PANES = 6;

function createPaneId(): string {
  return `pane-${crypto.randomUUID()}`;
}

function createSplitId(): string {
  return `split-${crypto.randomUUID()}`;
}

function createPaneNode(threadId: ThreadId | null): WorkspacePaneNode {
  return {
    type: "pane",
    paneId: createPaneId(),
    threadId,
  };
}

export function createDefaultWorkspaceLayout(threadId: ThreadId | null): WorkspacePaneNode {
  return createPaneNode(threadId);
}

export function countWorkspacePanes(node: WorkspaceLayoutNode): number {
  if (node.type === "pane") {
    return 1;
  }
  return node.children.reduce((total, child) => total + countWorkspacePanes(child), 0);
}

export function findWorkspacePane(
  node: WorkspaceLayoutNode,
  paneId: string | null,
): WorkspacePaneNode | null {
  if (!paneId) {
    return null;
  }
  if (node.type === "pane") {
    return node.paneId === paneId ? node : null;
  }
  return findWorkspacePane(node.children[0], paneId) ?? findWorkspacePane(node.children[1], paneId);
}

export function findFirstWorkspacePane(node: WorkspaceLayoutNode): WorkspacePaneNode {
  if (node.type === "pane") {
    return node;
  }
  return findFirstWorkspacePane(node.children[0]);
}

export function updateWorkspacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
  updater: (pane: WorkspacePaneNode) => WorkspacePaneNode,
): WorkspaceLayoutNode {
  if (node.type === "pane") {
    return node.paneId === paneId ? updater(node) : node;
  }

  const nextLeft = updateWorkspacePane(node.children[0], paneId, updater);
  const nextRight = updateWorkspacePane(node.children[1], paneId, updater);
  if (nextLeft === node.children[0] && nextRight === node.children[1]) {
    return node;
  }
  return {
    ...node,
    children: [nextLeft, nextRight],
  };
}

export function splitWorkspacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
  direction: WorkspaceSplitDirection,
): { layout: WorkspaceLayoutNode; createdPaneId: string | null } {
  if (node.type === "pane") {
    if (node.paneId !== paneId) {
      return { layout: node, createdPaneId: null };
    }
    const nextPane = createPaneNode(null);
    return {
      layout: {
        type: "split",
        splitId: createSplitId(),
        direction,
        children: [node, nextPane],
      },
      createdPaneId: nextPane.paneId,
    };
  }

  const nextLeft = splitWorkspacePane(node.children[0], paneId, direction);
  if (nextLeft.createdPaneId) {
    return {
      layout: {
        ...node,
        children: [nextLeft.layout, node.children[1]],
      },
      createdPaneId: nextLeft.createdPaneId,
    };
  }

  const nextRight = splitWorkspacePane(node.children[1], paneId, direction);
  if (nextRight.createdPaneId) {
    return {
      layout: {
        ...node,
        children: [node.children[0], nextRight.layout],
      },
      createdPaneId: nextRight.createdPaneId,
    };
  }

  return { layout: node, createdPaneId: null };
}

export function closeWorkspacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
): { layout: WorkspaceLayoutNode; removed: boolean; fallbackPaneId: string | null } {
  if (node.type === "pane") {
    return {
      layout: node,
      removed: node.paneId === paneId,
      fallbackPaneId: null,
    };
  }

  const leftChild = node.children[0];
  const rightChild = node.children[1];

  if (leftChild.type === "pane" && leftChild.paneId === paneId) {
    const fallbackPane = findFirstWorkspacePane(rightChild);
    return {
      layout: rightChild,
      removed: true,
      fallbackPaneId: fallbackPane.paneId,
    };
  }

  if (rightChild.type === "pane" && rightChild.paneId === paneId) {
    const fallbackPane = findFirstWorkspacePane(leftChild);
    return {
      layout: leftChild,
      removed: true,
      fallbackPaneId: fallbackPane.paneId,
    };
  }

  const nextLeft = closeWorkspacePane(leftChild, paneId);
  if (nextLeft.removed) {
    return {
      layout: {
        ...node,
        children: [nextLeft.layout, rightChild],
      },
      removed: true,
      fallbackPaneId: nextLeft.fallbackPaneId,
    };
  }

  const nextRight = closeWorkspacePane(rightChild, paneId);
  if (nextRight.removed) {
    return {
      layout: {
        ...node,
        children: [leftChild, nextRight.layout],
      },
      removed: true,
      fallbackPaneId: nextRight.fallbackPaneId,
    };
  }

  return {
    layout: node,
    removed: false,
    fallbackPaneId: null,
  };
}

function normalizeStoredLayout(node: WorkspaceLayoutNode | null | undefined): WorkspaceLayoutNode {
  if (!node) {
    return createDefaultWorkspaceLayout(null);
  }

  if (node.type === "pane") {
    return {
      type: "pane",
      paneId: typeof node.paneId === "string" && node.paneId.length > 0 ? node.paneId : createPaneId(),
      threadId: node.threadId ?? null,
    };
  }

  const left = normalizeStoredLayout(node.children?.[0]);
  const right = normalizeStoredLayout(node.children?.[1]);
  return {
    type: "split",
    splitId:
      typeof node.splitId === "string" && node.splitId.length > 0 ? node.splitId : createSplitId(),
    direction: node.direction === "column" ? "column" : "row",
    children: [left, right],
  };
}

export const useWorkspaceViewStore = create<WorkspaceViewState>()(
  persist(
    (set, get) => ({
      mode: "single",
      splitLayout: createDefaultWorkspaceLayout(null),
      activePaneId: null,
      setMode: (mode) => {
        set((state) => {
          if (state.mode === mode) {
            return state;
          }
          const firstPane = findFirstWorkspacePane(state.splitLayout);
          return {
            mode,
            activePaneId: state.activePaneId ?? firstPane.paneId,
          };
        });
      },
      setActivePane: (paneId) => {
        set((state) => {
          if (!findWorkspacePane(state.splitLayout, paneId) || state.activePaneId === paneId) {
            return state;
          }
          return { activePaneId: paneId };
        });
      },
      syncRouteThread: (threadId) => {
        set((state) => {
          const currentPane =
            findWorkspacePane(state.splitLayout, state.activePaneId) ??
            findFirstWorkspacePane(state.splitLayout);
          if (currentPane.threadId === threadId && state.activePaneId === currentPane.paneId) {
            return state;
          }
          return {
            activePaneId: currentPane.paneId,
            splitLayout: updateWorkspacePane(state.splitLayout, currentPane.paneId, (pane) => ({
              ...pane,
              threadId,
            })),
          };
        });
      },
      assignPaneThread: (paneId, threadId) => {
        set((state) => {
          const currentPane = findWorkspacePane(state.splitLayout, paneId);
          if (!currentPane || currentPane.threadId === threadId) {
            return state;
          }
          return {
            splitLayout: updateWorkspacePane(state.splitLayout, paneId, (pane) => ({
              ...pane,
              threadId,
            })),
          };
        });
      },
      splitPane: (paneId, direction) => {
        const state = get();
        if (countWorkspacePanes(state.splitLayout) >= MAX_WORKSPACE_PANES) {
          return null;
        }
        const result = splitWorkspacePane(state.splitLayout, paneId, direction);
        if (!result.createdPaneId) {
          return null;
        }
        set({
          splitLayout: result.layout,
          activePaneId: state.activePaneId ?? paneId,
        });
        return result.createdPaneId;
      },
      closePane: (paneId) => {
        const state = get();
        if (countWorkspacePanes(state.splitLayout) <= 1) {
          const existingPane = findWorkspacePane(state.splitLayout, paneId) ?? findFirstWorkspacePane(state.splitLayout);
          return {
            nextActivePaneId: existingPane.paneId,
            nextThreadId: existingPane.threadId,
          };
        }
        const result = closeWorkspacePane(state.splitLayout, paneId);
        if (!result.removed) {
          const existingPane =
            findWorkspacePane(state.splitLayout, state.activePaneId) ?? findFirstWorkspacePane(state.splitLayout);
          return {
            nextActivePaneId: existingPane.paneId,
            nextThreadId: existingPane.threadId,
          };
        }
        const nextActivePane =
          findWorkspacePane(result.layout, state.activePaneId === paneId ? result.fallbackPaneId : state.activePaneId) ??
          findFirstWorkspacePane(result.layout);
        set({
          splitLayout: result.layout,
          activePaneId: nextActivePane.paneId,
        });
        return {
          nextActivePaneId: nextActivePane.paneId,
          nextThreadId: nextActivePane.threadId,
        };
      },
      resetSplitLayout: (threadId) => {
        const nextLayout = createDefaultWorkspaceLayout(threadId);
        set({
          splitLayout: nextLayout,
          activePaneId: nextLayout.paneId,
        });
      },
    }),
    {
      name: WORKSPACE_VIEW_STORAGE_KEY,
      storage: createJSONStorage(getPersistStorage),
      partialize: (state) => ({
        mode: state.mode,
        splitLayout: state.splitLayout,
        activePaneId: state.activePaneId,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<WorkspaceViewState> | undefined;
        const splitLayout = normalizeStoredLayout(persisted?.splitLayout);
        const firstPane = findFirstWorkspacePane(splitLayout);
        return {
          ...currentState,
          mode: persisted?.mode ?? currentState.mode,
          splitLayout,
          activePaneId:
            findWorkspacePane(splitLayout, persisted?.activePaneId ?? null)?.paneId ?? firstPane.paneId,
        };
      },
    },
  ),
);

export { MAX_WORKSPACE_PANES };
