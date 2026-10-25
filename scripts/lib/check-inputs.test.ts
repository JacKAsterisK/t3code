// @effect-diagnostics nodeBuiltinImport:off -- Disposable file/junction fixture only; never selects an installed application's data.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";
import { generatedCheckInputs } from "./check-inputs.ts";

it("retains generated sources, declarations and env inputs without following dependency or directory-link cycles", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-check-inputs-"));
  try {
    const included = [
      ".env",
      "apps/web/.generated/schema.ts",
      "apps/web/.astro/route.json",
      "packages/shared/env.d.ts",
    ];
    const excluded = [
      "apps/web/index.ts",
      "node_modules/vendor/env.d.ts",
      "apps/web/node_modules/vendor/.env",
      ".repos/vendor/env.d.ts",
      "native/resource-monitor/target/env.d.ts",
    ];
    for (const file of [...included, ...excluded]) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, file), "fixture");
    }
    await NodeFSP.mkdir(NodePath.join(root, "cycle"));
    await NodeFSP.symlink(root, NodePath.join(root, "cycle", "again"), "junction");
    expect(generatedCheckInputs(root)).toEqual(included.sort());
    await NodeFSP.writeFile(NodePath.join(root, "apps/web/.generated/new.ts"), "new fixture");
    expect(generatedCheckInputs(root)).toContain("apps/web/.generated/new.ts");
  } finally {
    if (!NodePath.resolve(root).startsWith(NodePath.resolve(NodeOS.tmpdir()) + NodePath.sep))
      throw new Error("Check fixture escaped its temporary root");
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
