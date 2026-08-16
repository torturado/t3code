import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const CodexProfileFileKindSchema = Schema.Literals(["instructions", "config", "skill"]);
export type CodexProfileFileKind = typeof CodexProfileFileKindSchema.Type;

export const CodexProfileFileSummarySchema = Schema.Struct({
  path: Schema.String,
  kind: CodexProfileFileKindSchema,
  size: NonNegativeInt,
  sha256: Schema.String,
});
export type CodexProfileFileSummary = typeof CodexProfileFileSummarySchema.Type;

export const CodexProfileSnapshotSchema = Schema.Struct({
  homePath: Schema.String,
  codexHomePath: Schema.String,
  skillsPath: Schema.String,
  files: Schema.Array(CodexProfileFileSummarySchema),
  warnings: Schema.Array(Schema.String),
});
export type CodexProfileSnapshot = typeof CodexProfileSnapshotSchema.Type;

export const CodexProfileSyncOptionsSchema = Schema.Struct({
  includeInstructions: Schema.Boolean,
  includeSkills: Schema.Boolean,
  includeConfig: Schema.Boolean,
});
export type CodexProfileSyncOptions = typeof CodexProfileSyncOptionsSchema.Type;

export const DesktopCodexProfileInspectionSchema = Schema.Struct({
  source: CodexProfileSnapshotSchema,
  remote: Schema.NullOr(CodexProfileSnapshotSchema),
  remoteError: Schema.NullOr(Schema.String),
});
export type DesktopCodexProfileInspection = typeof DesktopCodexProfileInspectionSchema.Type;

export const DesktopCodexProfileSyncResultSchema = Schema.Struct({
  backupPath: Schema.NullOr(Schema.String),
  writtenFiles: Schema.Array(Schema.String),
  remote: CodexProfileSnapshotSchema,
});
export type DesktopCodexProfileSyncResult = typeof DesktopCodexProfileSyncResultSchema.Type;
