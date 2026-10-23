// @effect-diagnostics nodeBuiltinImport:off - Disposable filesystem fixtures only; the helper compiler is never invoked.
import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeFS from "node:fs";
import { sha256 } from "./hub-distribution.ts";
import { assertOwnedNativeHelperFile, inspectNativeHelperOutput } from "./native-helper-output.ts";

it.effect("refuses and preserves existing foreign files before any helper output cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lan-output-guard-fixture-" });
      const output = path.join(root, "foreign-output");
      yield* fs.makeDirectory(output);
      const file = path.join(output, "preserve.txt");
      yield* fs.writeFileString(file, "existing user data");
      assert.throws(() => inspectNativeHelperOutput(output, root), /foreign/u);
      assert.equal(yield* fs.readFileString(file), "existing user data");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rechecks output changed before lock acquisition and refuses changed owned cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lan-output-lock-fixture-" });
      const output = path.join(root, ".t3", "native-maintenance");
      yield* fs.makeDirectory(output, { recursive: true });
      const file = path.join(output, "native-maintenance.mjs");
      const contents = "synthetic helper fixture";
      yield* fs.writeFileString(file, contents);
      yield* fs.writeFileString(
        path.join(output, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "native-maintenance-test-build",
          release: false,
          files: [
            { name: "native-maintenance.mjs", bytes: contents.length, sha256: sha256(contents) },
          ],
        }),
      );
      const before = inspectNativeHelperOutput(output, root);
      const lock = NodeFS.openSync(path.join(output, ".native-helper-build.lock"), "wx");
      try {
        const identity = NodeFS.fstatSync(lock);
        NodeFS.writeFileSync(file, "concurrent foreign content");
        assert.throws(() => inspectNativeHelperOutput(output, root, identity), /changed/u);
        assert.throws(() => assertOwnedNativeHelperFile(before[1]!), /changed/u);
        assert.equal(NodeFS.readFileSync(file, "utf8"), "concurrent foreign content");
        NodeFS.writeFileSync(file, contents);
        const owned = inspectNativeHelperOutput(output, root, identity);
        assert.equal(owned.length, 2);
        NodeFS.renameSync(file, path.join(root, "original.fixture"));
        NodeFS.writeFileSync(file, contents);
        assert.throws(() => assertOwnedNativeHelperFile(owned[1]!), /changed/u);
        assert.equal(NodeFS.readFileSync(file, "utf8"), contents);
      } finally {
        NodeFS.closeSync(lock);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
