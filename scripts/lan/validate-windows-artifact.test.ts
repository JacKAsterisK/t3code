// @effect-diagnostics nodeBuiltinImport:off - Local disposable file fixtures; no executable or installer is launched.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";
import { sha256 } from "./hub-distribution.ts";
import { inspectValidationTree } from "./validate-windows-artifact.ts";

it("hashes small and streamed tool files without retaining payload bytes and rejects hardlinks", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lan-tool-inventory-"));
  try {
    const small = Buffer.from("public package contents");
    const large = Buffer.alloc(256 * 1024 + 1, 42);
    await NodeFSP.writeFile(NodePath.join(root, "small"), small);
    await NodeFSP.writeFile(NodePath.join(root, "large"), large);
    const files = await inspectValidationTree(root, true);
    expect(files.size).toBe(2);
    for (const [name, bytes] of [
      ["small", small],
      ["large", large],
    ] as const)
      expect(files.get(name)).toEqual({
        bytes: new Uint8Array(),
        length: bytes.length,
        sha256: sha256(bytes),
      });
    await NodeFSP.link(NodePath.join(root, "small"), NodePath.join(root, "alias"));
    await expect(inspectValidationTree(root, true)).rejects.toThrow(/changed while opening/u);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
