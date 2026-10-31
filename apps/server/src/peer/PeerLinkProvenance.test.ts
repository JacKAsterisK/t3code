import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import { layerDatabase } from "../agentEvents/AgentEvents.testkit.ts";
import { recoverLegacyFleetPointers } from "./PeerLinkProvenance.ts";
import * as Links from "./PeerLinks.ts";

const dependencies = Layer.mergeAll(layerDatabase, Gate.layer).pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "t3-relay-provenance-" })),
  Layer.provideMerge(NodeServices.layer),
);
const insert = Effect.fn("fixture.pointer")(function* (
  environmentId: string,
  provenance: string,
  machineId: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO peer_environment_links(environment_id, secret_name, label, urls_json, access, linked_at, expires_at, provenance, fleet_machine_id) VALUES (${environmentId}, ${`secret-${environmentId}`}, 'Peer', '[]', 'read-only', '1970-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z', ${provenance}, ${machineId})`;
});

it.effect(
  "legacy recovery binds only recorded automatic pointer dates, while missing/corrupt state never infers manual trust",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* Config.ServerConfig;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      const stateFile = path.join(config.stateDir, "lan-fleet-peer-links.json");
      yield* insert("recorded", "unknown");
      yield* insert("unrecorded", "unknown");
      yield* insert("replaced", "unknown");
      yield* insert("manual", "manual");
      yield* fs.writeFileString(
        stateFile,
        JSON.stringify({
          version: 1,
          serving: {},
          linking: {
            machine: {
              environmentId: "recorded",
              link: {
                linkedAt: "1970-01-01T00:00:00.000Z",
                access: "read-only",
                deliveryId: "delivery",
              },
            },
            previous: { environmentId: "replaced", link: { linkedAt: "1969-12-31T00:00:00.000Z" } },
          },
        }),
      );
      yield* recoverLegacyFleetPointers();
      assert.deepEqual(
        yield* sql`SELECT environment_id, provenance, fleet_machine_id FROM peer_environment_links ORDER BY environment_id`,
        [
          { environment_id: "manual", provenance: "manual", fleet_machine_id: null },
          { environment_id: "recorded", provenance: "fleet", fleet_machine_id: "machine" },
          { environment_id: "replaced", provenance: "unknown", fleet_machine_id: null },
          { environment_id: "unrecorded", provenance: "unknown", fleet_machine_id: null },
        ],
      );
      yield* fs.writeFileString(stateFile, "{broken");
      yield* recoverLegacyFleetPointers();
      yield* fs.remove(stateFile);
      yield* recoverLegacyFleetPointers();
      assert.equal(
        (yield* sql<{
          provenance: string;
        }>`SELECT provenance FROM peer_environment_links WHERE environment_id = 'unrecorded'`)[0]
          ?.provenance,
        "unknown",
      );
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "fleet cleanup preserves a manual replacement, pointer deletion waits for admission, and secret I/O runs outside the gate",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let blockRemoval = false;
      const removing = yield* Deferred.make<void>();
      const releaseSecret = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      const releaseGate = yield* Deferred.make<void>();
      const context = yield* Links.layer.pipe(
        Layer.provide(Settings.layerTest({ linkedEnvironmentsEnabled: true })),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Secrets.ServerSecretStore)({
              remove: () =>
                !blockRemoval
                  ? Effect.die("Unexpected cleanup of a replacement pointer")
                  : Deferred.succeed(removing, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSecret)),
                    ),
            }),
            Layer.mock(Environment.ServerEnvironment)({}),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("Unexpected network in pointer test")),
            ),
          ),
        ),
        Layer.build,
      );
      const links = Context.get(context, Links.PeerLinks);
      const gate = Context.get(context, Gate.ApprovalAdmissionGate);
      yield* insert("manual", "manual");
      assert.isFalse(yield* links.unlink(EnvironmentId.make("manual"), { machineId: "machine" }));
      yield* insert("automatic", "fleet", "machine");
      assert.isFalse(
        yield* links.unlink(EnvironmentId.make("automatic"), {
          machineId: "machine",
          linkedAt: "1969-12-31T00:00:00.000Z",
        }),
      );
      blockRemoval = true;
      const holding = yield* gate
        .withGate(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(releaseGate))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const deletion = yield* links
        .unlink(EnvironmentId.make("automatic"), { machineId: "machine" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(
        (yield* sql`SELECT environment_id FROM peer_environment_links WHERE environment_id = 'automatic'`)
          .length,
        1,
      );
      yield* Deferred.succeed(releaseGate, undefined);
      yield* Fiber.join(holding);
      yield* Deferred.await(removing);
      yield* gate.withGate(
        Effect.gen(function* () {
          assert.equal(
            (yield* sql`SELECT environment_id FROM peer_environment_links WHERE environment_id = 'automatic'`)
              .length,
            0,
          );
          assert.equal(
            (yield* sql`SELECT environment_id FROM peer_environment_links WHERE environment_id = 'manual'`)
              .length,
            1,
          );
        }),
      );
      yield* Deferred.succeed(releaseSecret, undefined);
      assert.isTrue(yield* Fiber.join(deletion));
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);
