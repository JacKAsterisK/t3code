// @effect-diagnostics nodeBuiltinImport:off -- Native admission tests use isolated filesystem fixtures and real inode/link behavior.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  NativeAdmissionError,
  acquireNativeAdmission,
  acquireNativeAdmissionScoped,
  resolveNativeAdmissionPaths,
} from "./nativeAdmission.ts";

const isNativeAdmissionError = Schema.is(NativeAdmissionError);

const fixture = Effect.acquireRelease(
  Effect.sync(() =>
    NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-admission-"))),
  ),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

function refused(home: string, reason: NativeAdmissionError["reason"]) {
  assert.throws(() => {
    try {
      acquireNativeAdmission(home).close();
    } catch (cause) {
      if (isNativeAdmissionError(cause)) assert.equal(cause.reason, reason);
      throw cause;
    }
  }, NativeAdmissionError);
}

describe("native startup admission", () => {
  it.effect("retains the same lock inode and contents across concurrent ordinary writers", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const lock = resolveNativeAdmissionPaths(root).lockPath;
      NodeFS.writeFileSync(lock, "never truncate or unlink");
      const before = NodeFS.statSync(lock);
      yield* acquireNativeAdmissionScoped(root);
      const another = acquireNativeAdmission(root);
      another.close();
      another.close();
      assert.equal(NodeFS.readFileSync(lock, "utf8"), "never truncate or unlink");
      assert.equal(NodeFS.statSync(lock).ino, before.ino);
    }).pipe(Effect.scoped),
  );

  it.effect("blocks every home with an unresolved native journal", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const paths = resolveNativeAdmissionPaths(root);
      NodeFS.writeFileSync(paths.journalPaths[0]!, "interrupted activation");
      refused(root, "recovery_required");
      assert.equal(NodeFS.readFileSync(paths.journalPaths[0]!, "utf8"), "interrupted activation");
    }).pipe(Effect.scoped),
  );

  it.effect("also blocks the Hub journal for its managed data home", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const home = NodePath.join(root, "T3CodeLAN", "data");
      NodeFS.mkdirSync(home, { recursive: true });
      const journal = NodePath.join(root, "T3CodeLAN", "activation.json");
      NodeFS.writeFileSync(journal, "reviewed recovery required");
      refused(home, "recovery_required");
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, "userdata")));
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a hard-linked admission file without modifying either link", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const lock = resolveNativeAdmissionPaths(root).lockPath;
      const other = NodePath.join(root, "other-file");
      NodeFS.writeFileSync(other, "preserved");
      NodeFS.linkSync(other, lock);
      refused(root, "unsafe_path");
      assert.equal(NodeFS.readFileSync(other, "utf8"), "preserved");
      assert.equal(NodeFS.statSync(other).nlink, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects linked ancestors before creating a lock in their target", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const target = NodePath.join(root, "target");
      const link = NodePath.join(root, "home-link");
      NodeFS.mkdirSync(target);
      NodeFS.symlinkSync(target, link, "junction");
      refused(NodePath.join(link, "nested-home"), "unsafe_path");
      assert.deepEqual(NodeFS.readdirSync(target), []);
    }).pipe(Effect.scoped),
  );

  it("rejects relative homes before filesystem access", () => {
    refused("relative-home", "unsafe_path");
  });
});
