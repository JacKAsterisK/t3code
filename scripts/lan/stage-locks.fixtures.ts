import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { sha256 } from "./hub-distribution.ts";
import { projectProductionStageFiles } from "./prepare-stage-locks.ts";

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const yaml = Schema.encodeSync(fromYaml(Schema.Unknown));

export function populateProductionStageFixture(files: Map<string, Buffer>) {
  const merge = (path: string, value: Record<string, unknown>) => {
    const existing = files.get(path);
    const original = existing === undefined ? {} : JSON.parse(existing.toString("utf8"));
    files.set(path, json({ ...original, ...value }));
  };
  merge("package.json", { packageManager: "pnpm@12.14.0", engines: { node: "26.12.1" } });
  merge("apps/desktop/package.json", {
    version: "0.1.2",
    dependencies: { electron: "44.9.3", "playwright-core": "1.60.0" },
  });
  merge("apps/server/package.json", {
    version: "0.1.2",
    dependencies: { "@ff-labs/fff-node": "0.11.0", "node-pty": "^1.2.0-beta.15" },
  });
  const patchPath = "patches/fixture-node-pty.patch",
    patch = Buffer.from("synthetic reviewed patch bytes");
  files.set(patchPath, patch);
  const hash = sha256(patch),
    nodePty = `1.2.0-beta.15(patch_hash=${hash})`;
  files.set(
    "pnpm-workspace.yaml",
    Buffer.from(yaml({ patchedDependencies: { "node-pty@1.2.0-beta.15": patchPath } })),
  );
  const pin = (specifier: string, version = specifier) => ({ specifier, version });
  const integrity = { integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` };
  const packages = Object.fromEntries(
    [
      "electron@44.9.3",
      "playwright-core@1.60.0",
      "peer-fixture@1.0.0",
      "@ff-labs/fff-node@0.11.0",
      "@ff-labs/fff-bin-win32-x64@0.11.0",
      "node-pty@1.2.0-beta.15",
      "native-fixture@1.0.0",
    ].map((name) => [
      name,
      {
        resolution: { ...integrity },
        ...(name === "native-fixture@1.0.0"
          ? { os: ["win32"], cpu: ["x64"], libc: ["synthetic"] }
          : {}),
      },
    ]),
  );
  files.set(
    "pnpm-lock.yaml",
    Buffer.from(
      `---\n${yaml({
        lockfileVersion: "9.0",
        importers: {
          ".": { configDependencies: {}, packageManagerDependencies: { pnpm: pin("12.14.0") } },
        },
        packages: { "pnpm@12.14.0": { resolution: integrity } },
        snapshots: { "pnpm@12.14.0": {} },
      })}---\n${yaml({
        lockfileVersion: "9.0",
        settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
        patchedDependencies: { "node-pty@1.2.0-beta.15": hash },
        importers: {
          "apps/desktop": {
            dependencies: {
              electron: pin("44.9.3"),
              "playwright-core": pin("1.60.0", "1.60.0(peer-fixture@1.0.0)"),
            },
          },
          "apps/server": {
            dependencies: {
              "@ff-labs/fff-node": pin("0.11.0"),
              "node-pty": pin("^1.2.0-beta.15", nodePty),
            },
          },
        },
        packages,
        snapshots: {
          "electron@44.9.3": {},
          "playwright-core@1.60.0(peer-fixture@1.0.0)": {
            dependencies: { "peer-fixture": "1.0.0" },
          },
          "peer-fixture@1.0.0": {},
          "@ff-labs/fff-node@0.11.0": {
            optionalDependencies: { "@ff-labs/fff-bin-win32-x64": "0.11.0" },
          },
          "@ff-labs/fff-bin-win32-x64@0.11.0": {},
          [`node-pty@${nodePty}`]: { optionalDependencies: { "native-fixture": "1.0.0" } },
          "native-fixture@1.0.0": {},
        },
      })}`,
    ),
  );
  const projection = projectProductionStageFiles((name) => {
    const bytes = files.get(name);
    if (!bytes) throw new Error(`Missing synthetic stage input ${name}.`);
    return bytes;
  });
  for (const [name, bytes] of projection.files) files.set(`scripts/lan/locks/${name}`, bytes);
}
