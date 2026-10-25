import { expect, it } from "vite-plus/test";
import { parseToolchainManifest } from "./windows-artifact.ts";

const manifest = (sha256 = "a".repeat(64)) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      files: [{ path: "fixture/entry", length: 3, sha256 }],
    }),
  );

it("reuses only deeply frozen manifest values keyed by all current bytes", () => {
  const bytes = manifest();
  const first = parseToolchainManifest(bytes);
  expect(parseToolchainManifest(Buffer.from(bytes))).toBe(first);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.files)).toBe(true);
  expect(Object.isFrozen(first.files[0])).toBe(true);
  expect(() => Object.assign(first.files[0]!, { length: 4 })).toThrow();
  bytes.set(manifest("b".repeat(64)));
  const changed = parseToolchainManifest(bytes);
  expect(changed).not.toBe(first);
  expect(changed.files[0]!.sha256).toBe("b".repeat(64));
  expect(first.files[0]!.sha256).toBe("a".repeat(64));
});

it("does not reuse valid decoding for changed malformed or duplicate-key bytes", () => {
  parseToolchainManifest(manifest());
  expect(() =>
    parseToolchainManifest(Buffer.from('{"schemaVersion":1,"schemaVersion":1,"files":[]}')),
  ).toThrow();
  const extra = JSON.parse(manifest().toString());
  extra.unreviewed = true;
  expect(() => parseToolchainManifest(Buffer.from(JSON.stringify(extra)))).toThrow();
  expect(parseToolchainManifest(manifest()).files).toHaveLength(1);
});
