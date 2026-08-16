// @effect-diagnostics nodeBuiltinImport:off - The desktop main process reads the user's local Codex profile.
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CodexProfileFileKind,
  CodexProfileFileSummary,
  CodexProfileSnapshot,
} from "@t3tools/contracts";
import {
  CODEX_PROFILE_MAX_FILE_BYTES,
  CODEX_PROFILE_MAX_FILES,
  type CodexProfileWriteFile,
} from "@t3tools/ssh/codexProfile";
import * as Schema from "effect/Schema";

export class DesktopCodexProfileError extends Schema.TaggedErrorClass<DesktopCodexProfileError>()(
  "DesktopCodexProfileError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface LocalCodexProfile {
  readonly snapshot: CodexProfileSnapshot;
  readonly files: ReadonlyArray<CodexProfileWriteFile>;
}

export interface ReadLocalCodexProfileOptions {
  readonly homeDirectory?: string;
  readonly codexHome?: string;
}

interface MutableProfileFiles {
  readonly files: CodexProfileWriteFile[];
  readonly warnings: string[];
}

function errorCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  const code = cause.code;
  return typeof code === "string" ? code : null;
}

function describeInspectionError(relativePath: string, cause: unknown): string {
  const code = errorCode(cause);
  return code
    ? `Could not inspect ${relativePath} (${code}).`
    : `Could not inspect ${relativePath}.`;
}

function resolveCodexHome(homeDirectory: string, configuredCodexHome?: string): string {
  const value = (configuredCodexHome ?? process.env.CODEX_HOME ?? "").trim();
  return resolve(homeDirectory, value || ".codex");
}

async function addFile(
  state: MutableProfileFiles,
  absolutePath: string,
  relativePath: string,
  kind: CodexProfileFileKind,
): Promise<void> {
  if (state.files.length >= CODEX_PROFILE_MAX_FILES) return;

  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      state.warnings.push(`Skipped symlink ${relativePath}.`);
      return;
    }
    if (!stat.isFile()) return;

    const contents = await readFile(absolutePath);
    if (contents.byteLength > CODEX_PROFILE_MAX_FILE_BYTES) {
      state.warnings.push(`Skipped oversized file ${relativePath}.`);
      return;
    }

    state.files.push({
      path: relativePath,
      kind,
      contentsBase64: contents.toString("base64"),
      mode: stat.mode & 0o777 || 0o600,
    });
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") {
      state.warnings.push(describeInspectionError(relativePath, cause));
    }
  }
}

async function walkSkillDirectory(
  state: MutableProfileFiles,
  absolutePath: string,
  relativePath: string,
): Promise<void> {
  if (state.files.length >= CODEX_PROFILE_MAX_FILES) return;

  let entries;
  try {
    entries = await readdir(absolutePath, { withFileTypes: true });
  } catch (cause) {
    state.warnings.push(describeInspectionError(relativePath, cause));
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (state.files.length >= CODEX_PROFILE_MAX_FILES) return;
    const nextPath = join(absolutePath, entry.name);
    const nextRelativePath = `${relativePath}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      state.warnings.push(`Skipped symlink ${nextRelativePath}.`);
    } else if (entry.isDirectory()) {
      await walkSkillDirectory(state, nextPath, nextRelativePath);
    } else if (entry.isFile()) {
      await addFile(state, nextPath, nextRelativePath, "skill");
    }
  }
}

async function listProfileFiles(
  codexHome: string,
  skillsPath: string,
): Promise<MutableProfileFiles> {
  const state: MutableProfileFiles = { files: [], warnings: [] };
  await addFile(state, join(codexHome, "AGENTS.md"), "AGENTS.md", "instructions");
  await addFile(state, join(codexHome, "AGENTS.override.md"), "AGENTS.override.md", "instructions");
  await addFile(state, join(codexHome, "config.toml"), "config.toml", "config");

  let skillEntries: Dirent[];
  try {
    skillEntries = await readdir(skillsPath, { withFileTypes: true });
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") {
      state.warnings.push(describeInspectionError(".agents/skills", cause));
    }
    skillEntries = [];
  }

  skillEntries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of skillEntries) {
    if (state.files.length >= CODEX_PROFILE_MAX_FILES) break;
    if (entry.isSymbolicLink()) {
      state.warnings.push(`Skipped symlink skill ${entry.name}.`);
      continue;
    }
    if (!entry.isDirectory()) continue;

    const skillPath = join(skillsPath, entry.name);
    const manifestPath = join(skillPath, "SKILL.md");
    try {
      const manifestStat = await lstat(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) continue;
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") {
        state.warnings.push(describeInspectionError(`skills/${entry.name}/SKILL.md`, cause));
      }
      continue;
    }
    await walkSkillDirectory(state, skillPath, `skills/${entry.name}`);
  }

  if (state.files.length >= CODEX_PROFILE_MAX_FILES) {
    state.warnings.push(`Only the first ${CODEX_PROFILE_MAX_FILES} files were included.`);
  }
  state.files.sort((left, right) => left.path.localeCompare(right.path));
  return state;
}

function summarizeFile(file: CodexProfileWriteFile): CodexProfileFileSummary {
  const contents = Buffer.from(file.contentsBase64, "base64");
  return {
    path: file.path,
    kind: file.kind,
    size: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

export async function readLocalCodexProfile(
  options: ReadLocalCodexProfileOptions = {},
): Promise<LocalCodexProfile> {
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const codexHome = resolveCodexHome(homeDirectory, options.codexHome);
  const skillsPath = join(homeDirectory, ".agents", "skills");
  const listed = await listProfileFiles(codexHome, skillsPath);
  const snapshot: CodexProfileSnapshot = {
    homePath: homeDirectory,
    codexHomePath: codexHome,
    skillsPath,
    files: listed.files.map(summarizeFile),
    warnings: listed.warnings,
  };
  return { snapshot, files: listed.files };
}
