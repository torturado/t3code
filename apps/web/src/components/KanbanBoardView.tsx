import type { ThreadBoardColumn, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { ArchiveIcon, Trash2Icon } from "lucide-react";

import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { newCommandId } from "~/lib/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "~/lib/utils";

const BOARD_COLUMNS: ReadonlyArray<{ id: ThreadBoardColumn; label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "active", label: "Active" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
];

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diffMs)) {
    return "";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function threadStatusLabel(status: string | null | undefined): string {
  if (status === "running") return "Running";
  if (status === "connecting") return "Connecting";
  if (status === "error") return "Error";
  if (status === "closed") return "Closed";
  return "Ready";
}

export default function KanbanBoardView(props: { activeThreadId: ThreadId }) {
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const [draggingThreadId, setDraggingThreadId] = useState<ThreadId | null>(null);

  const visibleThreads = useMemo(
    () => threads.filter((thread) => thread.archivedAt === null),
    [threads],
  );
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const groupedThreads = useMemo(() => {
    const groups = new Map<ThreadBoardColumn, typeof visibleThreads>([
      ["inbox", []],
      ["active", []],
      ["waiting", []],
      ["done", []],
    ]);
    for (const thread of visibleThreads) {
      groups.get(thread.boardColumn)?.push(thread);
    }
    for (const [columnId, columnThreads] of groups) {
      groups.set(
        columnId,
        columnThreads.toSorted(
          (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
        ),
      );
    }
    return groups;
  }, [visibleThreads]);

  const moveThreadToColumn = useCallback(async (threadId: ThreadId, boardColumn: ThreadBoardColumn) => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    await api.orchestration.dispatchCommand({
      type: "thread.board-column.set",
      commandId: newCommandId(),
      threadId,
      boardColumn,
      createdAt: new Date().toISOString(),
    });
  }, []);

  const archiveThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    await api.orchestration.dispatchCommand({
      type: "thread.archive",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    });
  }, []);

  const deleteThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      const thread = visibleThreads.find((entry) => entry.id === threadId);
      if (!api || !thread) {
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [`Delete thread "${thread.title}"?`, "This permanently clears conversation history."].join(
          "\n",
        ),
      );
      if (!confirmed) {
        return;
      }
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      if (props.activeThreadId === threadId) {
        const fallbackThread = visibleThreads.find((entry) => entry.id !== threadId);
        if (fallbackThread) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThread.id },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }
    },
    [navigate, props.activeThreadId, visibleThreads],
  );

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Kanban</h1>
            <p className="text-xs text-muted-foreground">
              Organize active threads across inbox, active, waiting, and done.
            </p>
          </div>
          <Badge variant="outline">{visibleThreads.length} threads</Badge>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 gap-4 overflow-x-auto overflow-y-hidden p-4 md:grid-cols-2 xl:grid-cols-4">
        {BOARD_COLUMNS.map((column) => {
          const columnThreads = groupedThreads.get(column.id) ?? [];
          return (
            <section
              key={column.id}
              className="flex min-h-0 min-w-[18rem] flex-col rounded-2xl border border-border bg-card/60"
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const threadId = (event.dataTransfer.getData("text/plain") || draggingThreadId) as ThreadId | "";
                if (!threadId) {
                  return;
                }
                setDraggingThreadId(null);
                void moveThreadToColumn(threadId as ThreadId, column.id);
              }}
            >
              <div className="flex items-center justify-between border-b border-border px-3 py-3">
                <div>
                  <h2 className="text-sm font-medium">{column.label}</h2>
                  <p className="text-xs text-muted-foreground">{columnThreads.length} items</p>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                {columnThreads.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                    Drop a thread here.
                  </div>
                ) : null}
                {columnThreads.map((thread) => (
                  <article
                    key={thread.id}
                    draggable
                    onDragStart={(event) => {
                      setDraggingThreadId(thread.id);
                      event.dataTransfer.setData("text/plain", thread.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDraggingThreadId(null);
                    }}
                    className={cn(
                      "group rounded-xl border border-border bg-background p-3 shadow-sm transition-colors",
                      props.activeThreadId === thread.id && "border-primary/60 ring-1 ring-primary/35",
                    )}
                  >
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() => {
                        void navigate({
                          to: "/$threadId",
                          params: { threadId: thread.id },
                        });
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-medium">{thread.title}</h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {projectNameById.get(thread.projectId) ?? "Unknown project"}
                          </p>
                        </div>
                        <Badge variant="outline" className="shrink-0">
                          {threadStatusLabel(thread.session?.status)}
                        </Badge>
                      </div>
                    </button>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {formatRelativeTime(thread.createdAt)}
                      </span>
                      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="outline"
                          onClick={() => {
                            void archiveThread(thread.id);
                          }}
                          aria-label={`Archive ${thread.title}`}
                          title="Archive thread"
                        >
                          <ArchiveIcon className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="outline"
                          onClick={() => {
                            void deleteThread(thread.id);
                          }}
                          aria-label={`Delete ${thread.title}`}
                          title="Delete thread"
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
