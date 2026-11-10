// @effect-diagnostics nodeBuiltinImport:off - Builds the offline repair helper into a temporary directory and runs it with refused arguments; no home is read or changed.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { buildHomeRepair } from "./home-repair.pack.ts";

it.live("packs the repair helper as one module that loads on its own", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lan-home-repair-pack-"));
    try {
      const out = NodePath.join(NodePath.resolve(root), "repair");
      await buildHomeRepair(out);
      // Packaging copies only native-home-repair*.mjs/json; any other module would be left behind.
      expect((await NodeFSP.readdir(out)).toSorted()).toEqual([
        "native-home-repair-build.json",
        "native-home-repair-policy.json",
        "native-home-repair.contract.json",
        "native-home-repair.fixture.json",
        "native-home-repair.mjs",
        "native-home-repair.schema.json",
      ]);
      const run = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [NodePath.join(out, "native-home-repair.mjs"), "--invalid"],
          { cwd: out, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString()));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stderr }));
      });
      expect(run).toEqual({ code: 1, stderr: "native_home_repair_refused\n" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);
