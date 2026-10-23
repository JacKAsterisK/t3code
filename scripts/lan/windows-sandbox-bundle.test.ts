// @effect-diagnostics nodeBuiltinImport:off - Compiles and imports a nonrelease bootstrap fixture; no guest, native build, dependency install or provider process is started.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { windowsSandboxGuestBundleOptions } from "./windows-sandbox-guest.pack.ts";

it.live(
  "imports a self-contained bootstrap and crosses into a working runtime with the same private issuers and Effect services",
  () =>
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-lan-sandbox-bundle-fixture-"),
      );
      const cleanup = async () => {
        const base = NodePath.resolve(NodeOS.tmpdir()) + NodePath.sep;
        if (!NodePath.resolve(root).startsWith(base))
          throw new Error("Bundle fixture escaped its captured temporary root.");
        await NodeFSP.rm(root, { recursive: true, force: true });
      };
      try {
        const out = NodePath.join(root, "bundle");
        await NodeFSP.mkdir(out);
        await build(
          windowsSandboxGuestBundleOptions(NodePath.resolve(import.meta.dirname, "../.."), out),
        );
        expect(await NodeFSP.readdir(out)).toEqual(["guest-runner.mjs"]);
        const bundle = (await import(
          /* @vite-ignore */ NodeURL.pathToFileURL(NodePath.join(out, "guest-runner.mjs")).href
        )) as typeof import("./windows-sandbox-guest.ts");
        expect(typeof bundle.runWindowsSandboxGuest).toBe("function");
        const source = NodePath.join(root, "working");
        const lan = NodePath.join(source, "scripts", "lan");
        await NodeFSP.mkdir(lan, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(lan, "windows-sandbox-context.ts"),
          `
      const contexts = new WeakSet();
      export async function establishWindowsSandboxContext(binding) {
        const context = Object.freeze({...binding}); contexts.add(context); return context;
      }
      export function assertContext(context) { if (!contexts.has(context)) throw new Error('foreign context issuer'); }
    `,
        );
        await NodeFSP.writeFile(
          NodePath.join(lan, "windows-build-execution.ts"),
          `
      import {assertContext} from './windows-sandbox-context.ts';
      const services = new WeakSet();
      export function createWindowsBuildExecution(input) {
        assertContext(input.isolation); const service = Object.freeze({context:input.isolation}); services.add(service); return service;
      }
      export function assertWindowsBuildExecution(service) { if (!services.has(service)) throw new Error('foreign execution issuer'); }
    `,
        );
        await NodeFSP.writeFile(
          NodePath.join(source, "scripts", "build-desktop-artifact.ts"),
          `
      import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
      import * as FileSystem from ${JSON.stringify(import.meta.resolve("effect/FileSystem"))};
      import {assertWindowsBuildExecution} from './lan/windows-build-execution.ts';
      export const runIsolatedWindowsDesktopBuild = (service, paths) => Effect.gen(function*() {
        assertWindowsBuildExecution(service);
        const fs = yield* FileSystem.FileSystem;
        return {sameIssuer:true, filesystem:typeof fs.readFile === 'function', policy:paths.policyPath};
      });
    `,
        );
        const result = await bundle.runWorkingWindowsBuild({
          sourceRoot: source,
          factoryInput: {
            approvedRequestSha256: "a".repeat(64),
            requestBytes: new Uint8Array(),
            lockBytes: new Uint8Array(),
            identityBytes: new Uint8Array(),
            toolchainManifestBytes: new Uint8Array(),
            toolchainFiles: new Map(),
            nodeHeaderFiles: { nodeVersionH: new Uint8Array(), configGypi: new Uint8Array() },
            verifyUnchanged: async () => {},
          },
          binding: {
            sourceCommit: "a".repeat(40),
            snapshotSha256: "b".repeat(64),
            preparationRequestSha256: "c".repeat(64),
          },
          policyPath: "fixture-identity.json",
          buildLockPath: "fixture-lock.json",
        });
        expect(result).toEqual({
          sameIssuer: true,
          filesystem: true,
          policy: "fixture-identity.json",
        });
      } finally {
        await cleanup();
      }
    }),
);
