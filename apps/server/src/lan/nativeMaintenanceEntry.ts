// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- A bounded stdin/stdout CLI bridges the native Hub lease without starting the server.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NativeActivationBuildIdentity,
  NativeMaintenanceRequest,
  NativeUnfinishedWorkRequest,
} from "@t3tools/contracts";
import { isEntrypoint } from "../entrypoint.ts";
import * as NativeMaintenance from "./NativeMaintenance.ts";
import {
  FleetCredentialRecoveryCommand,
  fleetRecoveryRefusal,
  recoverFleetCredential,
} from "./fleetCredentialRecoveryEntry.ts";
import { unfinishedWork } from "./NativeUnfinishedWork.ts";
import { strictJson } from "@t3tools/shared/strictJson";

declare const __T3_LAN_BUILD_IDENTITY__: unknown;
const isNativeMaintenanceError = Schema.is(NativeMaintenance.NativeMaintenanceError);

export function nativeMaintenanceRefusalMessage(
  cause: unknown,
  fallback: NativeMaintenance.NativeMaintenanceError["reason"] = "io",
) {
  const reason = isNativeMaintenanceError(cause) ? cause.reason : fallback;
  return `native_maintenance_refused:${reason}\n`;
}

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  let fallbackReason: NativeMaintenance.NativeMaintenanceError["reason"] = "identity";
  let fleetRecovery = false;
  try {
    const compiled =
      typeof __T3_LAN_BUILD_IDENTITY__ === "undefined" ? null : __T3_LAN_BUILD_IDENTITY__;
    const identity = Schema.decodeUnknownSync(NativeActivationBuildIdentity, {
      onExcessProperty: "error",
    })(compiled);
    const args = process.argv.slice(2);
    if (args.length === 3 && args[0] === "diagnose-stale-work" && args[1] === "--snapshot") {
      fallbackReason = "io";
      const report = await NativeMaintenance.diagnoseStaleWorkSnapshot(args[2]!);
      NodeFS.writeSync(
        process.stdout.fd,
        `${JSON.stringify({ ...report, compiledIdentity: identity })}\n`,
      );
    } else {
      if (args.length !== 0) throw new Error("invalid_arguments");
      fallbackReason = "schema";
      const chunks: Array<Buffer> = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 8192) throw new Error("invalid_request");
        chunks.push(bytes);
      }
      const document = strictJson(Buffer.concat(chunks));
      fleetRecovery =
        typeof document === "object" &&
        document !== null &&
        "operation" in document &&
        document.operation === "fleet-credential-recovery";
      const recovery = fleetRecovery
        ? Schema.decodeUnknownSync(FleetCredentialRecoveryCommand, { onExcessProperty: "error" })(
            document,
          )
        : undefined;
      const workRequest =
        typeof document === "object" &&
        document !== null &&
        "operation" in document &&
        ["inspect-unfinished-work", "cancel-unfinished-work", "settle-stale-work"].includes(
          String(document.operation),
        )
          ? Schema.decodeUnknownSync(NativeUnfinishedWorkRequest, { onExcessProperty: "error" })(
              document,
            )
          : undefined;
      const request =
        workRequest !== undefined
          ? undefined
          : recovery
            ? {
                schemaVersion: 1 as const,
                operation: "inspect" as const,
                nonce: recovery.nonce,
                homeDirectory: recovery.homeDirectory,
                environmentId: recovery.environmentId,
                journalPath: recovery.journalPath,
                generationVersion: 2 as const,
              }
            : Schema.decodeUnknownSync(NativeMaintenanceRequest, { onExcessProperty: "error" })(
                document,
              );
      fallbackReason = "io";
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          if (workRequest !== undefined) return yield* unfinishedWork(workRequest, identity);
          if (request === undefined)
            return yield* new NativeMaintenance.NativeMaintenanceError({ reason: "schema" });
          const service = yield* NativeMaintenance.NativeMaintenance;
          if (recovery !== undefined) {
            yield* service.inspect(request);
            const result = yield* recoverFleetCredential(recovery);
            return {
              ...result,
              nonce: recovery.nonce,
              sourceCommit: identity.sourceCommit,
              environmentId: recovery.environmentId,
            };
          }
          return yield* request.operation === "probe"
            ? service.probe(request)
            : request.operation === "bootstrap"
              ? service.bootstrap(request)
              : request.operation === "inspect"
                ? service.inspect(request)
                : service.verify(request);
        }).pipe(
          Effect.provide([
            NativeMaintenance.layer(identity).pipe(
              Layer.provide(NativeMaintenance.layerNativeLease),
            ),
            NativeMaintenance.layerNativeLease,
            NodeServices.layer,
            Logger.layer([], { mergeWithExisting: false }),
          ]),
          Effect.scoped,
          Effect.result,
        ),
      );
      if (Result.isFailure(result)) throw result.failure;
      NodeFS.writeSync(process.stdout.fd, `${JSON.stringify(result.success)}\n`);
    }
  } catch (cause) {
    NodeFS.writeSync(
      process.stderr.fd,
      fleetRecovery
        ? `fleet_credential_recovery_refused:${fleetRecoveryRefusal(cause)}\n`
        : nativeMaintenanceRefusalMessage(cause, fallbackReason),
    );
    process.exitCode = 1;
  }
}
