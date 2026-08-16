import type { CodexProfileSnapshot } from "@t3tools/contracts";

export interface CodexProfileDiff {
  readonly added: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly remoteOnly: number;
}

export function diffCodexProfiles(
  source: CodexProfileSnapshot,
  remote: CodexProfileSnapshot | null,
): CodexProfileDiff {
  if (remote === null) {
    return {
      added: source.files.length,
      changed: 0,
      unchanged: 0,
      remoteOnly: 0,
    };
  }

  const remoteFiles = new Map(remote.files.map((file) => [file.path, file]));
  const sourcePaths = new Set(source.files.map((file) => file.path));
  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const file of source.files) {
    const remoteFile = remoteFiles.get(file.path);
    if (remoteFile === undefined) {
      added += 1;
    } else if (remoteFile.sha256 === file.sha256) {
      unchanged += 1;
    } else {
      changed += 1;
    }
  }

  return {
    added,
    changed,
    unchanged,
    remoteOnly: remote.files.filter((file) => !sourcePaths.has(file.path)).length,
  };
}
