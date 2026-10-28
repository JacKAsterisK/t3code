// @effect-diagnostics nodeBuiltinImport:off -- Explicit offline staging only; no installed home is changed.
import { build } from "vite-plus/pack";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export async function buildHomeRepair(outDir: string) {
  if (!NodePath.isAbsolute(outDir) || NodePath.resolve(outDir) !== outDir)
    throw new Error("Use a canonical absolute staging directory.");
  for (let at = outDir; ;) {
    if (NodeFS.existsSync(at)) {
      const stat = NodeFS.lstatSync(at);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Repair helper staging refuses redirected paths.");
    }
    const parent = NodePath.dirname(at);
    if (parent === at) break;
    at = parent;
  }
  if (NodeFS.existsSync(outDir) && NodeFS.readdirSync(outDir).length)
    throw new Error("Repair helper staging must be empty; existing output is never cleaned.");
  NodeFS.mkdirSync(outDir, { recursive: true });
  const root = NodePath.resolve(import.meta.dirname, "../..");
  await build({
    config: false,
    cwd: root,
    entry: { "native-home-repair": NodePath.join(import.meta.dirname, "home-repair-native.ts") },
    outDir,
    format: "esm",
    platform: "node",
    target: "node24",
    clean: false,
    sourcemap: false,
    dts: false,
    deps: {
      alwaysBundle: [/.*/],
      // Normal event projection imports parser utilities; the offline artifact must have no package dependencies.
      onlyBundle: [/.*/],
    },
  });
  for (const name of ["schema", "fixture", "contract"])
    NodeFS.copyFileSync(
      NodePath.join(import.meta.dirname, `home-repair.${name}.json`),
      NodePath.join(outDir, `native-home-repair.${name}.json`),
      NodeFS.constants.COPYFILE_EXCL,
    );
  const digest = (name: string) =>
    NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(NodePath.join(outDir, name)))
      .digest("hex");
  NodeFS.writeFileSync(
    NodePath.join(outDir, "native-home-repair-policy.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "native-home-repair-policy-fragment",
        approval: false,
        homeRepair: {
          interfaceVersion: 1,
          admission: "hub-held-windows-handles-v1",
          defaultHomeMode: "drop-in",
          contractSha256: digest("native-home-repair.contract.json"),
          schemaSha256: digest("native-home-repair.schema.json"),
        },
        reviewedComponents: [
          {
            role: "native-home-repair",
            location: "resources/native-home-repair.mjs",
            sha256: digest("native-home-repair.mjs"),
          },
        ],
        requiredTestReceiptChecks: [
          "focused-tests",
          "windows-smoke",
          "home-selection-and-retention",
          "retained-lan-history-import",
        ],
        requiredRuntimePolicyChecks: [
          "default-home-selection",
          "native-updater-disabled",
          "cloud-disabled",
          "telemetry-disabled",
        ],
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  const files = NodeFS.readdirSync(outDir)
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
    NodePath.join(outDir, "native-home-repair-build.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "native-home-repair-build",
        interfaceVersion: 1,
        release: false,
        applySupported: true,
        operations: [
          "preview",
          "apply",
          "import-retained-lan-history",
          "recover-import-retained-lan-history",
          "adopt-original-with-work",
          "recover-adopt-original-with-work",
          "retain-selected-lan",
          "recover-retain-selected-lan",
          "rollback",
          "recover",
          "cancel-original-work",
          "rollback-work-cancellation",
          "recover-work-cancellation",
        ],
        admission: "hub-held-windows-handles-v1",
        files,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  return files;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out-dir" || !args[1])
    throw new Error("Usage: home-repair.pack --out-dir <absolute empty staging directory>");
  await buildHomeRepair(args[1]);
}
