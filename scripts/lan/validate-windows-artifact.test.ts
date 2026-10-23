// @effect-diagnostics nodeBuiltinImport:off - Local disposable file fixtures; no executable or installer is launched.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";
import { sha256 } from "./hub-distribution.ts";
import { inspectValidationTree } from "./validate-windows-artifact.ts";

it("hashes several batches of empty, binary and streamed tool files and rejects hardlinks", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lan-tool-inventory-"));
  try {
    const small = Buffer.from("public package contents");
    const large = Buffer.alloc(256 * 1024 + 1, 42);
    await NodeFSP.writeFile(NodePath.join(root, "small"), small);
    await NodeFSP.writeFile(NodePath.join(root, "large"), large);
    const nested = NodePath.join(root, "nested");
    await NodeFSP.mkdir(nested);
    for (let index = 0; index < 70; index++)
      await NodeFSP.writeFile(
        NodePath.join(nested, `tiny-${index.toString().padStart(2, "0")}`),
        index % 2 === 0 ? new Uint8Array() : new Uint8Array([index, 0, 255, 13, 10]),
      );
    const files = await inspectValidationTree(root, true);
    expect(files.size).toBe(72);
    for (const [name, bytes] of [
      ["small", small],
      ["large", large],
    ] as const)
      expect(files.get(name)).toEqual({
        bytes: new Uint8Array(),
        length: bytes.length,
        sha256: sha256(bytes),
      });
    const payload = await inspectValidationTree(root);
    expect([...files.keys()]).toEqual([...payload.keys()]);
    for (const [name, pin] of files) {
      const original = payload.get(name)!;
      expect(pin).toEqual({
        bytes: new Uint8Array(),
        length: original.bytes.length,
        sha256: sha256(original.bytes),
      });
    }
    await NodeFSP.link(NodePath.join(root, "small"), NodePath.join(root, "alias"));
    await expect(inspectValidationTree(root, true)).rejects.toThrow(/changed while opening/u);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
