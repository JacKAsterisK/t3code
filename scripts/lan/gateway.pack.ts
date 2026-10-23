// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - This build-only CLI validates its output directory and serializes public artifact hashes, never runtime credentials.
import { build } from "vite-plus/pack";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

const root = NodePath.resolve(import.meta.dirname, "../..");
const outDir = NodePath.join(root, ".t3", "lan-gateway");
for (const directory of [NodePath.dirname(outDir), outDir]) {
  if (NodeFS.existsSync(directory) && NodeFS.lstatSync(directory).isSymbolicLink()) {
    throw new Error("Gateway artifacts must stay in the checkout's own output directory.");
  }
}

await build({
  config: false,
  entry: [
    NodePath.join(root, "apps/server/src/lan/GatewayTaskSurface.ts"),
    NodePath.join(root, "apps/server/src/lan/GatewayT3OAuthClient.ts"),
  ],
  outDir,
  format: "esm",
  platform: "node",
  target: "node24",
  dts: false,
  clean: true,
  deps: {
    alwaysBundle: [/^effect(?:\/|$)/, /^@t3tools\/contracts(?:\/|$)/],
    onlyBundle: ["effect"],
  },
});

await import(NodeURL.pathToFileURL(NodePath.join(outDir, "GatewayT3OAuthClient.mjs")).href);
await import(NodeURL.pathToFileURL(NodePath.join(outDir, "GatewayTaskSurface.mjs")).href);
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
      formatVersion: 1,
      kind: "unconfigured-local-gateway",
      release: false,
      importVerified: true,
      nodeVersion: process.version,
      files,
    },
    null,
    2,
  ),
);
