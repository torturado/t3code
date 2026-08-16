import type {
  CodexProfileFileKind,
  CodexProfileSnapshot,
  DesktopSshEnvironmentTarget,
  DesktopCodexProfileSyncResult,
} from "@t3tools/contracts";
import {
  CodexProfileSnapshotSchema,
  DesktopCodexProfileSyncResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type SshAuthOptions } from "./auth.ts";
import { getLastNonEmptyOutputLine, runSshCommand, type SshCommandResult } from "./command.ts";
import { SshCommandError, SshInvalidTargetError } from "./errors.ts";

export const CODEX_PROFILE_MAX_FILES = 512;
export const CODEX_PROFILE_MAX_FILE_BYTES = 2_000_000;
export const CODEX_PROFILE_MAX_PAYLOAD_BYTES = 16_000_000;

export interface CodexProfileWriteFile {
  readonly path: string;
  readonly kind: CodexProfileFileKind;
  readonly contentsBase64: string;
  readonly mode: number;
}

export interface CodexProfileApplyInput {
  readonly files: ReadonlyArray<CodexProfileWriteFile>;
}

const PROFILE_NODE_LIBRARY = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const MAX_FILES = ${CODEX_PROFILE_MAX_FILES};
const MAX_FILE_BYTES = ${CODEX_PROFILE_MAX_FILE_BYTES};
const MAX_PAYLOAD_BYTES = ${CODEX_PROFILE_MAX_PAYLOAD_BYTES};

function resolveHome() {
  return path.resolve(process.env.HOME || os.homedir());
}

function resolveCodexHome(home) {
  const configured = (process.env.CODEX_HOME || "").trim();
  return path.resolve(home, configured || ".codex");
}

function resolveSkillsPath(home) {
  return path.join(home, ".agents", "skills");
}

function warningForPath(prefix, error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return code ? prefix + " (" + code + ")" : prefix;
}

function addFile(files, warnings, root, absolutePath, relativePath, kind) {
  if (files.length >= MAX_FILES) {
    return;
  }
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      warnings.push("Skipped symlink " + relativePath);
      return;
    }
    if (!stat.isFile()) {
      return;
    }
    if (stat.size > MAX_FILE_BYTES) {
      warnings.push("Skipped oversized file " + relativePath);
      return;
    }
    const contents = fs.readFileSync(absolutePath);
    files.push({
      path: relativePath,
      kind,
      size: contents.length,
      sha256: crypto.createHash("sha256").update(contents).digest("hex"),
    });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      warnings.push(warningForPath("Could not inspect " + relativePath, error));
    }
  }
}

function walkSkillDirectory(files, warnings, skillsPath, currentPath, relativePath) {
  let entries;
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch (error) {
    warnings.push(warningForPath("Could not read " + relativePath, error));
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const nextPath = path.join(currentPath, entry.name);
    const nextRelativePath = relativePath + "/" + entry.name;
    if (entry.isSymbolicLink()) {
      warnings.push("Skipped symlink " + nextRelativePath);
    } else if (entry.isDirectory()) {
      walkSkillDirectory(files, warnings, skillsPath, nextPath, nextRelativePath);
    } else if (entry.isFile()) {
      addFile(files, warnings, skillsPath, nextPath, nextRelativePath, "skill");
    }
    if (files.length >= MAX_FILES) return;
  }
}

function listProfileFiles(home, codexHome, skillsPath) {
  const files = [];
  const warnings = [];
  addFile(files, warnings, codexHome, path.join(codexHome, "AGENTS.md"), "AGENTS.md", "instructions");
  addFile(
    files,
    warnings,
    codexHome,
    path.join(codexHome, "AGENTS.override.md"),
    "AGENTS.override.md",
    "instructions",
  );
  addFile(files, warnings, codexHome, path.join(codexHome, "config.toml"), "config.toml", "config");

  let skillEntries = [];
  try {
    skillEntries = fs.readdirSync(skillsPath, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "ENOENT") warnings.push(warningForPath("Could not read skills directory", error));
  }
  for (const entry of skillEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= MAX_FILES) break;
    if (entry.isSymbolicLink()) {
      warnings.push("Skipped symlink skills entry " + entry.name);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsPath, entry.name);
    const skillManifest = path.join(skillPath, "SKILL.md");
    try {
      const manifestStat = fs.lstatSync(skillManifest);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) continue;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "ENOENT") warnings.push(warningForPath("Could not inspect skill " + entry.name, error));
      continue;
    }
    walkSkillDirectory(files, warnings, skillsPath, skillPath, "skills/" + entry.name);
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, warnings };
}

function makeSnapshot() {
  const home = resolveHome();
  const codexHome = resolveCodexHome(home);
  const skillsPath = resolveSkillsPath(home);
  const listed = listProfileFiles(home, codexHome, skillsPath);
  return {
    homePath: home,
    codexHomePath: codexHome,
    skillsPath,
    files: listed.files,
    warnings: listed.warnings,
  };
}

function assertSafePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Profile path escapes its destination root.");
  }
  let current = resolvedTarget;
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error("Profile destination contains a symlink.");
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "ENOENT") throw error;
    }
    if (current === resolvedRoot) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Profile destination root is invalid.");
    current = parent;
  }
}

function destinationForFile(file, codexHome, skillsPath) {
  if (!file || typeof file !== "object") throw new Error("Invalid profile file.");
  if (typeof file.path !== "string" || file.path.length === 0 || file.path.includes("\\")) {
    throw new Error("Invalid profile path.");
  }
  if (file.path.startsWith("/") || file.path.split("/").includes("..")) {
    throw new Error("Invalid profile path.");
  }
  if (file.kind === "instructions" && (file.path === "AGENTS.md" || file.path === "AGENTS.override.md")) {
    return { root: codexHome, target: path.join(codexHome, file.path) };
  }
  if (file.kind === "config" && file.path === "config.toml") {
    return { root: codexHome, target: path.join(codexHome, file.path) };
  }
  if (file.kind === "skill" && file.path.startsWith("skills/")) {
    const skillRelativePath = file.path.slice("skills/".length);
    if (!skillRelativePath || skillRelativePath.startsWith("/") || skillRelativePath.endsWith("/")) {
      throw new Error("Invalid skill path.");
    }
    return { root: skillsPath, target: path.join(skillsPath, skillRelativePath) };
  }
  throw new Error("Profile file is outside the supported Codex profile.");
}
`;

const INSPECT_BODY = String.raw`
process.stdout.write(JSON.stringify(makeSnapshot()) + "\n");
`;

const APPLY_BODY = String.raw`
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!payload || !Array.isArray(payload.files) || payload.files.length > MAX_FILES) {
  throw new Error("Invalid Codex profile payload.");
}
const home = resolveHome();
const codexHome = resolveCodexHome(home);
const skillsPath = resolveSkillsPath(home);
const backupRoot = path.join(codexHome, "backups", "t3-profile-" + Date.now());
let backupCreated = false;
let payloadBytes = 0;
const writtenFiles = [];

for (const file of payload.files) {
  if (typeof file.contentsBase64 !== "string" || file.contentsBase64.length > MAX_FILE_BYTES * 2) {
    throw new Error("Profile file is too large.");
  }
  const destination = destinationForFile(file, codexHome, skillsPath);
  assertSafePath(destination.root, destination.target);
  const contents = Buffer.from(file.contentsBase64, "base64");
  if (contents.length > MAX_FILE_BYTES) throw new Error("Profile file is too large.");
  payloadBytes += contents.length;
  if (payloadBytes > MAX_PAYLOAD_BYTES) throw new Error("Profile payload is too large.");
  const existing = (() => {
    try {
      const stat = fs.lstatSync(destination.target);
      if (stat.isSymbolicLink()) throw new Error("Profile destination is a symlink.");
      return stat.isFile();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "ENOENT") return false;
      throw error;
    }
  })();
  if (existing) {
    if (!backupCreated) {
      fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      backupCreated = true;
    }
    const backupPath = path.join(backupRoot, file.path);
    assertSafePath(backupRoot, backupPath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(destination.target, backupPath);
  }
  fs.mkdirSync(path.dirname(destination.target), { recursive: true, mode: 0o700 });
  assertSafePath(destination.root, destination.target);
  const temporaryPath = destination.target + ".t3-profile-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".tmp";
  try {
    fs.writeFileSync(temporaryPath, contents, { mode: 0o600 });
    const requestedMode = Number.isInteger(file.mode) ? file.mode & 0o777 : 0o600;
    fs.chmodSync(temporaryPath, requestedMode === 0 ? 0o600 : requestedMode);
    fs.renameSync(temporaryPath, destination.target);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "ENOENT") throw error;
    }
  }
  writtenFiles.push(file.path);
}

process.stdout.write(
  JSON.stringify({
    backupPath: backupCreated ? backupRoot : null,
    writtenFiles,
    remote: makeSnapshot(),
  }) + "\n",
);
`;

function buildNodeScript(body: string): string {
  return `${PROFILE_NODE_LIBRARY}\n${body}`;
}

export function buildCodexProfileInspectScript(): string {
  return [
    "set -eu",
    "node <<'T3_CODEX_PROFILE_NODE'",
    buildNodeScript(INSPECT_BODY),
    "T3_CODEX_PROFILE_NODE",
  ].join("\n");
}

export function buildCodexProfileApplyScript(input: CodexProfileApplyInput): string {
  const payloadJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(input);
  if (Buffer.byteLength(payloadJson, "utf8") > CODEX_PROFILE_MAX_PAYLOAD_BYTES) {
    throw new Error("Codex profile payload is too large.");
  }
  const payload = Buffer.from(payloadJson, "utf8").toString("base64");
  return [
    "set -eu",
    'PAYLOAD_FILE="$(mktemp)"',
    "trap 'rm -f \"$PAYLOAD_FILE\"' EXIT",
    "if base64 -d </dev/null >/dev/null 2>&1; then",
    "  base64 -d >\"$PAYLOAD_FILE\" <<'T3_CODEX_PROFILE_PAYLOAD'",
    payload,
    "T3_CODEX_PROFILE_PAYLOAD",
    "else",
    "  base64 -D >\"$PAYLOAD_FILE\" <<'T3_CODEX_PROFILE_PAYLOAD'",
    payload,
    "T3_CODEX_PROFILE_PAYLOAD",
    "fi",
    "node - \"$PAYLOAD_FILE\" <<'T3_CODEX_PROFILE_NODE'",
    buildNodeScript(APPLY_BODY),
    "T3_CODEX_PROFILE_NODE",
  ].join("\n");
}

function parseRemoteOutput<T>(
  result: SshCommandResult,
  schema: Schema.Decoder<T, never>,
  operation: string,
): Effect.Effect<T, SshCommandError> {
  const line = getLastNonEmptyOutputLine(result.stdout);
  if (line === null) {
    return Effect.fail(
      new SshCommandError({
        command: ["ssh"],
        exitCode: 0,
        stderr: result.stderr,
        message: `SSH ${operation} returned no result.`,
      }),
    );
  }
  return Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(line).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: 0,
          stderr: result.stderr,
          message: `SSH ${operation} returned invalid JSON.`,
          cause,
        }),
    ),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(
          (cause) =>
            new SshCommandError({
              command: ["ssh"],
              exitCode: 0,
              stderr: result.stderr,
              message: `SSH ${operation} returned an invalid profile.`,
              cause,
            }),
        ),
      ),
    ),
  );
}

export const inspectRemoteCodexProfile = Effect.fn("ssh/codexProfile.inspectRemote")(function* (
  target: DesktopSshEnvironmentTarget,
  auth?: SshAuthOptions,
): Effect.fn.Return<
  CodexProfileSnapshot,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildCodexProfileInspectScript(),
    timeoutMs: 30_000,
    ...(auth?.authSecret === undefined ? {} : { authSecret: auth.authSecret }),
    ...(auth?.batchMode === undefined ? {} : { batchMode: auth.batchMode }),
    ...(auth?.interactiveAuth === undefined ? {} : { interactiveAuth: auth.interactiveAuth }),
  });
  return yield* parseRemoteOutput(result, CodexProfileSnapshotSchema, "Codex profile inspection");
});

export const applyRemoteCodexProfile = Effect.fn("ssh/codexProfile.applyRemote")(function* (
  target: DesktopSshEnvironmentTarget,
  input: CodexProfileApplyInput,
  auth?: SshAuthOptions,
): Effect.fn.Return<
  DesktopCodexProfileSyncResult,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildCodexProfileApplyScript(input),
    timeoutMs: 120_000,
    ...(auth?.authSecret === undefined ? {} : { authSecret: auth.authSecret }),
    ...(auth?.batchMode === undefined ? {} : { batchMode: auth.batchMode }),
    ...(auth?.interactiveAuth === undefined ? {} : { interactiveAuth: auth.interactiveAuth }),
  });
  return yield* parseRemoteOutput(
    result,
    DesktopCodexProfileSyncResultSchema,
    "Codex profile sync",
  );
});
