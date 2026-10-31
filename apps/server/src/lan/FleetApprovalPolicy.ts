// @effect-diagnostics preferSchemaOverJson:off -- SQL retains canonical signed snapshots and their high-watermark.
import { FleetApprovalPolicy as Entry } from "../../../../packages/contracts/src/fleetApprovalPolicy.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PeerAccess from "../auth/ApprovalPeerAccess.ts";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import { ApprovalDelegationError } from "../approvals/ApprovalDelegations.ts";
import * as FleetVault from "./FleetVault.ts";
import * as FleetContext from "./FleetContext.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import { DIRECTORY, digest, sign, verify } from "./FleetApprovalPolicySigning.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";

export class FleetApprovalPolicy extends Context.Service<
  FleetApprovalPolicy,
  {
    readonly refresh: Effect.Effect<void, ApprovalDelegationError>;
    readonly bindLink: (
      ownerSessionId: string,
      linkIdentityId: string,
      callerMachineId: string,
    ) => Effect.Effect<void, ApprovalDelegationError>;
    readonly publish: (
      ownerSessionId: string,
      expectedRevision: number,
      grants: Entry["grants"],
    ) => Effect.Effect<
      { readonly revision: number; readonly digest: string; readonly distributed: boolean },
      ApprovalDelegationError
    >;
  }
>()("t3/lan/FleetApprovalPolicy") {}
interface Head {
  readonly revision: number;
  readonly digest: string;
  readonly entry_json: string;
  readonly valid: number;
}
const decodeEntry = Schema.decodeEffect(Schema.fromJsonString(Entry));
const isError = Schema.is(ApprovalDelegationError);
const storageError = (cause: unknown) =>
  isError(cause) ? cause : new ApprovalDelegationError({ reason: "storage_unavailable", cause });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* FleetContext.FleetContext;
  const vault = yield* FleetVault.FleetVault;
  const peers = yield* PeerAccess.ApprovalPeerAccess;
  const gate = yield* Gate.ApprovalAdmissionGate;
  const publication = yield* Semaphore.make(1);
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    gate.withGate(sql.withTransaction(effect)).pipe(Effect.mapError(storageError));
  const load = Effect.fn("FleetApprovalPolicy.load")(
    function* () {
      const current = yield* context.load;
      if (current?.config.rosterPath === undefined)
        return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
      const record = yield* vault.read;
      if (
        record === undefined ||
        record.machineId !== current.self.machineId ||
        record.environmentId !== current.self.environmentId ||
        record.signingPrivateKey !== current.config.signingPrivateKey
      )
        return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
      return {
        ...current,
        fleetId: record.fleetId,
        file: path.join(current.deliveryDirectory, DIRECTORY, current.self.machineId + ".json"),
      };
    },
    Effect.mapError(storageError),
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  const owner = Effect.fn("FleetApprovalPolicy.owner")(function* (sessionId: string) {
    const actor = yield* peers.owner(sessionId);
    if (actor === undefined)
      return yield* new ApprovalDelegationError({ reason: "not_destination_owner" });
    return actor;
  });
  const bumpLinks = Effect.fn("FleetApprovalPolicy.bumpLinks")(function* (
    fleetId: string,
    destination: string,
  ) {
    yield* sql`UPDATE agent_approval_link_policies SET revision = revision + 1
      WHERE link_identity_id IN (SELECT link_identity_id FROM agent_approval_fleet_links WHERE fleet_id = ${fleetId} AND destination_machine_id = ${destination})`;
  });
  const invalidate = Effect.fn("FleetApprovalPolicy.invalidate")(function* () {
    yield* sql`DELETE FROM agent_approval_fleet_policy_publications`;
    yield* sql`UPDATE agent_approval_link_policies SET revision = revision + 1 WHERE link_identity_id IN (SELECT f.link_identity_id FROM agent_approval_fleet_links f JOIN agent_approval_fleet_policy_heads h ON h.fleet_id = f.fleet_id AND h.destination_machine_id = f.destination_machine_id WHERE h.valid = 1)`;
    yield* sql`UPDATE agent_approval_fleet_policy_heads SET valid = 0`;
  });
  const readHead = Effect.fn("FleetApprovalPolicy.readHead")(function* (
    fleetId: string,
    destination: string,
  ) {
    return (yield* sql<Head>`SELECT * FROM agent_approval_fleet_policy_heads WHERE fleet_id = ${fleetId} AND destination_machine_id = ${destination}`)[0];
  });
  const save = Effect.fn("FleetApprovalPolicy.save")(function* (entry: Entry) {
    yield* sql`DELETE FROM agent_approval_fleet_policy_publications WHERE fleet_id = ${entry.fleetId} AND destination_machine_id = ${entry.destinationMachineId}`;
    yield* sql`UPDATE agent_approval_link_policies SET revision = revision + 1
      WHERE link_identity_id IN (
        SELECT f.link_identity_id FROM agent_approval_fleet_links f
        LEFT JOIN agent_approval_fleet_policy_heads h USING(fleet_id, destination_machine_id)
        LEFT JOIN agent_approval_fleet_policy_grants g USING(fleet_id, destination_machine_id, caller_machine_id)
        WHERE f.fleet_id = ${entry.fleetId} AND f.destination_machine_id = ${entry.destinationMachineId}
        AND (CASE WHEN h.valid = 1 AND g.enabled = 1 THEN 1 ELSE 0 END) <>
          COALESCE((SELECT json_extract(value, '$.enabled') FROM json_each(${JSON.stringify(entry.grants)})
            WHERE json_extract(value, '$.callerMachineId') = f.caller_machine_id), 0))`;
    yield* sql`INSERT INTO agent_approval_fleet_policy_heads VALUES (${entry.fleetId}, ${entry.destinationMachineId}, ${entry.revision}, ${digest(entry)}, ${JSON.stringify(entry)}, 1)
      ON CONFLICT(fleet_id, destination_machine_id) DO UPDATE SET revision = excluded.revision, digest = excluded.digest, entry_json = excluded.entry_json, valid = 1`;
    yield* sql`DELETE FROM agent_approval_fleet_policy_grants WHERE fleet_id = ${entry.fleetId} AND destination_machine_id = ${entry.destinationMachineId}`;
    for (const grant of entry.grants)
      yield* sql`INSERT INTO agent_approval_fleet_policy_grants VALUES (${entry.fleetId}, ${entry.destinationMachineId}, ${grant.callerMachineId}, ${grant.enabled ? 1 : 0})`;
  });
  const finishPublication = Effect.fn("FleetApprovalPolicy.finishPublication")(function* (
    entry: Entry,
  ) {
    yield* sql`DELETE FROM agent_approval_fleet_policy_publications
      WHERE fleet_id = ${entry.fleetId} AND destination_machine_id = ${entry.destinationMachineId}
      AND revision = ${entry.revision} AND digest = ${digest(entry)}`;
  });
  const distribute = Effect.fn("FleetApprovalPolicy.distribute")(function* (
    file: string,
    entry: Entry,
  ) {
    const state = yield* transaction(
      Effect.gen(function* () {
        const current = yield* readHead(entry.fleetId, entry.destinationMachineId);
        if (
          current?.valid !== 1 ||
          current.revision !== entry.revision ||
          current.digest !== digest(entry)
        )
          return "superseded" as const;
        const pending = yield* sql`SELECT revision FROM agent_approval_fleet_policy_publications
        WHERE fleet_id = ${entry.fleetId} AND destination_machine_id = ${entry.destinationMachineId}
        AND revision = ${entry.revision} AND digest = ${digest(entry)}`;
        return pending.length === 0 ? ("distributed" as const) : ("pending" as const);
      }),
    );
    if (state !== "pending") return state === "distributed";
    const distributed = yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(writeFleetJson(file, entry)),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!distributed) return false;
    return yield* transaction(
      Effect.gen(function* () {
        const current = yield* readHead(entry.fleetId, entry.destinationMachineId);
        if (
          current?.valid !== 1 ||
          current.revision !== entry.revision ||
          current.digest !== digest(entry)
        )
          return false;
        yield* finishPublication(entry);
        return true;
      }),
    );
  });
  const rejectHigher = Effect.fn("FleetApprovalPolicy.rejectHigher")(function* (
    entry: Entry,
    old: Head | undefined,
  ) {
    yield* invalidate();
    if (old !== undefined && entry.revision <= old.revision) return;
    yield* sql`INSERT INTO agent_approval_fleet_policy_heads VALUES (${entry.fleetId}, ${entry.destinationMachineId}, ${entry.revision}, ${digest(entry)}, ${JSON.stringify(entry)}, 0)
      ON CONFLICT(fleet_id, destination_machine_id) DO UPDATE SET revision = excluded.revision, digest = excluded.digest, entry_json = excluded.entry_json, valid = 0`;
    yield* bumpLinks(entry.fleetId, entry.destinationMachineId);
  });
  const refresh = Effect.gen(function* () {
    const loaded = yield* load().pipe(Effect.option);
    if (loaded._tag === "None") return yield* transaction(invalidate());
    const current = loaded.value;
    const candidate = yield* readFleetJson(current.file, Entry).pipe(Effect.option);
    const identity = {
      fleetId: current.fleetId,
      destinationMachineId: current.self.machineId,
      publicKey: current.self.signingPublicKey,
    };
    const currentPeers = new Set(current.peers.map((p) => p.peer.machineId));
    const retry = yield* transaction(
      Effect.gen(function* () {
        const old = yield* readHead(current.fleetId, current.self.machineId);
        const pending = (yield* sql<{
          revision: number;
          digest: string;
        }>`SELECT * FROM agent_approval_fleet_policy_publications
          WHERE fleet_id = ${current.fleetId} AND destination_machine_id = ${current.self.machineId}`)[0];
        if (pending !== undefined) {
          const entry =
            old === undefined
              ? undefined
              : yield* decodeEntry(old.entry_json, {
                  onExcessProperty: "error",
                });
          if (
            old?.valid !== 1 ||
            entry === undefined ||
            !verify(entry, identity) ||
            pending.revision !== old.revision ||
            pending.digest !== old.digest ||
            entry.grants.some((g) => g.enabled && !currentPeers.has(g.callerMachineId))
          )
            return yield* invalidate();
          if (candidate._tag === "Some" && verify(candidate.value, identity)) {
            const candidateDigest = digest(candidate.value);
            if (candidate.value.revision === old.revision && candidateDigest === old.digest) {
              yield* finishPublication(entry);
              return;
            }
            if (candidate.value.revision > old.revision)
              return yield* rejectHigher(candidate.value, old);
            if (candidate.value.revision === old.revision) return yield* invalidate();
          }
          // The committed owner publication supersedes older or damaged distribution files.
          return entry;
        }
        if (candidate._tag === "None" || !verify(candidate.value, identity))
          return yield* invalidate();
        const entry = candidate.value;
        if (entry.grants.some((g) => g.enabled && !currentPeers.has(g.callerMachineId)))
          return yield* rejectHigher(entry, old);
        if (
          old !== undefined &&
          (entry.revision < old.revision ||
            (entry.revision === old.revision && digest(entry) !== old.digest))
        )
          return yield* invalidate();
        if (old !== undefined && entry.revision === old.revision) {
          // An invalidated head requires an owner publication; replay cannot undo a conflict.
          return;
        }
        if (
          (old === undefined && (entry.revision !== 1 || entry.previousDigest !== null)) ||
          (old !== undefined &&
            (entry.revision !== old.revision + 1 || entry.previousDigest !== old.digest))
        )
          return yield* rejectHigher(entry, old);
        yield* save(entry);
      }),
    );
    if (retry !== undefined) yield* distribute(current.file, retry);
  }).pipe(
    (effect) => publication.withPermit(effect),
    Effect.mapError(storageError),
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  const bindLink = Effect.fn("FleetApprovalPolicy.bindLink")(function* (
    ownerSessionId: string,
    linkIdentityId: string,
    callerMachineId: string,
  ) {
    const current = yield* load();
    const caller = current.peers.find((p) => p.peer.machineId === callerMachineId)?.peer;
    if (caller === undefined || FleetAccessPolicy.reservedMachineId(callerMachineId))
      return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
    yield* transaction(
      Effect.gen(function* () {
        yield* owner(ownerSessionId);
        const link =
          yield* sql`SELECT link_identity_id FROM agent_approval_destination_links WHERE link_identity_id = ${linkIdentityId} AND source_environment_id = ${caller.environmentId} AND revoked_at IS NULL`;
        const existing =
          yield* sql`SELECT link_identity_id FROM agent_approval_fleet_links WHERE link_identity_id = ${linkIdentityId}`;
        if (link.length !== 1 || existing.length !== 0)
          return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
        yield* sql`INSERT INTO agent_approval_fleet_links VALUES (${linkIdentityId}, ${current.fleetId}, ${current.self.machineId}, ${callerMachineId})`;
        yield* sql`UPDATE agent_approval_link_policies SET revision = revision + 1 WHERE link_identity_id = ${linkIdentityId}`;
      }),
    );
  });
  const publish = Effect.fn("FleetApprovalPolicy.publish")(
    function* (ownerSessionId: string, expectedRevision: number, grants: Entry["grants"]) {
      const current = yield* load();
      const entry = yield* transaction(
        Effect.gen(function* () {
          yield* owner(ownerSessionId);
          const old = yield* readHead(current.fleetId, current.self.machineId);
          if ((old?.revision ?? 0) !== expectedRevision)
            return yield* new ApprovalDelegationError({ reason: "authority_changed" });
          const next = sign(
            {
              version: 1,
              fleetId: current.fleetId,
              destinationMachineId: current.self.machineId,
              revision: expectedRevision + 1,
              previousDigest: old?.digest ?? null,
              createdAt: yield* Clock.currentTimeMillis,
              grants,
            },
            current.config.signingPrivateKey,
          );
          if (
            !verify(next, {
              fleetId: current.fleetId,
              destinationMachineId: current.self.machineId,
              publicKey: current.self.signingPublicKey,
            }) ||
            next.grants.some(
              (g) =>
                g.enabled && !current.peers.some((p) => p.peer.machineId === g.callerMachineId),
            )
          )
            return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
          yield* save(next);
          yield* sql`INSERT INTO agent_approval_fleet_policy_publications
            (fleet_id, destination_machine_id, revision, digest, created_at)
            VALUES (${next.fleetId}, ${next.destinationMachineId}, ${next.revision}, ${digest(next)}, ${next.createdAt})`;
          return next;
        }),
      );
      const distributed = yield* publication.withPermit(distribute(current.file, entry));
      return { revision: entry.revision, digest: digest(entry), distributed };
    },
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  yield* refresh;
  return FleetApprovalPolicy.of({ refresh, bindLink, publish });
});
export const layer = Layer.effect(FleetApprovalPolicy, make);

export const layerRefresh = Layer.effectDiscard(
  Effect.gen(function* () {
    const policy = yield* FleetApprovalPolicy;
    const access = yield* FleetAccessPolicy.FleetAccess;
    const refresh = policy.refresh.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Fleet approval policy refresh failed.", { cause }),
      ),
    );
    yield* Effect.forkScoped(refresh.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(10)))));
    yield* Effect.forkScoped(Stream.runForEach(access.changes, () => refresh));
  }),
);
