import type {
  CodexProfileFileKind,
  CodexProfileSnapshot,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { diffCodexProfiles } from "./CodexProfileSyncDialog.logic";

interface CodexProfileSyncDialogProps {
  readonly target: DesktopSshEnvironmentTarget | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const KIND_LABELS: Record<CodexProfileFileKind, string> = {
  instructions: "Instructions",
  skill: "Skills",
  config: "Config",
};

function countFiles(snapshot: CodexProfileSnapshot, kind: CodexProfileFileKind): number {
  return snapshot.files.filter((file) => file.kind === kind).length;
}

function selectedFileCount(
  snapshot: CodexProfileSnapshot,
  includeInstructions: boolean,
  includeSkills: boolean,
  includeConfig: boolean,
): number {
  return snapshot.files.filter((file) => {
    if (file.kind === "instructions") return includeInstructions;
    if (file.kind === "skill") return includeSkills;
    return includeConfig;
  }).length;
}

function ProfileSummary({ label, snapshot }: { label: string; snapshot: CodexProfileSnapshot }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">
          {snapshot.files.length} {snapshot.files.length === 1 ? "file" : "files"}
        </span>
      </div>
      <p
        className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
        title={snapshot.codexHomePath}
      >
        {snapshot.codexHomePath}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {Object.entries(KIND_LABELS).map(([kind, kindLabel]) => (
          <span key={kind}>
            {kindLabel} {countFiles(snapshot, kind as CodexProfileFileKind)}
          </span>
        ))}
      </div>
    </div>
  );
}

function SyncOption({
  checked,
  disabled,
  title,
  description,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly title: string;
  readonly description: string;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 px-3 py-2.5 hover:bg-muted/30 has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{title}</span>
        <span className="block text-xs leading-snug text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

export function CodexProfileSyncDialog({
  target,
  open,
  onOpenChange,
}: CodexProfileSyncDialogProps) {
  const desktopBridge = window.desktopBridge;
  const [inspection, setInspection] = useState<{
    readonly source: CodexProfileSnapshot;
    readonly remote: CodexProfileSnapshot | null;
    readonly remoteError: string | null;
  } | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [includeInstructions, setIncludeInstructions] = useState(true);
  const [includeSkills, setIncludeSkills] = useState(true);
  const [includeConfig, setIncludeConfig] = useState(false);

  useEffect(() => {
    if (!open || target === null || desktopBridge === undefined) return;
    let cancelled = false;
    setInspection(null);
    setInspectionError(null);
    setIsInspecting(true);
    void desktopBridge
      .inspectCodexProfile(target)
      .then((result) => {
        if (!cancelled) setInspection(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setInspectionError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setIsInspecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopBridge, open, target]);

  const diff = useMemo(
    () => (inspection === null ? null : diffCodexProfiles(inspection.source, inspection.remote)),
    [inspection],
  );
  const source = inspection?.source ?? null;
  const selectedCount =
    source === null
      ? 0
      : selectedFileCount(source, includeInstructions, includeSkills, includeConfig);
  const hasConfig = source?.files.some((file) => file.kind === "config") ?? false;
  const busy = isInspecting || isSyncing;

  if (target === null || desktopBridge === undefined) return null;

  const handleSync = async () => {
    if (source === null || selectedCount === 0 || isSyncing) return;
    setIsSyncing(true);
    try {
      const result = await desktopBridge.syncCodexProfile(target, {
        includeInstructions,
        includeSkills,
        includeConfig,
      });
      toastManager.add({
        type: "success",
        title: "Codex profile synced",
        description: [
          `${result.writtenFiles.length} file${result.writtenFiles.length === 1 ? "" : "s"} copied to ${target.alias}.`,
          ...(result.backupPath === null
            ? []
            : [`Existing files backed up at ${result.backupPath}.`]),
        ].join(" "),
      });
      onOpenChange(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not sync Codex profile",
          description: message,
        }),
      );
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSyncing) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Sync global Codex setup</DialogTitle>
          <DialogDescription>
            Copy your reviewed global instructions and skills from this computer to the SSH
            environment. Existing remote files are backed up first.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {isInspecting ? (
            <div className="flex items-center gap-2 rounded-lg border border-border/70 px-3 py-3 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Inspecting local and remote Codex profiles…
            </div>
          ) : inspectionError !== null ? (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
              role="alert"
            >
              Could not inspect the profiles: {inspectionError}
            </div>
          ) : source !== null ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <ProfileSummary label="This computer" snapshot={source} />
                {inspection?.remote !== null && inspection?.remote !== undefined ? (
                  <ProfileSummary label="Remote environment" snapshot={inspection.remote} />
                ) : (
                  <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-xs text-warning">
                    The remote profile could not be read. Sync will still validate the destination
                    and create a backup where needed.
                    {inspection?.remoteError ? (
                      <span className="mt-1 block text-warning/80">{inspection.remoteError}</span>
                    ) : null}
                  </div>
                )}
              </div>

              <section className="space-y-2" aria-labelledby="codex-profile-sync-options">
                <div>
                  <h3
                    id="codex-profile-sync-options"
                    className="text-xs font-medium text-foreground"
                  >
                    What to copy
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Credential and session files are excluded. Review config.toml before enabling it
                    because it may contain sensitive settings.
                  </p>
                </div>
                <div className="space-y-2">
                  <SyncOption
                    checked={includeInstructions}
                    disabled={busy || countFiles(source, "instructions") === 0}
                    title="Global instructions"
                    description={`${countFiles(source, "instructions")} AGENTS.md file${countFiles(source, "instructions") === 1 ? "" : "s"}.`}
                    onCheckedChange={setIncludeInstructions}
                  />
                  <SyncOption
                    checked={includeSkills}
                    disabled={busy || countFiles(source, "skill") === 0}
                    title="Skills"
                    description={`${countFiles(source, "skill")} files from skills that contain SKILL.md.`}
                    onCheckedChange={setIncludeSkills}
                  />
                  <SyncOption
                    checked={includeConfig}
                    disabled={busy || !hasConfig}
                    title="config.toml (advanced)"
                    description="Optional machine-specific settings; review before enabling."
                    onCheckedChange={setIncludeConfig}
                  />
                </div>
              </section>

              {diff !== null ? (
                <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 text-xs">
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                    <span>{diff.added} new</span>
                    <span>{diff.changed} changed</span>
                    <span>{diff.unchanged} unchanged</span>
                    <span>{diff.remoteOnly} remote-only (kept)</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    Sync only writes the selected files; it does not delete anything from the remote
                    machine.
                  </p>
                </div>
              ) : null}

              {source.warnings.length > 0 ? (
                <div
                  className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-xs text-warning"
                  role="status"
                >
                  {source.warnings.length} local file warning
                  {source.warnings.length === 1 ? "" : "s"}; skipped files will not be copied.
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {selectedCount === 0
                  ? "Select at least one category to continue."
                  : `${selectedCount} file${selectedCount === 1 ? "" : "s"} selected · files are limited to 2 MB each.`}
              </p>
            </>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose
            disabled={isSyncing}
            render={<Button variant="outline" disabled={isSyncing} />}
          >
            Cancel
          </DialogClose>
          <Button
            disabled={busy || source === null || selectedCount === 0}
            onClick={() => void handleSync()}
          >
            {isSyncing ? (
              <>
                <Spinner className="size-3.5" />
                Syncing…
              </>
            ) : (
              "Sync profile"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
