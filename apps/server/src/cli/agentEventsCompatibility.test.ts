// @effect-diagnostics nodeBuiltinImport:off -- The maintenance CLI runs against disposable files; crash children open only that database.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NetService from "@t3tools/shared/Net";
import { EnvironmentId, EventId, ThreadId, type LanTaskObserveResult } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as Gateway from "../lan/GatewayCompatibility.ts";
import * as Retention from "../agentEvents/AgentFactRetention.ts";
import { agentEventsCommand } from "./agentEvents.ts";

const parse = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const run = (baseDir: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Command.runWith(agentEventsCommand, { version: "0.0.0" })([
      "compatibility",
      ...args,
      "--base-dir",
      baseDir,
      "--json",
    ]);
    const line = (yield* TestConsole.logLines).at(-1);
    return parse(String(line));
  });
const withDatabase = <A, E, R>(
  filename: string,
  operation: Effect.Effect<A, E, R | SqlClient.SqlClient | Gateway.GatewayCompatibility>,
) =>
  operation.pipe(
    Effect.provide(
      Gateway.layer.pipe(
        Layer.provideMerge(
          NodeSqliteClient.layer({ filename, readerWorker: false, checkpointWorker: false }),
        ),
      ),
    ),
  );
const target = {
  principal: "principal",
  environmentId: EnvironmentId.make("disposable"),
  threadId: ThreadId.make("thread"),
};
const sourceId = EventId.make("source");
const page: LanTaskObserveResult = {
  threadId: target.threadId,
  sourceId,
  status: "ok",
  resetReason: null,
  events: [
    {
      eventId: EventId.make("running"),
      sequence: 1,
      kind: "run_state",
      status: "running",
      runId: null,
      requestId: null,
    },
  ],
  nextCursor: { sourceId, sequence: 1 },
  headSequence: 1,
  hasMore: false,
  taskWorkState: "working",
  taskResultRunId: null,
  taskResultStatus: null,
};

it.effect(
  "executes guarded maintenance CLI across file restarts, interrupted cutover and rollback plus legacy ACK",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-compat-cli-"))),
        (value) => Effect.sync(() => NodeFS.rmSync(value, { recursive: true, force: true })),
      );
      const filename = NodePath.join(directory, "userdata", "statev2.sqlite");
      const unselected = yield* Command.runWith(agentEventsCommand, { version: "0.0.0" })([
        "compatibility",
        "status",
        "--json",
      ]).pipe(Effect.flip);
      assert.include(unselected.message, "explicit --base-dir");
      const initial = yield* run(directory, ["status"]);
      assert.equal((initial.state as { mode: string }).mode, "legacy");
      const shadow = yield* run(directory, [
        "start-shadow",
        "--expected-mode",
        "legacy",
        "--expected-generation",
        "0",
      ]);
      assert.deepEqual(shadow, { mode: "shadow", generation: 1 });
      // A stale operator command is rejected by the actual parser/handler/service path.
      assert.isTrue(
        (yield* Effect.exit(
          run(directory, [
            "start-shadow",
            "--expected-mode",
            "legacy",
            "--expected-generation",
            "0",
          ]),
        ))._tag === "Failure",
      );
      yield* withDatabase(
        filename,
        Effect.gen(function* () {
          const gateway = yield* Gateway.GatewayCompatibility;
          yield* gateway.observe(target, page, { expectedDeliverySourceId: null });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE retained_cli_blob (id INTEGER PRIMARY KEY, bytes BLOB, secret_ref TEXT)`;
          yield* sql`INSERT INTO retained_cli_blob VALUES (1,X'00FF0180','opaque:secret-ref')`;
        }),
      );
      const status = yield* run(directory, ["status"]);
      const shadowDigest = (status.state as { shadow_digest: string }).shadow_digest;
      const receipt = yield* run(directory, [
        "backup",
        "--expected-mode",
        "shadow",
        "--expected-generation",
        "1",
        "--shadow-digest",
        shadowDigest,
        "--destination",
        NodePath.join(directory, "backup.sqlite"),
      ]);
      const cutover = [
        "cutover",
        "--expected-mode",
        "shadow",
        "--expected-generation",
        "1",
        "--shadow-digest",
        shadowDigest,
        "--backup-id",
        String(receipt.backupId),
        "--manifest-digest",
        String(receipt.manifestDigest),
      ];
      assert.isTrue(
        (yield* Effect.exit(run(directory, [...cutover.slice(0, -1), "wrong-digest"])))._tag ===
          "Failure",
      );
      const crashed = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "-e",
          "const db=new(require('node:sqlite').DatabaseSync)(process.argv[1]);db.exec(\"BEGIN IMMEDIATE; UPDATE agent_gateway_compatibility_state SET mode='adapter',generation=2 WHERE id=1\");process.exit(73)",
          filename,
        ],
        { windowsHide: true, stdio: "pipe" },
      );
      assert.equal(crashed.status, 73);
      const afterCrash = yield* run(directory, ["status"]);
      assert.equal((afterCrash.state as { mode: string }).mode, "shadow");
      assert.deepEqual(yield* run(directory, cutover), { mode: "adapter", generation: 2 });
      yield* withDatabase(
        filename,
        Effect.gen(function* () {
          const gateway = yield* Gateway.GatewayCompatibility;
          const post = {
            ...page,
            events: [{ ...page.events[0]!, eventId: EventId.make("post-cutover"), sequence: 2 }],
            headSequence: 2,
            nextCursor: { sourceId, sequence: 2 },
          };
          yield* gateway.observe(target, post, { expectedDeliverySourceId: sourceId });
          yield* gateway.acknowledge(target, [page.events[0]!.eventId], sourceId);
        }),
      );
      assert.deepEqual(
        yield* run(directory, [
          "rollback",
          "--expected-mode",
          "adapter",
          "--expected-generation",
          "2",
        ]),
        { mode: "legacy", generation: 3 },
      );
      yield* withDatabase(
        filename,
        Effect.gen(function* () {
          const gateway = yield* Gateway.GatewayCompatibility;
          assert.deepEqual(
            (yield* gateway.pending(target)).map((event) => event.eventId),
            ["post-cutover"],
          );
          const sql = yield* SqlClient.SqlClient;
          const before =
            yield* sql`SELECT event_id,event_json,acknowledged FROM agent_gateway_compatibility_inbox ORDER BY sequence`;
          assert.ok(before.every((row) => typeof row.event_json === "string"));
          yield* gateway.acknowledge(target, ["post-cutover"], sourceId);
          yield* Retention.pruneLog(30 * 86_400_000);
          assert.deepEqual(yield* gateway.pending(target), []);
          assert.deepEqual(
            (yield* sql<{
              acknowledged: number;
            }>`SELECT acknowledged FROM agent_gateway_compatibility_inbox ORDER BY sequence`).map(
              (row) => row.acknowledged,
            ),
            [1, 1],
          );
          assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
          const blob = (yield* sql<{
            bytes: Uint8Array;
            secret_ref: string;
          }>`SELECT bytes,secret_ref FROM retained_cli_blob`)[0]!;
          assert.deepEqual(Array.from(blob.bytes), [0, 255, 1, 128]);
          assert.equal(blob.secret_ref, "opaque:secret-ref");
        }),
      );
      process.stdout.write(
        JSON.stringify({
          proof: "gateway_compatibility",
          scenario: "actual_cli_restart_crash_rollback",
          expectedGuards: true,
          validatedDigest: true,
          crashExitCode: 73,
          legacyAckMerged: true,
          liveRollout: false,
        }) + "\n",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NetService.layer,
          TestConsole.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
    ),
);
