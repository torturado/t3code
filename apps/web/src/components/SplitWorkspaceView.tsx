import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Columns2Icon, Rows3Icon, XIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { useStore } from "~/store";
import {
  MAX_WORKSPACE_PANES,
  findWorkspacePane,
  type WorkspaceLayoutNode,
  type WorkspacePaneNode,
  useWorkspaceViewStore,
} from "~/workspaceViewStore";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "~/lib/utils";
import ChatView from "./ChatView";

interface SplitWorkspaceViewProps {
  routeThreadId: ThreadId;
}

function PaneEmptyState(props: { paneId: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
      Select a thread to open it in pane <code>{props.paneId}</code>.
    </div>
  );
}

export default function SplitWorkspaceView({ routeThreadId }: SplitWorkspaceViewProps) {
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const mode = useWorkspaceViewStore((store) => store.mode);
  const splitLayout = useWorkspaceViewStore((store) => store.splitLayout);
  const activePaneId = useWorkspaceViewStore((store) => store.activePaneId);
  const setActivePane = useWorkspaceViewStore((store) => store.setActivePane);
  const syncRouteThread = useWorkspaceViewStore((store) => store.syncRouteThread);
  const assignPaneThread = useWorkspaceViewStore((store) => store.assignPaneThread);
  const splitPane = useWorkspaceViewStore((store) => store.splitPane);
  const closePane = useWorkspaceViewStore((store) => store.closePane);

  useEffect(() => {
    if (mode !== "split") {
      return;
    }
    syncRouteThread(routeThreadId);
  }, [mode, routeThreadId, syncRouteThread]);

  const sortedThreads = useMemo(
    () =>
      threads.toSorted((left, right) => {
        const byDate = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        if (byDate !== 0) {
          return byDate;
        }
        return right.id.localeCompare(left.id);
      }),
    [threads],
  );

  const paneCount = useMemo(() => {
    let count = 0;
    const walk = (node: WorkspaceLayoutNode) => {
      if (node.type === "pane") {
        count += 1;
        return;
      }
      walk(node.children[0]);
      walk(node.children[1]);
    };
    walk(splitLayout);
    return count;
  }, [splitLayout]);

  const renderPane = (node: WorkspacePaneNode) => {
    const isActive = node.paneId === activePaneId;
    const thread = node.threadId ? threads.find((entry) => entry.id === node.threadId) : null;
    const canSplit = paneCount < MAX_WORKSPACE_PANES;

    return (
      <section
        key={node.paneId}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border bg-background",
          isActive && "ring-1 ring-primary/40",
        )}
        onPointerDownCapture={() => {
          if (!isActive) {
            setActivePane(node.paneId);
            if (node.threadId) {
              void navigate({
                to: "/$threadId",
                params: { threadId: node.threadId },
              });
            }
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <select
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-xs"
            value={node.threadId ?? ""}
            onChange={(event) => {
              const nextThreadId = event.target.value.length > 0 ? (event.target.value as ThreadId) : null;
              assignPaneThread(node.paneId, nextThreadId);
              setActivePane(node.paneId);
              if (nextThreadId) {
                void navigate({
                  to: "/$threadId",
                  params: { threadId: nextThreadId },
                });
              }
            }}
          >
            <option value="">Select thread...</option>
            {sortedThreads.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
          {thread?.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            disabled={!canSplit}
            aria-label="Split horizontally"
            title={canSplit ? "Split horizontally" : `Maximum ${MAX_WORKSPACE_PANES} panes`}
            onClick={() => {
              splitPane(node.paneId, "row");
            }}
          >
            <Columns2Icon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            disabled={!canSplit}
            aria-label="Split vertically"
            title={canSplit ? "Split vertically" : `Maximum ${MAX_WORKSPACE_PANES} panes`}
            onClick={() => {
              splitPane(node.paneId, "column");
            }}
          >
            <Rows3Icon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            disabled={paneCount <= 1}
            aria-label="Close pane"
            title="Close pane"
            onClick={() => {
              const result = closePane(node.paneId);
              if (result.nextThreadId) {
                void navigate({
                  to: "/$threadId",
                  params: { threadId: result.nextThreadId },
                  replace: true,
                });
              }
            }}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {thread ? (
            <ChatView
              key={`${node.paneId}:${thread.id}`}
              threadId={thread.id}
              embedded
              isActiveWorkspacePane={isActive}
              onActivatePane={() => {
                if (activePaneId !== node.paneId) {
                  setActivePane(node.paneId);
                  void navigate({
                    to: "/$threadId",
                    params: { threadId: thread.id },
                  });
                }
              }}
            />
          ) : (
            <PaneEmptyState paneId={node.paneId} />
          )}
        </div>
      </section>
    );
  };

  const renderLayout = (node: WorkspaceLayoutNode): React.ReactNode => {
    if (node.type === "pane") {
      return renderPane(node);
    }
    return (
      <div
        key={node.splitId}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 gap-3",
          node.direction === "column" ? "flex-col" : "flex-row",
        )}
      >
        {renderLayout(node.children[0])}
        {renderLayout(node.children[1])}
      </div>
    );
  };

  const activePane = findWorkspacePane(splitLayout, activePaneId);

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Split workspace</h1>
            <p className="text-xs text-muted-foreground">
              Work across parallel threads with one active pane handling global keyboard input.
            </p>
          </div>
          <Badge variant="outline">
            {paneCount}/{MAX_WORKSPACE_PANES} panes
          </Badge>
        </div>
        {activePane ? (
          <p className="mt-2 text-[11px] text-muted-foreground">Active pane: {activePane.paneId}</p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">{renderLayout(splitLayout)}</div>
    </div>
  );
}
