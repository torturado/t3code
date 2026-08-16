import {
  DesktopCodexProfileInspectionSchema,
  DesktopCodexProfileInspectInputSchema,
  DesktopCodexProfileSyncInputSchema,
  DesktopCodexProfileSyncResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";

export const inspectCodexProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSPECT_CODEX_PROFILE_CHANNEL,
  payload: DesktopCodexProfileInspectInputSchema,
  result: DesktopCodexProfileInspectionSchema,
  handler: Effect.fn("desktop.ipc.codexProfile.inspect")(function* ({ target }) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.inspectCodexProfile(target);
  }),
});

export const syncCodexProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SYNC_CODEX_PROFILE_CHANNEL,
  payload: DesktopCodexProfileSyncInputSchema,
  result: DesktopCodexProfileSyncResultSchema,
  handler: Effect.fn("desktop.ipc.codexProfile.sync")(function* ({ target, options }) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.syncCodexProfile(target, options);
  }),
});
