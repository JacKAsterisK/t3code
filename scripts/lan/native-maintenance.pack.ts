// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- This local build CLI embeds reviewed public identity only and writes an unconfigured test artifact, never credentials.
import { build } from "vite-plus/pack";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { BuildLock } from "./hub-distribution.ts";
import { parseLanBuildIdentity } from "@t3tools/shared/distribution";
import {
  lanBuildDefines,
  readLanBuildPolicyFile,
  type LanBuildIdentity,
} from "../lib/lan-build-policy.ts";
import { strictJson } from "../lib/strict-json.ts";
import { assertOwnedNativeHelperFile, inspectNativeHelperOutput } from "./native-helper-output.ts";

const decodeLock = Schema.decodeUnknownSync(BuildLock, {
  onExcessProperty: "error",
});
export async function buildNativeMaintenance(
  rawIdentity: LanBuildIdentity,
  lockBytes: Uint8Array,
  outDir: string,
) {
  const identity = parseLanBuildIdentity(rawIdentity);
  const lock = decodeLock(strictJson(lockBytes));
  if (
    identity.sourceCommit !== lock.forkCommit ||
    identity.applicationVersion !== lock.applicationVersion ||
    identity.appId.startsWith("com.t3tools.") ||
    /^T3 Code(?: \((?:Beta|Nightly)\))?$/iu.test(identity.productName) ||
    ["t3code", "t3code-dev"].includes(identity.protocolScheme)
  )
    throw new Error("The reviewed identity must match the build lock and remain independent.");
  const root = NodePath.resolve(import.meta.dirname, "../..");
  if (!NodePath.isAbsolute(outDir))
    throw new Error("Native helper output requires an absolute staging path.");
  inspectNativeHelperOutput(outDir, root);
  if (!NodeFS.existsSync(outDir)) NodeFS.mkdirSync(outDir);
  const ownerLock = NodePath.join(outDir, ".native-helper-build.lock");
  const ownership = NodeFS.openSync(ownerLock, "wx");
  const ownerIdentity = NodeFS.fstatSync(ownership);
  try {
    const previousFiles = inspectNativeHelperOutput(outDir, root, ownerIdentity);
    for (const file of previousFiles) {
      assertOwnedNativeHelperFile(file);
      NodeFS.unlinkSync(file.path);
    }
    await build({
      config: false,
      entry: {
        "native-maintenance": NodePath.join(root, "apps/server/src/lan/nativeMaintenanceEntry.ts"),
      },
      outDir,
      format: "esm",
      platform: "node",
      target: "node24",
      dts: false,
      clean: false,
      define: lanBuildDefines(identity),
      deps: {
        alwaysBundle: [
          /^effect(?:\/|$)/,
          /^@effect\/platform-node(?:-shared)?(?:\/|$)/,
          /^@t3tools\/(?:contracts|shared)(?:\/|$)/,
        ],
        onlyBundle: ["effect", "@effect/platform-node", "@effect/platform-node-shared"],
      },
    });
    const files = NodeFS.readdirSync(outDir)
      .filter((name) => name.endsWith(".mjs"))
      .sort()
      .map((name) => {
        const bytes = NodeFS.readFileSync(NodePath.join(outDir, name));
        return {
          name,
          bytes: bytes.length,
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        };
      });
    NodeFS.writeFileSync(
      NodePath.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "native-maintenance-test-build",
          release: false,
          buildLockSha256: NodeCrypto.createHash("sha256").update(lockBytes).digest("hex"),
          compiledIdentity: identity,
          files,
        },
        null,
        2,
      ),
    );
    return files;
  } finally {
    NodeFS.closeSync(ownership);
    const current = NodeFS.lstatSync(ownerLock);
    if (current.dev !== ownerIdentity.dev || current.ino !== ownerIdentity.ino)
      // eslint-disable-next-line no-unsafe-finally -- Changed lock ownership must prevent unlinking another owner's state, even after a compiler failure.
      throw new Error("Native helper build ownership changed; owner recovery is required.");
    NodeFS.unlinkSync(ownerLock);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--build-lock" ||
    args[2] !== "--identity" ||
    !args[1] ||
    !args[3] ||
    !NodePath.isAbsolute(args[1]) ||
    !NodePath.isAbsolute(args[3])
  )
    throw new Error(
      "Supply --build-lock ABSOLUTE_JSON --identity ABSOLUTE_JSON; no native runtime is started.",
    );
  await buildNativeMaintenance(
    readLanBuildPolicyFile(args[3]).identity,
    NodeFS.readFileSync(args[1]),
    NodePath.resolve(import.meta.dirname, "../../.t3/native-maintenance"),
  );
}
