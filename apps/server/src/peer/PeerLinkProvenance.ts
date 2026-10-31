import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as Config from "../config.ts";
import { readFleetJson } from "../lan/FleetFiles.ts";

const open = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);
const LegacyState = open({
  version: Schema.Literal(1),
  linking: Schema.Record(
    Schema.String,
    open({
      environmentId: Schema.String,
      link: Schema.optionalKey(open({ linkedAt: Schema.String })),
    }),
  ),
});

/** Only recover positively recorded fleet pointers; absence never proves a manual link. */
export const recoverLegacyFleetPointers = Effect.fn(
  "PeerLinkProvenance.recoverLegacyFleetPointers",
)(function* () {
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  const config = yield* Effect.serviceOption(Config.ServerConfig);
  if (Option.isNone(fs) || Option.isNone(path) || Option.isNone(config)) return;
  const saved = yield* readFleetJson(
    path.value.join(config.value.stateDir, "lan-fleet-peer-links.json"),
    LegacyState,
  ).pipe(Effect.provideService(FileSystem.FileSystem, fs.value), Effect.option);
  if (Option.isNone(saved)) return;
  const sql = yield* SqlClient.SqlClient;
  const gate = yield* Gate.ApprovalAdmissionGate;
  yield* gate.withGate(
    sql.withTransaction(
      Effect.gen(function* () {
        const pointers = yield* sql<{
          environment_id: string;
          secret_name: string;
          linked_at: string;
        }>`SELECT environment_id, secret_name, linked_at FROM peer_environment_links WHERE provenance = 'unknown'`;
        for (const pointer of pointers) {
          const recorded = Object.entries(saved.value.linking).find(
            ([, entry]) =>
              entry.environmentId === pointer.environment_id &&
              entry.link?.linkedAt === pointer.linked_at,
          );
          if (recorded === undefined) continue;
          yield* sql`UPDATE peer_environment_links SET provenance = 'fleet', fleet_machine_id = ${recorded[0]}
        WHERE environment_id = ${pointer.environment_id} AND secret_name = ${pointer.secret_name}
        AND linked_at = ${pointer.linked_at} AND provenance = 'unknown'`;
        }
      }),
    ),
  );
});
