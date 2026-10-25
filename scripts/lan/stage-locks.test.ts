// @effect-diagnostics nodeBuiltinImport:off - In-memory graphs and disposable local file fixtures only.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { deriveWindowsProductionStages } from "../lib/production-stage.ts";
import { populateProductionStageFixture } from "./stage-locks.fixtures.ts";
import { projectProductionStageFiles, prepareProductionStageLocks } from "./prepare-stage-locks.ts";
import {
  readWorkspaceLock,
  encodeProductionStageLock,
  verifyProductionStageLock,
  verifyProductionStageLockFiles,
} from "./stage-locks.ts";

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const object = (value: unknown): Record<string, unknown> => {
  decodeRecord(value);
  return value as Record<string, unknown>;
};
function fixture(directOverride = false) {
  const files = new Map<string, Buffer>();
  populateProductionStageFixture(files, directOverride);
  const read = (name: string) => {
    const bytes = files.get(name);
    if (!bytes) throw new Error(`Missing fixture ${name}.`);
    return bytes;
  };
  const workspace = Schema.decodeUnknownSync(fromYaml(Schema.Unknown))(
    read("pnpm-workspace.yaml").toString("utf8"),
  );
  const stages = deriveWindowsProductionStages({
    rootPackage: JSON.parse(read("package.json").toString()),
    desktopPackage: JSON.parse(read("apps/desktop/package.json").toString()),
    serverPackage: JSON.parse(read("apps/server/package.json").toString()),
    workspace,
  });
  const verify = (
    name: "desktop" | "server",
    mutate: (lock: Record<string, unknown>) => void = () => {},
  ) => {
    const lock = readWorkspaceLock(read(`scripts/lan/locks/${name}.pnpm-lock.yaml`));
    mutate(lock);
    return verifyProductionStageLock({
      stage: stages[name],
      lockBytes: encodeProductionStageLock(read("pnpm-lock.yaml"), lock),
      rootLockBytes: read("pnpm-lock.yaml"),
      readPatch: read,
      sourcePackageExtensions: {},
    });
  };
  return { files, read, verify };
}

it("projects deterministic production inputs with exact peer/native optional closure and pending package-manager proof", () => {
  const input = fixture();
  const first = projectProductionStageFiles(input.read),
    second = projectProductionStageFiles(input.read);
  NodeAssert.deepEqual(first.files, second.files);
  NodeAssert.equal(input.verify("desktop").packageManagerVerificationRequired, "pnpm@12.14.0");
  NodeAssert.equal(input.verify("server").packageManagerVerificationRequired, "pnpm@12.14.0");
  NodeAssert.equal(Object.keys(verifyProductionStageLockFiles("synthetic", input.read)).length, 2);
  const report = JSON.parse(first.files.get("preparation.json")!.toString());
  NodeAssert.equal(report.dependencyInstallExecuted, false);
  NodeAssert.equal(
    report.pinnedPackageManagerAcceptance,
    "pending-pnpm@12.14.0-frozen-offline-verification",
  );
});

it("projects direct overrides as pnpm importer specifiers without changing locked patch resolutions", () => {
  const input = fixture(true);
  const lock = readWorkspaceLock(input.read("scripts/lan/locks/server.pnpm-lock.yaml"));
  const nodePty = object(object(object(lock.importers)["."]).dependencies)["node-pty"];
  NodeAssert.equal(object(nodePty).specifier, "1.2.0-beta.15");
  NodeAssert.match(String(object(nodePty).version), /^1\.2\.0-beta\.15\(patch_hash=/u);
  NodeAssert.equal(input.verify("server").packageManagerVerificationRequired, "pnpm@12.14.0");
});

it("rejects dropped native optional edges, fabricated peer contexts and changed complete package metadata", () => {
  const input = fixture();
  NodeAssert.throws(
    () =>
      input.verify("server", (lock) => {
        object(object(lock.snapshots)["@ff-labs/fff-node@0.11.0"]).optionalDependencies = {};
      }),
    /snapshot\/peer context/u,
  );
  NodeAssert.throws(
    () =>
      input.verify("desktop", (lock) => {
        const entry = object(object(object(lock.importers)["."]).dependencies);
        object(entry["playwright-core"]).version = "1.60.0(peer-fixture@9.0.0)";
      }),
    /root resolution/u,
  );
  for (const field of ["libc", "engines", "peerDependenciesMeta"])
    NodeAssert.throws(
      () =>
        input.verify("server", (lock) => {
          object(object(lock.packages)["native-fixture@1.0.0"])[field] = { tampered: true };
        }),
      /metadata differs/u,
    );
});

it("rejects hidden configuration, importer extras, rewritten patch representations and changed patch bytes", () => {
  const input = fixture();
  NodeAssert.throws(
    () =>
      input.verify("server", (lock) => {
        const patches = object(lock.patchedDependencies),
          key = Object.keys(patches)[0]!;
        patches[key] = { hash: patches[key], path: "unexpected.patch" };
      }),
    /patch bytes/u,
  );
  NodeAssert.throws(
    () =>
      input.verify("desktop", (lock) => {
        lock.unreviewedSetting = true;
      }),
    /exact root projection/u,
  );
  NodeAssert.throws(
    () =>
      input.verify("desktop", (lock) => {
        object(object(lock.importers)["."]).unreviewedSetting = true;
      }),
    /exact root projection/u,
  );
  NodeAssert.throws(
    () =>
      input.verify("desktop", (lock) => {
        lock.packageExtensionsChecksum = "invented";
      }),
    /checksum/u,
  );
  input.files.set("patches/fixture-node-pty.patch", Buffer.from("changed"));
  NodeAssert.throws(() => input.verify("server"), /patch bytes/u);
});

it("requires the exact bootstrap and graph documents instead of accepting ignored resolver material", () => {
  const input = fixture();
  const stage = input.read("scripts/lan/locks/desktop.pnpm-lock.yaml");
  NodeAssert.throws(
    () => readWorkspaceLock(Buffer.concat([Buffer.from("unreviewed: true\n---\n"), stage])),
    /exactly two documents/u,
  );
  NodeAssert.throws(() =>
    readWorkspaceLock(Buffer.from("lockfileVersion: '9.0'\nsettings: {}\nsettings: {}\n")),
  );
  NodeAssert.throws(
    () =>
      verifyProductionStageLockFiles("synthetic", (name) => {
        const bytes = input.read(name);
        return name === "scripts/lan/locks/desktop.pnpm-lock.yaml"
          ? Buffer.from(bytes.toString().replace("sha512-AQEB", "sha512-AAAA"))
          : bytes;
      }),
    /bootstrap differs/u,
  );
});

it("preserves root YAML entry bytes and ordering so frozen pnpm does not reformat projected metadata", () => {
  const input = fixture();
  input.files.set(
    "pnpm-lock.yaml",
    Buffer.from(
      input
        .read("pnpm-lock.yaml")
        .toString()
        .replaceAll('lockfileVersion: "9.0"', "lockfileVersion: '9.0'")
        .replaceAll(/resolution:\n      integrity: (\S+)/gu, "resolution: {integrity: $1}"),
    ),
  );
  const projection = projectProductionStageFiles(input.read);
  const output = projection.files.get("desktop.pnpm-lock.yaml")!.toString();
  NodeAssert.ok(output.startsWith("---\nlockfileVersion: '9.0'\n"));
  NodeAssert.match(output, /resolution: \{integrity: sha512-/u);
});

it("refuses duplicate keys and unsupported multiline block headers before projecting raw YAML", () => {
  for (const insertion of ["settings: {}\n", '"unreviewed\n  header": true\n']) {
    const input = fixture();
    input.files.set(
      "pnpm-lock.yaml",
      Buffer.from(
        input.read("pnpm-lock.yaml").toString().replace("settings:\n", `${insertion}settings:\n`),
      ),
    );
    NodeAssert.throws(() => projectProductionStageFiles(input.read));
  }
});

it("preserves pnpm's explicit long-key mapping boundaries without treating the value line as an entry", () => {
  const input = fixture();
  input.files.set(
    "pnpm-lock.yaml",
    Buffer.from(
      input
        .read("pnpm-lock.yaml")
        .toString()
        .replace(
          "  playwright-core@1.60.0(peer-fixture@1.0.0):\n    dependencies:\n",
          "  ? playwright-core@1.60.0(peer-fixture@1.0.0)\n  : dependencies:\n",
        ),
    ),
  );
  const output = projectProductionStageFiles(input.read).files.get("desktop.pnpm-lock.yaml")!;
  NodeAssert.match(output.toString(), /\n  \? playwright-core@1\.60\.0/u);
  NodeAssert.ok(readWorkspaceLock(output).snapshots);
});

it.effect(
  "writes only new projected files and preserves existing outputs on repeated preparation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lan-stage-write-fixture-" });
        const input = fixture();
        yield* Effect.promise(async () => {
          for (const [name, bytes] of input.files) {
            if (name.startsWith("scripts/lan/locks/")) continue;
            const file = path.join(root, ...name.split("/"));
            await NodeFSP.mkdir(path.dirname(file), { recursive: true });
            await NodeFSP.writeFile(file, bytes);
          }
          await NodeFSP.mkdir(path.join(root, "scripts", "lan"), { recursive: true });
          NodeAssert.equal((await prepareProductionStageLocks(root, true)).mode, "write-new-only");
          NodeAssert.equal((await prepareProductionStageLocks(root)).mode, "check");
          const output = path.join(root, "scripts", "lan", "locks", "desktop.pnpm-lock.yaml");
          const before = await NodeFSP.readFile(output);
          await NodeAssert.rejects(() => prepareProductionStageLocks(root, true));
          NodeAssert.deepEqual(await NodeFSP.readFile(output), before);
          await NodeFSP.appendFile(output, "\nchanged: true\n");
          await NodeAssert.rejects(() => prepareProductionStageLocks(root), /stale/u);
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
