// @effect-diagnostics nodeBuiltinImport:off -- Owner-bound native admission records are local OS files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isLanDistribution } from "@t3tools/shared/distribution";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import type * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { NativeMaintenanceError, inspectNativeUpdateReadinessWork } from "./NativeMaintenance.ts";
import { startNativeUpdateControl } from "./NativeUpdateControl.ts";

export function supportsNativeUpdateControl(input: {
  readonly lan: boolean;
  readonly platform: string;
  readonly mode: string;
  readonly stdinShutdown: boolean;
  readonly parentPid: number;
  readonly guardedParentPid: string | undefined;
}): boolean {
  return (
    input.lan &&
    input.platform === "win32" &&
    input.mode === "desktop" &&
    input.stdinShutdown &&
    Number.isSafeInteger(input.parentPid) &&
    input.parentPid > 0 &&
    input.guardedParentPid === String(input.parentPid)
  );
}

const ReadinessRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: Schema.String,
  ownerId: Schema.String,
  draftStateKnown: Schema.Boolean,
  hasUnsentPrompt: Schema.NullOr(Schema.Boolean),
  observedUtc: Schema.String,
  guardedCloseSupported: Schema.Literal(true),
  updateControlVersion: Schema.Literal(1),
  updateControlPipe: Schema.String,
});
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(ReadinessRecord));
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ ownerId: Schema.String })),
);

const blockingKeys = [
  "activeRuns",
  "queuedRuns",
  "pendingRequests",
  "backgroundAgents",
  "scheduledWork",
  "restartContinuations",
] as const;

/** Starts only after the runtime owner is published, within its existing admission/ownership scope. */
export const startNativeUpdateReadiness = Effect.fn("NativeUpdateReadiness.start")(
  function* (input: {
    readonly config: ServerConfig.ServerConfig["Service"];
    readonly ownerId: string;
  }) {
    const { config, ownerId } = input;
    const platform = yield* HostProcess.Platform;
    const hostEnvironment = yield* HostProcess.Environment;
    if (
      !supportsNativeUpdateControl({
        lan: isLanDistribution,
        platform,
        mode: config.mode,
        stdinShutdown: config.desktopShutdownOnStdin === true,
        parentPid: process.ppid,
        guardedParentPid: hostEnvironment.T3CODE_NATIVE_UPDATE_CLOSE_PARENT_PID,
      })
    )
      return;
    const policy = yield* BackgroundPolicy.BackgroundPolicy;
    const drafts = policy.nativeUpdate;
    if (drafts === undefined) return;
    const environment = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
    const inspectReady = Effect.gen(function* () {
      const state = yield* drafts.snapshot;
      if (!state.draftStateKnown || state.hasUnsentPrompt !== false) return false;
      return yield* Effect.try({
        try: () => {
          const work = inspectNativeUpdateReadinessWork(config.dbPath);
          return blockingKeys.every((key) => work[key] === 0);
        },
        catch: () => new NativeMaintenanceError({ reason: "io" }),
      });
    });
    const control = yield* startNativeUpdateControl({
      identity: { environmentId: environment.environmentId, ownerId, pid: process.pid },
      desktopPid: process.ppid,
      inspectReady,
      freezeDrafts: drafts.freeze,
      verifyFrozenDrafts: drafts.verify,
      thawDrafts: drafts.thaw,
    });
    const readinessPath = NodePath.join(config.stateDir, "native-update-readiness.json");
    const writeMutex = yield* Semaphore.make(1);
    const write = writeMutex
      .withPermits(1)(
        Effect.gen(function* () {
          const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
          if (
            Option.isNone(runtime) ||
            runtime.value.ownerId !== ownerId ||
            runtime.value.pid !== process.pid
          )
            return;
          // AtomicWrite deliberately follows symlinks for ordinary settings. Native admission must not.
          yield* Effect.try(() => {
            for (let current = readinessPath; ; current = NodePath.dirname(current)) {
              try {
                if (NodeFS.lstatSync(current).isSymbolicLink())
                  throw new Error("Linked native readiness path.");
              } catch (cause) {
                if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
                  throw cause;
              }
              if (NodePath.dirname(current) === current) break;
            }
          });
          const state = yield* drafts.snapshot;
          const observedUtc = DateTime.formatIso(yield* DateTime.now);
          yield* writeFileStringAtomically({
            filePath: readinessPath,
            contents:
              encodeRecord({
                schemaVersion: 1,
                environmentId: environment.environmentId,
                ownerId,
                draftStateKnown: state.draftStateKnown,
                hasUnsentPrompt: state.hasUnsentPrompt,
                observedUtc,
                guardedCloseSupported: true,
                updateControlVersion: 1,
                updateControlPipe: control.pipeName,
              }) + "\n",
          });
        }),
      )
      .pipe(
        Effect.catchCause(() => Effect.logWarning("Could not publish native update readiness.")),
      );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          const stat = NodeFS.lstatSync(readinessPath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return;
          const record = decodeRecord(NodeFS.readFileSync(readinessPath, "utf8"));
          if (record.ownerId === ownerId) NodeFS.unlinkSync(readinessPath);
        } catch {
          /* A missing or foreign record does not belong to this owner. */
        }
      }),
    );
    yield* write;
    yield* policy.streamChanges.pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => write),
      Effect.forkScoped,
    );
    yield* Effect.forever(Effect.sleep("10 seconds").pipe(Effect.andThen(write))).pipe(
      Effect.forkScoped,
    );
  },
  Effect.catchCause(() => Effect.logWarning("Native guarded update control is unavailable.")),
);
