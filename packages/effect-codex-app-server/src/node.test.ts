// @effect-diagnostics nodeBuiltinImport:off -- Native fake handles verify stale-PID safety without signaling real processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { vi } from "vite-plus/test";
vi.mock("node:child_process", { spy: true });
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { ChildProcess } from "effect/process";
import { makeNodeClient } from "./node.ts";
import { acknowledgedResponse } from "./protocol.ts";
import type { NativeWriteResult } from "./_internal/stdio.ts";

it.live(
  "the owned spawn bridge writes exact accept/decline native responses on one persistent stdin",
  () =>
    Effect.gen(function* () {
      const client = yield* makeNodeClient(
        ChildProcess.make(
          process.execPath,
          [`${import.meta.dirname}/../test/fixtures/codex-app-server-mock-peer.ts`],
          { env: { ...process.env, CODEX_APP_SERVER_TEST_PERMISSION_PROFILE: "1" } },
        ),
        {
          platform: yield* HostProcess.Platform,
          onSpawn: (pid) => Console.log(JSON.stringify({ proof: "native_process", pid })),
        },
      );
      yield* client.request("initialize", {
        clientInfo: { name: "approval-harness", version: "1" },
      });
      const written = yield* Queue.unbounded<NativeWriteResult>();
      let count = 0;
      yield* client.handleServerRequest("item/permissions/requestApproval", (payload, context) => {
        assert.equal(context.permissionEvidence?.supported, true);
        const value = {
          permissions: count++ === 0 ? payload.permissions : {},
          scope: "turn" as const,
        };
        return Effect.succeed(
          acknowledgedResponse(value, `approval:fixture:${count}`, (outcome) =>
            Queue.offer(written, outcome).pipe(Effect.asVoid),
          ),
        );
      });
      const permissions = {
        network: { enabled: true },
        fileSystem: { read: ["/repo"], write: ["/tmp/output"] },
      };
      for (const index of [0, 1]) {
        const value = yield* client.raw.request("test/permission", {
          cwd: "/repo",
          itemId: `item-${index}`,
          threadId: "thread",
          turnId: "turn",
          startedAtMs: 1,
          permissions,
        });
        assert.deepEqual(value, {
          nativeResponse: { permissions: index === 0 ? permissions : {}, scope: "turn" },
        });
        const evidence = yield* Queue.take(written);
        assert.equal(evidence.state, "response_written");
        assert.equal(evidence.boundary, "node_write_callback");
        yield* Console.log(
          JSON.stringify({ proof: "native_write", ...evidence, nativeReply: value }),
        );
      }
    }).pipe(Effect.scoped),
);

it.live("closing the owned spawn bridge terminates native tool descendants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const client = yield* makeNodeClient(
        ChildProcess.make(process.execPath, [
          `${import.meta.dirname}/../test/fixtures/codex-app-server-mock-peer.ts`,
        ]),
        { platform: yield* HostProcess.Platform },
      ).pipe(Effect.provideService(Scope.Scope, scope));
      const result = yield* client.raw.request("test/spawnChild", {});
      const pid = (result as { pid: number }).pid;
      assert.isNumber(pid);
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (alive()) process.kill(pid, "SIGKILL");
        }),
      );
      assert.isTrue(alive());
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(alive(), "native tool process must not outlive its Codex session");
      yield* Console.log(
        JSON.stringify({ proof: "native_tree_cleanup", descendantPid: pid, alive: false }),
      );
    }),
  ),
);

it.effect.each(["win32", "linux"] as const)(
  "does not signal an exited leader on %s when its PID is no longer owned",
  (platform) =>
    Effect.gen(function* () {
      const child = Object.assign(new NodeEvents.EventEmitter(), {
        pid: 43210,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdin: new NodeStream.PassThrough(),
        stdout: new NodeStream.PassThrough(),
        stderr: new NodeStream.PassThrough(),
        kill: vi.fn(),
      });
      using spawn = vi.spyOn(NodeChildProcess, "spawn").mockImplementation(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams;
      });
      using taskkill = vi.spyOn(NodeChildProcess, "execFile").mockImplementation((...args) => {
        const done = args.at(-1);
        if (typeof done === "function") done(null, "", "");
        return child as unknown as NodeChildProcess.ChildProcess;
      });
      using signal = vi.spyOn(process, "kill").mockReturnValue(true);
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      yield* makeNodeClient(ChildProcess.make("fixture", [], { detached: false }), {
        platform,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      child.exitCode = 3;
      child.emit("exit", 3, null);
      yield* Scope.close(scope, Exit.void);
      assert.equal(spawn.mock.calls.length, 1);
      assert.equal(taskkill.mock.calls.length, 0);
      assert.equal(signal.mock.calls.length, 0);
      assert.equal(child.kill.mock.calls.length, 0);
    }).pipe(Effect.scoped),
);
