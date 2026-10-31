import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { findOwnedLauncher, spawnWindowsRemoval } from "./uninstall.ts";

it.layer(NodeServices.layer)("t3 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const platform = yield* HostProcess.Platform;
      const executable = platform === "win32" ? "t3.exe" : "t3";
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0", executable);
      const otherExe = path.join(root, "other/runtime/versions/1.0.0", executable);
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin", platform === "win32" ? "t3.cmd" : "t3");
      const theirs = path.join(root, "other/bin", platform === "win32" ? "t3.cmd" : "t3");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      if (platform === "win32") {
        yield* fs.writeFileString(ours, `@echo off\r\n"${exe}" %*`);
        yield* fs.writeFileString(theirs, `@echo off\r\n"${otherExe}" %*`);
      } else {
        yield* fs.symlink(exe, ours);
        yield* fs.symlink(otherExe, theirs);
      }
      const find = (launchedAs: string | undefined) =>
        findOwnedLauncher({ launchedAs, versionsDir }).pipe(
          Effect.provideService(HostProcess.Environment, {
            PATH: [path.dirname(ours), path.dirname(theirs)].join(";"),
          }),
        );

      assert.equal(yield* find(platform === "win32" ? exe : ours), ours);
      assert.isUndefined(yield* find(platform === "win32" ? otherExe : theirs));
      assert.isUndefined(yield* find(copy));
      assert.isUndefined(yield* find(undefined));
    }).pipe(Effect.scoped),
  );
});

it.live.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "t3 uninstall has cmd.exe remove the runtime directory, preserving spaces and literal environment-variable syntax",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const runtimeDir = path.join(root, "t3 home %COMSPEC% !COMSPEC! & data", "runtime");
      yield* fs.makeDirectory(path.join(runtimeDir, "versions", "1.0.0"), { recursive: true });
      yield* fs.writeFileString(path.join(runtimeDir, "versions", "1.0.0", "t3.exe"), "");

      const child = spawnWindowsRemoval(process.env.ComSpec ?? "cmd.exe", runtimeDir);
      yield* Effect.callback<void, Error>((resume) => {
        child.once("error", (error) => resume(Effect.fail(error)));
        child.once("exit", (code) =>
          resume(code === 0 ? Effect.void : Effect.die(`cmd.exe exited with ${code}`)),
        );
      });

      assert.isFalse(yield* fs.exists(runtimeDir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
