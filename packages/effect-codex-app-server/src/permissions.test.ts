import { assert, it } from "@effect/vitest";
import { inspectPermissionRequest, CODEX_PERMISSION_VERSION } from "./permissions.ts";
const raw = {
  cwd: "/repo",
  itemId: "item",
  threadId: "thread",
  turnId: "turn",
  startedAtMs: 1,
  permissions: {
    network: { enabled: true },
    fileSystem: { read: ["/repo"], write: ["/tmp/output"] },
  },
};
it("retains the complete verified native permission and rejects unknown authority recursively", () => {
  assert.deepEqual(inspectPermissionRequest(raw, CODEX_PERMISSION_VERSION), {
    supported: true,
    profile: "codex-permissions-687a119f-v1",
    providerVersion: "0.159.0",
    raw,
  });
  const variants = [
    { ...raw, newAuthority: true },
    { ...raw, permissions: { ...raw.permissions, secretRoot: "/" } },
    { ...raw, permissions: { network: { ...raw.permissions.network, hosts: ["*"] } } },
    { ...raw, permissions: { fileSystem: { ...raw.permissions.fileSystem, recursive: true } } },
    {
      ...raw,
      permissions: {
        fileSystem: {
          entries: [{ access: "write", path: { type: "path", path: "/", hidden: true } }],
        },
      },
    },
    {
      ...raw,
      permissions: {
        fileSystem: {
          entries: [
            { access: "write", path: { type: "special", value: { kind: "root", hidden: true } } },
          ],
        },
      },
    },
  ];
  for (const request of variants)
    assert.equal(inspectPermissionRequest(request, CODEX_PERMISSION_VERSION).supported, false);
  for (const version of [undefined, "0.158.0", "0.159.1", "0.159.0-custom"])
    assert.equal(inspectPermissionRequest(raw, version).supported, false);
});
