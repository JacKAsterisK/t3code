import { assert, it } from "@effect/vitest";
import { ApprovalGuard, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Settings from "../serverSettings.ts";
import * as Delegations from "./ApprovalDelegations.ts";
import * as Destination from "./ApprovalDestinationGuard.ts";
const decodeGuard = Schema.decodeEffect(Schema.fromJsonString(ApprovalGuard));
const encodeGuard = Schema.encodeEffect(Schema.fromJsonString(ApprovalGuard));

it.effect(
  "serialized destination guards reauthenticate the peer and do not regain revoked authority",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const { withGate } = yield* Gate.ApprovalAdmissionGate;
      const live = yield* Ref.make<Delegations.LiveApprovalPeer | undefined>(undefined);
      const port = Delegations.ApprovalDestinationAccess.of({
        withGate,
        peer: (id) => Ref.get(live).pipe(Effect.map((peer) => (id === "peer" ? peer : undefined))),
        policy: () => Effect.succeed({ enabled: true, revision: 1 }),
        owner: (id) => Effect.succeed(id === "owner" ? { subject: "local-owner" } : undefined),
      });
      const services = yield* Layer.build(
        Destination.layer.pipe(
          Layer.provideMerge(Delegations.layer),
          Layer.provideMerge(Layer.succeed(Delegations.ApprovalDestinationAccess, port)),
        ),
      );
      const delegations = Context.get(services, Delegations.ApprovalDelegations);
      const destination = Context.get(services, Destination.ApprovalDestinationGuard);
      const settings = yield* Settings.ServerSettingsService;
      const linkIdentityId = yield* delegations.createLink("owner", "source-a");
      yield* Ref.set(live, {
        linkIdentityId,
        sourceEnvironmentId: "source-a",
        credentialRevision: 1,
        expiresAt: 100000,
        access: "full-access",
        scopes: ["orchestration:read", "orchestration:operate", "orchestration:approve"],
        runtimeModeCeiling: "full-access",
        interactionModeCeiling: "default",
      });
      const threadId = ThreadId.make("operator-thread");
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider,
      runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, 'project', 'Gavin', 'codex', 'full-access', 'default', 'now', 'now', '{}')`;
      const grant = yield* delegations.grant("owner", {
        threadId,
        linkIdentityId,
        initiatingClientId: "client-a",
      });
      const peer = yield* delegations.authenticate("client-a").pipe(
        Effect.provideService(Invocation.McpInvocationContext, {
          environmentId: EnvironmentId.make("destination-b"),
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
          requestNamespace: "trusted",
          thread: undefined,
          linkedEnvironments: true,
          client: {
            sessionId: "peer",
            label: "immediate-source-a",
            access: "full-access",
            linked: true,
          },
        }),
      );
      const guard: ApprovalGuard = {
        receiptId: "receiver",
        principalId: "link-client",
        sessionId: "peer",
        environmentId: EnvironmentId.make("destination-b"),
        authorityRevision: 1,
        expected: {
          requestIncarnation: "incarnation",
          providerSessionId: "native",
          providerGeneration: "generation",
          presentationRevision: 1,
          presentationDigest: "digest",
        },
        grantDigest: "grant",
        consent: {
          effectiveScope: "turn",
          grantDigest: "grant",
          onBehalfOf: "Dan",
          authorization: "Permit these permissions for this turn.",
        },
        actor: {
          kind: "mcp_client",
          principalId: "link-client",
          label: "asserted client via source-a",
        },
        runtimeModeCeiling: "full-access",
        interactionModeCeiling: "default",
        destination: {
          authority: yield* delegations.check(peer, threadId),
          forwarderReceiptId: "forwarder",
          forwardingKey: "approval-key",
          operationDigest: "operation-digest",
        },
      };
      const restored = yield* decodeGuard(yield* encodeGuard(guard));
      assert.deepEqual(yield* destination.check(restored, threadId), {
        revision: 1,
        runtimeModeCeiling: "full-access",
      });
      yield* sql`ALTER TABLE agent_thread_approval_origins RENAME TO fixture_unavailable_origins`;
      const unavailable = yield* destination
        .check(restored, threadId)
        .pipe(
          Effect.flip,
          Effect.ensuring(
            sql`ALTER TABLE fixture_unavailable_origins RENAME TO agent_thread_approval_origins`.pipe(
              Effect.orDie,
            ),
          ),
        );
      assert.equal(unavailable.reason, "storage_unavailable");
      assert.deepEqual(yield* destination.check(restored, threadId), {
        revision: 1,
        runtimeModeCeiling: "full-access",
      });
      yield* settings.updateSettings({ linkedEnvironmentsEnabled: false });
      yield* destination.check(restored, threadId).pipe(Effect.flip);
      yield* settings.updateSettings({ linkedEnvironmentsEnabled: true });
      yield* Ref.update(live, (peer) =>
        peer === undefined ? undefined : { ...peer, credentialRevision: 2 },
      );
      yield* destination.check(restored, threadId).pipe(Effect.flip);
      yield* Ref.update(live, (peer) =>
        peer === undefined ? undefined : { ...peer, credentialRevision: 1 },
      );
      yield* delegations.revoke("owner", grant.delegation_id);
      yield* delegations.grant("owner", {
        threadId,
        linkIdentityId,
        initiatingClientId: "client-a",
      });
      yield* destination.check(restored, threadId).pipe(Effect.flip);
      yield* Ref.set(live, undefined);
      yield* destination.check(restored, threadId).pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeSqliteClient.layer({ filename: ":memory:" }),
          Gate.layer,
          Settings.layerTest({ linkedEnvironmentsEnabled: true }),
          NodeServices.layer,
        ),
      ),
      Effect.scoped,
    ),
);
