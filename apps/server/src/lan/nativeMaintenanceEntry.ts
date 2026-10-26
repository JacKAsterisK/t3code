// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- A bounded stdin/stdout CLI bridges the native Hub lease without starting the server.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NativeActivationBuildIdentity, NativeMaintenanceRequest } from "@t3tools/contracts";
import { isEntrypoint } from "../entrypoint.ts";
import * as NativeMaintenance from "./NativeMaintenance.ts";
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
  try {
    if (process.argv.length !== 2) throw new Error("invalid_arguments");
    const compiled =
      typeof __T3_LAN_BUILD_IDENTITY__ === "undefined" ? null : __T3_LAN_BUILD_IDENTITY__;
    const identity = Schema.decodeUnknownSync(NativeActivationBuildIdentity, {
      onExcessProperty: "error",
    })(compiled);
    fallbackReason = "schema";
    const chunks: Array<Buffer> = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > 8192) throw new Error("invalid_request");
      chunks.push(bytes);
    }
    const request = Schema.decodeUnknownSync(NativeMaintenanceRequest, {
      onExcessProperty: "error",
    })(strictJson(Buffer.concat(chunks)));
    fallbackReason = "io";
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* NativeMaintenance.NativeMaintenance;
        return yield* request.operation === "probe"
          ? service.probe(request)
          : request.operation === "bootstrap"
            ? service.bootstrap(request)
            : request.operation === "inspect"
              ? service.inspect(request)
              : service.verify(request);
      }).pipe(
        Effect.provide([
          NativeMaintenance.layer(identity).pipe(Layer.provide(NativeMaintenance.layerNativeLease)),
          NodeServices.layer,
          Logger.layer([], { mergeWithExisting: false }),
        ]),
        Effect.scoped,
        Effect.result,
      ),
    );
    if (Result.isFailure(result)) throw result.failure;
    NodeFS.writeSync(process.stdout.fd, `${JSON.stringify(result.success)}\n`);
  } catch (cause) {
    NodeFS.writeSync(process.stderr.fd, nativeMaintenanceRefusalMessage(cause, fallbackReason));
    process.exitCode = 1;
  }
}
